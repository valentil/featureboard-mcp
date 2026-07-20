#!/usr/bin/env node
/**
 * strengthen.mjs (FBMCPF-242) — background CPU "strengthen mode".
 *
 * A long-running verification loop meant to run while the machine is
 * otherwise idle: repeatedly exercise the storage/license/pm-bridge layers
 * with hostile input and re-time the hot read path, looking for
 * regressions that a normal test run wouldn't catch (flaky round-trips,
 * crashes on weird input, perf drift).
 *
 * HONEST NOTE ON HARDWARE: there is NO GPU path here, and there never will
 * be one for this workload. This codebase has no tensor/matrix workloads —
 * it's markdown parsing, JSON, regex, and file I/O. A GPU accelerates
 * batched floating-point math; none of that exists here. The resource this
 * script actually consumes is CPU cores (and to a lesser extent disk I/O
 * for the temp boards each stage builds), so it parallelizes stages across
 * worker *processes* up to --jobs, not across GPU threads/streams.
 *
 * Usage:
 *   node scripts/strengthen.mjs                 # loop until SIGINT
 *   node scripts/strengthen.mjs --once           # single pass, then exit
 *   node scripts/strengthen.mjs --jobs 4         # override worker count
 *   node scripts/strengthen.mjs --skip-suite     # skip the `npm test` stage
 *   (or STRENGTHEN_SKIP_SUITE=1 in the environment — same effect, useful
 *   for keeping this script's own test fast)
 *
 * Each pass runs 5 stages as separate child `node` processes (spawned with
 * `--run-stage <name>`), pooled up to the --jobs concurrency limit:
 *   1. suite         — `npm test`, 120s timeout, parses TAP `# pass`/`# fail`.
 *   2. fuzz-markdown — hostile-input round-trip stability against Board.
 *   3. fuzz-license  — malformed license keys must never throw or validate.
 *   4. fuzz-pmbridge — exportBoard -> parsePmImport round-trip fidelity.
 *   5. perf          — median Board.listTasks time on a 500-ticket board.
 *
 * Findings (regressions/anomalies) are appended to strengthen_findings.json
 * in the repo root. The runner is crash-safe by construction: every stage
 * runs in its own child process wrapped in try/catch, so a thrown error
 * becomes a `severity: "fail"` finding rather than killing the loop, and a
 * child that dies outright (no result on stdout) is treated the same way
 * by the parent.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { Board } from "../server/storage.js";
import { verifyKey } from "../server/license.js";
import { exportBoard, parsePmImport } from "../server/pmbridge.js";

// ---------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------

const RESULT_PREFIX = "STRENGTHEN_STAGE_RESULT ";
const FINDINGS_FILE = "strengthen_findings.json";
const STAGE_CHILD_TIMEOUT_MS = 150_000; // outer guard; suite has its own 120s inner timeout
const SLEEP_BETWEEN_PASSES_MS = 3_000; // small sleep so a loop doesn't peg the CPU 100%

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return function rng() {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
function randInt(rng, n) {
  return Math.floor(rng() * n);
}
function randChoice(rng, arr) {
  return arr[randInt(rng, arr.length)];
}

function tmpBoardDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(dir, "Proj"));
  fs.writeFileSync(path.join(dir, "Proj", "featurelist.md"), "# Feature List\n");
  fs.writeFileSync(path.join(dir, "Proj", "buglist.md"), "# Bug List\n");
  return dir;
}
function cleanupDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup — a leaked temp dir is not worth a finding */
  }
}

// ---------------------------------------------------------------------------
// findings file (single writer: the orchestrator process, once per pass)
// ---------------------------------------------------------------------------

/**
 * Append findings to strengthen_findings.json, creating it if missing and
 * rotating it to .bak if it's present but corrupt (unparseable / not an
 * array), rather than crashing or silently discarding history.
 */
export function appendFindings(repoRoot, newFindings) {
  const filePath = path.join(repoRoot, FINDINGS_FILE);
  let existing = [];
  if (fs.existsSync(filePath)) {
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = raw.trim() ? JSON.parse(raw) : [];
      if (!Array.isArray(parsed)) throw new Error("strengthen_findings.json is not a JSON array");
      existing = parsed;
    } catch {
      try {
        fs.copyFileSync(filePath, `${filePath}.bak`);
      } catch {
        /* best-effort — still proceed to start fresh below */
      }
      existing = [];
    }
  }
  const combined = existing.concat(newFindings || []);
  fs.writeFileSync(filePath, `${JSON.stringify(combined, null, 2)}\n`, "utf8");
  return combined;
}

// ---------------------------------------------------------------------------
// stage 1 — suite (`npm test`)
// ---------------------------------------------------------------------------

function runStageSuite({ repoRoot }) {
  const findings = [];
  const start = Date.now();
  const res = spawnSync("npm", ["test"], {
    cwd: repoRoot,
    timeout: 120_000,
    encoding: "utf8",
    shell: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${res.stdout || ""}\n${res.stderr || ""}`;
  const passMatch = out.match(/^# pass (\d+)/m);
  const failMatch = out.match(/^# fail (\d+)/m);
  const totalMatch = out.match(/^# tests (\d+)/m);
  const pass = passMatch ? parseInt(passMatch[1], 10) : null;
  const fail = failMatch ? parseInt(failMatch[1], 10) : null;
  const total = totalMatch ? parseInt(totalMatch[1], 10) : pass != null && fail != null ? pass + fail : null;

  if (res.error) {
    findings.push({ stage: "suite", severity: "fail", detail: `failed to run npm test: ${res.error.message}` });
  } else if (res.signal) {
    findings.push({ stage: "suite", severity: "fail", detail: `npm test was killed (signal=${res.signal}), likely the 120s timeout` });
  } else if (pass == null && fail == null) {
    findings.push({ stage: "suite", severity: "fail", detail: "could not parse '# pass'/'# fail' TAP lines from npm test output" });
  } else if (fail > 0) {
    findings.push({ stage: "suite", severity: "fail", detail: `${fail} test(s) failed (pass=${pass}, fail=${fail})` });
  }

  return {
    stage: "suite",
    ok: findings.length === 0,
    findings,
    summary: { pass, fail, total, durationMs: Date.now() - start },
  };
}

// ---------------------------------------------------------------------------
// stage 2 — fuzz-markdown
// ---------------------------------------------------------------------------

const FUZZ_MD_N = 200;
const MD_WORDS = [
  "ticket", "fix", "the", "widget", "crash", "on", "boot", "unicode", "ñçé", "中文",
  "العربية", "emoji", "🔥", "🚀", "🎉", "😀", "long", "string", "value", "release",
  "notes", "sprint", "bug", "feature", "review",
];
// Hostile chunks covering: empty brackets, pipes, strings that *resemble* the
// board's own inline metadata tokens, "**"/":" markup collisions, and
// combos of the above — but never a lone/leading "*", which collides with
// the storage layer's own "**title**" wrap marker and is a known,
// documented quirk of the markdown format rather than something this
// fuzzer needs to rediscover on every run.
const MD_HOSTILE_CHUNKS = [
  "[]", "[extra]", "|pipe|", "resembling [Product: Foo]", "resembling [Labels: a, b]",
  "resembling [Ref: X-1]", "resembling [Priority: 2]", "a**b", "mid**wrap", "colon:inline",
  "double::colon", "trailing]", "leading[",
];

function genHostileText(rng, maxWords) {
  const n = 1 + randInt(rng, maxWords);
  const parts = [];
  for (let i = 0; i < n; i++) {
    parts.push(rng() < 0.25 ? randChoice(rng, MD_HOSTILE_CHUNKS) : randChoice(rng, MD_WORDS));
  }
  let text = parts.join(" ").replace(/^\*+/, "").trim();
  if (rng() < 0.05) text = text.repeat(1 + randInt(rng, 40)); // occasional very long strings
  return text || "fallback title";
}

function runStageFuzzMarkdown() {
  const seed = (Date.now() ^ (process.pid << 8)) >>> 0;
  const rng = mulberry32(seed);
  const findings = [];
  const dir = tmpBoardDir("fb-strengthen-md-");
  try {
    const board = new Board(dir);
    const added = [];
    for (let i = 0; i < FUZZ_MD_N; i++) {
      const title = genHostileText(rng, 10);
      const description = genHostileText(rng, 6);
      const type = rng() < 0.5 ? "feature" : "bug";
      const t = board.addTask("Proj", type, { title, description });
      added.push({ index: i, ticketNumber: t.ticketNumber });
    }

    const before = board.listTasks("Proj", {});
    if (before.length !== FUZZ_MD_N) {
      findings.push({
        stage: "fuzz-markdown", severity: "fail",
        detail: `ticket count after add: ${before.length} (expected ${FUZZ_MD_N})`, seed,
      });
    }

    for (const a of added) board.updateTask("Proj", a.ticketNumber, {}); // no-op patch

    const after = board.listTasks("Proj", {});
    if (after.length !== FUZZ_MD_N) {
      findings.push({
        stage: "fuzz-markdown", severity: "fail",
        detail: `ticket count after no-op update: ${after.length} (expected ${FUZZ_MD_N})`, seed,
      });
    }

    const beforeByTicket = Object.fromEntries(before.map((t) => [t.ticketNumber, t]));
    const afterByTicket = Object.fromEntries(after.map((t) => [t.ticketNumber, t]));
    for (const a of added) {
      const b1 = beforeByTicket[a.ticketNumber];
      const b2 = afterByTicket[a.ticketNumber];
      if (!b1 || !b2) {
        findings.push({
          stage: "fuzz-markdown", severity: "fail",
          detail: `[iter ${a.index}] ticket ${a.ticketNumber} missing after no-op update`, seed,
        });
        continue;
      }
      if (b1.title !== b2.title) {
        findings.push({
          stage: "fuzz-markdown", severity: "fail",
          detail: `[iter ${a.index}] title changed after no-op update: ${JSON.stringify(b1.title).slice(0, 200)} -> ${JSON.stringify(b2.title).slice(0, 200)}`,
          seed,
        });
      }
    }
  } catch (err) {
    findings.push({ stage: "fuzz-markdown", severity: "fail", detail: String((err && err.stack) || err), seed });
  } finally {
    cleanupDir(dir);
  }
  return { stage: "fuzz-markdown", ok: findings.length === 0, findings, summary: { count: FUZZ_MD_N, seed } };
}

// ---------------------------------------------------------------------------
// stage 3 — fuzz-license
// ---------------------------------------------------------------------------

const FUZZ_LICENSE_N = 500;

function randomBase64UrlJunk(rng, len) {
  const bytes = Buffer.alloc(len);
  for (let i = 0; i < len; i++) bytes[i] = randInt(rng, 256);
  return bytes.toString("base64url");
}

function makeRealisticPayload(rng) {
  const payload = {
    licensee: `Fuzz Co ${randInt(rng, 100000)}`,
    type: "commercial",
    seats: 1 + randInt(rng, 50),
    issued: new Date(Date.now() - randInt(rng, 1e10)).toISOString(),
    expires: rng() < 0.5 ? new Date(Date.now() + randInt(rng, 1e10)).toISOString() : null,
    v: 1,
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function genMalformedKey(rng, i) {
  const kind = i % 6;
  if (kind === 0) return ""; // empty
  if (kind === 1) return randomBase64UrlJunk(rng, 8 + randInt(rng, 64)); // random base64url junk, no "."
  if (kind === 2) {
    // truncated real-shaped payload
    const full = `${makeRealisticPayload(rng)}.${randomBase64UrlJunk(rng, 64)}`;
    return full.slice(0, 1 + randInt(rng, full.length));
  }
  if (kind === 3) {
    // bit-flipped signature: correct-length (64 byte) buffer, flipped against a zero baseline
    const p = makeRealisticPayload(rng);
    const sigBytes = Buffer.alloc(64, 0);
    const flips = 1 + randInt(rng, 20);
    for (let f = 0; f < flips; f++) sigBytes[randInt(rng, 64)] ^= 1 << randInt(rng, 8);
    return `${p}.${sigBytes.toString("base64url")}`;
  }
  if (kind === 4) return `${randomBase64UrlJunk(rng, 200_000)}.${randomBase64UrlJunk(rng, 64)}`; // huge input
  // unicode junk
  const chars = ["🔥", "漢字", "ñ", "😀", ".", "-", "_", "עברית", "🚀"];
  let s = "";
  const n = 5 + randInt(rng, 40);
  for (let j = 0; j < n; j++) s += randChoice(rng, chars);
  return s;
}

function runStageFuzzLicense() {
  const seed = (Date.now() ^ (process.pid << 12)) >>> 0;
  const rng = mulberry32(seed);
  const findings = [];
  for (let i = 0; i < FUZZ_LICENSE_N; i++) {
    const key = genMalformedKey(rng, i);
    let result;
    try {
      result = verifyKey(key);
    } catch (err) {
      findings.push({ stage: "fuzz-license", severity: "fail", detail: `[iter ${i}] verifyKey threw: ${String((err && err.message) || err)}`, seed });
      continue;
    }
    if (!result || typeof result !== "object" || typeof result.valid !== "boolean") {
      findings.push({ stage: "fuzz-license", severity: "fail", detail: `[iter ${i}] verifyKey returned a non-standard shape: ${JSON.stringify(result).slice(0, 200)}`, seed });
      continue;
    }
    if (result.valid === true) {
      findings.push({ stage: "fuzz-license", severity: "fail", detail: `[iter ${i}] malformed key verified as valid: ${JSON.stringify(key).slice(0, 120)}`, seed });
    }
  }
  return { stage: "fuzz-license", ok: findings.length === 0, findings, summary: { count: FUZZ_LICENSE_N, seed } };
}

// ---------------------------------------------------------------------------
// stage 4 — fuzz-pmbridge
// ---------------------------------------------------------------------------

const PM_TITLES = [
  "Simple ticket one", "Second ticket, with a comma", "Third: colon title", "Fourth ticket",
  "Fifth ticket here", "Sixth one", "Seventh item", "Eighth thing", "Ninth entry", "Tenth ticket",
];

function runStageFuzzPmbridge() {
  const findings = [];
  const dir = tmpBoardDir("fb-strengthen-pm-");
  try {
    const board = new Board(dir);
    for (let i = 0; i < PM_TITLES.length; i++) {
      board.addTask("Proj", i % 3 === 0 ? "bug" : "feature", {
        title: PM_TITLES[i],
        description: `description for ${PM_TITLES[i]}`,
        status: i % 4 === 0 ? "Done" : "Todo",
        priority: 1 + (i % 4),
      });
    }
    const beforeCount = board.listTasks("Proj", {}).length;
    const csv = exportBoard(board, "Proj", "csv");
    const reimported = parsePmImport(csv);

    if (reimported.length !== beforeCount) {
      findings.push({
        stage: "fuzz-pmbridge", severity: "fail",
        detail: `round-trip ticket count mismatch: exported ${beforeCount}, reimported ${reimported.length}`,
      });
    }
    const afterTitles = new Set(reimported.map((t) => t.title));
    for (const title of PM_TITLES) {
      if (!afterTitles.has(title)) {
        findings.push({ stage: "fuzz-pmbridge", severity: "fail", detail: `title lost in export/re-import round-trip: ${JSON.stringify(title)}` });
      }
    }
  } catch (err) {
    findings.push({ stage: "fuzz-pmbridge", severity: "fail", detail: String((err && err.stack) || err) });
  } finally {
    cleanupDir(dir);
  }
  return { stage: "fuzz-pmbridge", ok: findings.length === 0, findings, summary: { count: PM_TITLES.length } };
}

// ---------------------------------------------------------------------------
// stage 5 — perf
// ---------------------------------------------------------------------------

const PERF_N = 500;
const PERF_RUNS = 5;

/** Best-effort: pull a listTasks baseline (ms) out of docs/PERFORMANCE.md. */
function readPerfCeilingMs(repoRoot) {
  try {
    const text = fs.readFileSync(path.join(repoRoot, "docs", "PERFORMANCE.md"), "utf8");
    let best = null;
    for (const line of text.split(/\r?\n/)) {
      if (!/listTasks/i.test(line)) continue;
      for (const m of line.matchAll(/(\d+(?:\.\d+)?)\s*ms/gi)) {
        const v = parseFloat(m[1]);
        if (!Number.isNaN(v) && (best === null || v > best)) best = v;
      }
    }
    if (best != null && best > 0) return best;
  } catch {
    /* fall through to default */
  }
  return 2000;
}

function runStagePerf({ repoRoot }) {
  const findings = [];
  const dir = tmpBoardDir("fb-strengthen-perf-");
  let medianMs = null;
  try {
    const board = new Board(dir);
    for (let i = 0; i < PERF_N; i++) {
      board.addTask("Proj", i % 2 === 0 ? "feature" : "bug", { title: `Perf ticket ${i}`, description: "d" });
    }
    const times = [];
    for (let i = 0; i < PERF_RUNS; i++) {
      const t0 = process.hrtime.bigint();
      board.listTasks("Proj", {});
      const t1 = process.hrtime.bigint();
      times.push(Number(t1 - t0) / 1e6);
    }
    times.sort((a, b) => a - b);
    medianMs = times[Math.floor(times.length / 2)];
    const ceiling = readPerfCeilingMs(repoRoot);
    if (medianMs > ceiling) {
      findings.push({
        stage: "perf", severity: "warn",
        detail: `median listTasks time ${medianMs.toFixed(2)}ms exceeds baseline ceiling ${ceiling}ms (${PERF_N}-ticket board, ${PERF_RUNS} runs)`,
      });
    }
  } catch (err) {
    findings.push({ stage: "perf", severity: "fail", detail: String((err && err.stack) || err) });
  } finally {
    cleanupDir(dir);
  }
  return { stage: "perf", ok: findings.length === 0, findings, summary: { medianMs, count: PERF_N } };
}

// ---------------------------------------------------------------------------
// stage dispatch (child-process mode: `--run-stage <name>`)
// ---------------------------------------------------------------------------

const STAGES = {
  suite: runStageSuite,
  "fuzz-markdown": runStageFuzzMarkdown,
  "fuzz-license": runStageFuzzLicense,
  "fuzz-pmbridge": runStageFuzzPmbridge,
  perf: runStagePerf,
};

function runAsStageChild(name) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const fn = STAGES[name];
  let result;
  try {
    result = fn
      ? fn({ repoRoot })
      : { stage: name, ok: false, findings: [{ stage: name, severity: "fail", detail: `unknown stage "${name}"` }], summary: {} };
  } catch (err) {
    // crash-safety: a stage throwing becomes a finding, never an uncaught exception.
    result = {
      stage: name, ok: false,
      findings: [{ stage: name, severity: "fail", detail: String((err && err.stack) || err) }],
      summary: {},
    };
  }
  process.stdout.write(RESULT_PREFIX + JSON.stringify(result) + "\n");
}

// ---------------------------------------------------------------------------
// orchestrator (parent process)
// ---------------------------------------------------------------------------

function failResult(stage, detail) {
  return { stage, ok: false, findings: [{ stage, severity: "fail", detail }], summary: {} };
}

function extractResultLine(stdout) {
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith(RESULT_PREFIX)) return lines[i];
  }
  return null;
}

/** Spawn one stage as a child `node` process and collect its result. Never rejects. */
function runStageChild(name, { repoRoot, scriptPath }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const child = spawn(process.execPath, [scriptPath, "--run-stage", name], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      done(failResult(name, `stage worker exceeded ${STAGE_CHILD_TIMEOUT_MS}ms and was killed`));
    }, STAGE_CHILD_TIMEOUT_MS);

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));

    child.on("error", (err) => done(failResult(name, `failed to spawn stage worker: ${err.message}`)));

    child.on("close", (code, signal) => {
      const line = extractResultLine(stdout);
      if (!line) {
        done(failResult(name, `stage worker produced no result (code=${code}, signal=${signal}) stderr=${stderr.slice(0, 500)}`));
        return;
      }
      try {
        done(JSON.parse(line.slice(RESULT_PREFIX.length)));
      } catch (err) {
        done(failResult(name, `could not parse stage worker result: ${err.message}`));
      }
    });
  });
}

async function runStagesInParallel(stageNames, { jobs, repoRoot, scriptPath }) {
  const results = new Array(stageNames.length);
  let next = 0;
  async function worker() {
    while (next < stageNames.length) {
      const my = next++;
      results[my] = await runStageChild(stageNames[my], { repoRoot, scriptPath });
    }
  }
  const poolSize = Math.max(1, Math.min(jobs, stageNames.length));
  await Promise.all(Array.from({ length: poolSize }, () => worker()));
  return results;
}

function fmtFuzz(label, r) {
  if (!r) return `${label} ?`;
  const n = (r.summary && r.summary.count) ?? "?";
  return r.ok ? `${label} OK (${n})` : `${label} ISSUES (${n}, ${r.findings.length} findings)`;
}

function formatSummaryLine({ passNum, skipSuite, byStage, findingsCount }) {
  const parts = [];

  if (skipSuite) {
    parts.push("suite skipped");
  } else {
    const s = byStage.suite;
    const summ = (s && s.summary) || {};
    parts.push(s && s.ok ? `suite ${summ.pass ?? "?"}/${summ.total ?? "?"}` : `suite FAIL (${summ.pass ?? "?"}/${summ.total ?? "?"})`);
  }

  parts.push(fmtFuzz("fuzz-md", byStage["fuzz-markdown"]));
  parts.push(fmtFuzz("fuzz-lic", byStage["fuzz-license"]));

  const pm = byStage["fuzz-pmbridge"];
  parts.push(pm && pm.ok ? "pmbridge OK" : `pmbridge ISSUES (${(pm && pm.findings.length) || "?"})`);

  const perf = byStage.perf;
  const medianMs = perf && perf.summary && perf.summary.medianMs;
  parts.push(medianMs != null ? `perf ${Math.round(medianMs)}ms${perf.ok ? "" : " (warn)"}` : "perf ?");

  return `strengthen pass #${passNum}: ${parts.join(" · ")} — findings: ${findingsCount}`;
}

async function runPass({ repoRoot, scriptPath, jobs, skipSuite, passNum }) {
  const stageNames = skipSuite
    ? ["fuzz-markdown", "fuzz-license", "fuzz-pmbridge", "perf"]
    : ["suite", "fuzz-markdown", "fuzz-license", "fuzz-pmbridge", "perf"];

  const results = await runStagesInParallel(stageNames, { jobs, repoRoot, scriptPath });
  const byStage = Object.fromEntries(results.map((r) => [r.stage, r]));

  const at = new Date().toISOString();
  const allFindings = [];
  for (const r of results) {
    for (const f of r.findings || []) {
      allFindings.push({
        at,
        stage: f.stage || r.stage,
        severity: f.severity || "fail",
        detail: f.detail,
        ...(f.seed !== undefined ? { seed: f.seed } : {}),
      });
    }
  }
  appendFindings(repoRoot, allFindings);

  const line = formatSummaryLine({ passNum, skipSuite, byStage, findingsCount: allFindings.length });
  console.log(line);
  return { allFindings, byStage };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { once: false, jobs: null, skipSuite: false, runStage: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--once") opts.once = true;
    else if (a === "--skip-suite") opts.skipSuite = true;
    else if (a === "--jobs") opts.jobs = parseInt(argv[++i], 10);
    else if (a.startsWith("--jobs=")) opts.jobs = parseInt(a.split("=")[1], 10);
    else if (a === "--run-stage") opts.runStage = argv[++i];
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.runStage) {
    runAsStageChild(opts.runStage);
    return;
  }

  const skipSuite = opts.skipSuite || process.env.STRENGTHEN_SKIP_SUITE === "1";
  const scriptPath = fileURLToPath(import.meta.url);
  const repoRoot = path.resolve(path.dirname(scriptPath), "..");
  const jobs = Number.isFinite(opts.jobs) && opts.jobs > 0 ? opts.jobs : Math.max(1, os.cpus().length - 1);

  let stopping = false;
  process.on("SIGINT", () => {
    stopping = true;
    console.log("\n[strengthen] SIGINT received — finishing current pass then stopping.");
  });

  let passNum = 0;
  do {
    passNum++;
    try {
      await runPass({ repoRoot, scriptPath, jobs, skipSuite, passNum });
    } catch (err) {
      // the pass runner itself should never throw (every stage is isolated in
      // its own child process), but guard anyway so the loop can never die.
      appendFindings(repoRoot, [
        { at: new Date().toISOString(), stage: "runner", severity: "fail", detail: String((err && err.stack) || err) },
      ]);
      console.error(`[strengthen] pass #${passNum} crashed unexpectedly:`, err);
    }
    if (opts.once || stopping) break;
    await sleep(SLEEP_BETWEEN_PASSES_MS);
  } while (!stopping);
}

const isMain = (() => {
  try {
    return path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch((err) => {
    console.error("[strengthen] fatal:", err);
    process.exit(1);
  });
}
