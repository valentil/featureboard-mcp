// Model up/downgrade effectiveness at test time (FBMCPF-148) — the empirical
// arm on top of multi-model test generation (FBMCPF-147, server/testing.js).
//
// FBMCPF-147 fans one generation prompt across model tiers and stores the
// result as test/<ticket>.<model>.test.js + a manifest (test/<ticket>.variants.json).
// This module answers the follow-up question: of those per-tier test files,
// which tier's tests actually catch bugs? It seeds deterministic textual
// mutations ("defects") into a COPY of the target source file — a fresh temp
// directory, never the repo — runs each model's variant test file against
// both the clean baseline and each mutated copy (via `node --test`), and
// reports which tier's tests newly fail (i.e. catch the seeded defect).
//
// Everything that touches disk here is confined to a temp dir created with
// fs.mkdtempSync and removed again before returning; the only place this
// module writes into the repo is appendEvidence(), and only when the caller
// opts in explicitly.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { listVariants } from "./testing.js";
import { getPricing, costOfEvent, DEFAULT_PRICING } from "./pricing.js";

const round4 = (n) => (n == null || isNaN(n) ? null : Math.round(n * 1e4) / 1e4);

// --- TAP parsing --------------------------------------------------------

/**
 * Parse `node --test --test-reporter=tap` output into a flat list of
 * top-level test results. Only reads "ok N - name" / "not ok N - name"
 * lines (each variant file is a flat sequence of test() calls per
 * splitTestFile's block regex in testing.js, so nesting isn't a concern).
 */
export function parseTap(text) {
  const tests = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    const m = /^(ok|not ok)\s+\d+\s*-\s*(.*)$/.exec(line);
    if (!m) continue;
    const name = m[2].replace(/\s+#\s*(SKIP|TODO).*$/i, "").trim();
    tests.push({ name, ok: m[1] === "ok" });
  }
  const pass = tests.filter((t) => t.ok).length;
  return { tests, pass, fail: tests.length - pass };
}

/** Run one node:test file and return its parsed results. Never throws. */
export function runTestFile(filePath, opts = {}) {
  const timeout = opts.timeoutMs || 20000;
  // Strip NODE_TEST_CONTEXT (set by node:test on the CURRENT process when this
  // module itself is invoked under `node --test`, e.g. its own unit tests) so
  // the spawned child runs as a genuinely standalone `node --test` process
  // instead of coordinating back with the outer test run over its private
  // IPC/coverage channel, which would corrupt the TAP output we parse below.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const res = spawnSync(process.execPath, ["--test", "--test-reporter=tap", filePath], {
    encoding: "utf8",
    timeout,
    env,
  });
  const stdout = res.stdout || "";
  const stderr = res.stderr || "";
  if (res.error) {
    return { ok: false, tests: [], pass: 0, fail: 0, crashed: true, error: res.error.message };
  }
  const parsed = parseTap(stdout);
  return { ok: res.status === 0, exitCode: res.status, crashed: false, ...parsed, raw: stdout, stderr };
}

// --- seeded mutations (builtin, deterministic, textual) -----------------

/**
 * Small deterministic set of textual "seeded regression" mutations. Each
 * mutates the FIRST occurrence of its pattern (or the inverse, if the
 * forward pattern isn't present) so the same source always yields the same
 * mutant. Purely textual — no parser dependency — which keeps this safe to
 * run against any JS source; it may occasionally land inside a string or
 * comment, which is an acceptable "miss" (the mutation is then legitimately
 * uncatchable and reported as skipped/no-op if it doesn't change behavior).
 */
export function builtinMutations() {
  return [
    {
      id: "flip-strict-eq",
      description: "Flip the first === to !== (or !== to ===)",
      mutate(src) {
        if (/===/.test(src)) return src.replace(/===/, "!==");
        if (/!==/.test(src)) return src.replace(/!==/, "===");
        return null;
      },
    },
    {
      id: "flip-loose-eq",
      description: "Flip the first == to != (or != to ==), skipping ===/!==",
      mutate(src) {
        const looseEq = /(?<![!=])==(?!=)/;
        const looseNeq = /(?<!!)!=(?!=)/;
        if (looseEq.test(src)) return src.replace(looseEq, "!=");
        if (looseNeq.test(src)) return src.replace(looseNeq, "==");
        return null;
      },
    },
    {
      id: "negate-boolean-literal",
      description: "Flip the first `return true`/`return false`",
      mutate(src) {
        if (/\breturn\s+true\b/.test(src)) return src.replace(/\breturn\s+true\b/, "return false");
        if (/\breturn\s+false\b/.test(src)) return src.replace(/\breturn\s+false\b/, "return true");
        return null;
      },
    },
    {
      id: "off-by-one-const",
      description: "Increment the first standalone numeric literal by 1",
      mutate(src) {
        const m = /(?<![\w.])(\d+)(?![\w.])/.exec(src);
        if (!m) return null;
        const n = String(parseInt(m[1], 10) + 1);
        return src.slice(0, m.index) + n + src.slice(m.index + m[1].length);
      },
    },
    {
      id: "flip-logical-and-or",
      description: "Flip the first && to || (or || to &&)",
      mutate(src) {
        if (/&&/.test(src)) return src.replace(/&&/, "||");
        if (/\|\|/.test(src)) return src.replace(/\|\|/, "&&");
        return null;
      },
    },
    {
      id: "flip-comparison",
      description: "Flip the first < to > (or > to <), skipping <=/>=/shift/generics-ish forms",
      mutate(src) {
        const lt = /(?<![<>=])<(?![<=])/;
        const gt = /(?<![<>=])>(?![>=])/;
        if (lt.test(src)) return src.replace(lt, ">");
        if (gt.test(src)) return src.replace(gt, "<");
        return null;
      },
    },
  ];
}

/** Normalize a caller-supplied patch spec ({id?, description?, find, replace, regex?, flags?}) into a mutate() fn. */
function normalizeMutationSpec(raw, index) {
  const id = (raw && raw.id) || `custom-${index + 1}`;
  const description = (raw && raw.description) || `Replace "${raw && raw.find}" -> "${raw && raw.replace}"`;
  const find = raw && raw.find;
  const replace = raw && raw.replace != null ? raw.replace : "";
  const isRegex = !!(raw && raw.regex);
  const flags = (raw && raw.flags) || "";
  const mutate = (src) => {
    if (find == null) return null;
    if (isRegex) {
      let re;
      try {
        re = new RegExp(find, flags);
      } catch {
        return null;
      }
      if (!re.test(src)) return null;
      return src.replace(re, replace);
    }
    const idx = src.indexOf(find);
    if (idx === -1) return null;
    return src.slice(0, idx) + replace + src.slice(idx + find.length);
  };
  return { id, description, mutate };
}

/** Apply one mutation spec to source text. Pure; returns { applied, content }. */
export function applyMutationToSource(source, spec) {
  const mutated = spec.mutate(String(source ?? ""));
  if (mutated == null || mutated === source) return { applied: false, content: source };
  return { applied: true, content: mutated };
}

// --- variant + workspace plumbing ---------------------------------------

/** Discover test/<ticket>.<model>.test.js files under a project's test dir. */
export function discoverVariantFiles(testDir, ticket) {
  let files = [];
  try {
    files = fs.readdirSync(testDir);
  } catch {
    files = [];
  }
  const { variants } = listVariants(files, ticket);
  return variants.map((v) => ({ model: v.model, file: v.file, path: path.join(testDir, v.file) }));
}

/**
 * Build a scratch copy of dir/server (with one file's content swapped for a
 * mutant) plus the given variant test files, under a fresh mkdtemp dir.
 * Never touches the repo. Caller is responsible for removing the returned
 * tempRoot (see runVariantMatrix's finally block).
 */
function buildMutantWorkspace(dir, targetFile, mutatedContent, variants) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fbmcp-modeleval-"));
  const serverSrc = path.join(dir, "server");
  const serverDst = path.join(tempRoot, "server");
  if (fs.existsSync(serverSrc)) fs.cpSync(serverSrc, serverDst, { recursive: true });
  const targetDst = path.join(tempRoot, targetFile);
  fs.mkdirSync(path.dirname(targetDst), { recursive: true });
  fs.writeFileSync(targetDst, mutatedContent, "utf8");
  const testDst = path.join(tempRoot, "test");
  fs.mkdirSync(testDst, { recursive: true });
  for (const v of variants) fs.copyFileSync(v.path, path.join(testDst, v.file));
  return tempRoot;
}

// --- the matrix -----------------------------------------------------------

/**
 * Run the model up/downgrade eval matrix for one ticket's test variants.
 *
 *   dir      - project root containing server/ and test/ (codeLocation)
 *   ticket   - ticket id whose test/<ticket>.<model>.test.js variants to run
 *   opts:
 *     targetFile    - path (relative to dir) of the source module the
 *                      variants exercise, e.g. "server/pricing.js". Required
 *                      to run seeded mutations; omit to run baseline-only.
 *     mutations     - caller-supplied patch specs [{id?, description?, find,
 *                      replace, regex?, flags?}]; defaults to builtinMutations().
 *     tokensByModel - { sonnet: 12000, opus: 40000, ... } generation token
 *                      counts, for cost-per-caught-defect.
 *     pricing       - pricing table (see pricing.js getPricing); defaults to
 *                      DEFAULT_PRICING.
 *     mode          - "real" | "harness-validation" — required; labels the
 *                      readout honestly (no default, so callers can't drift
 *                      into mislabeling a demo run as real data).
 *
 * Returns a JSON-safe report: baseline results, per-mutation catch data,
 * per-model catch-rate/unique-catch-rate/cost, and an overlap matrix. Writes
 * nothing to the repo — see appendEvidence() for the opt-in evidence write.
 */
export function runVariantMatrix(dir, ticket, opts = {}) {
  if (!dir) throw new Error("a project dir (codeLocation) is required");
  if (!ticket) throw new Error("a ticket id is required");
  if (opts.mode !== "real" && opts.mode !== "harness-validation") {
    throw new Error('mode must be "real" or "harness-validation" (label the readout honestly)');
  }

  const testDir = path.join(dir, "test");
  const variants = discoverVariantFiles(testDir, ticket);
  if (!variants.length) {
    throw new Error(`no variant test files found for ${ticket} in ${testDir} (expected ${ticket}.<model>.test.js)`);
  }
  const models = variants.map((v) => v.model);

  const mutationSpecs = Array.isArray(opts.mutations) && opts.mutations.length
    ? opts.mutations.map(normalizeMutationSpec)
    : builtinMutations();

  const targetFile = opts.targetFile || null;
  const targetSource = targetFile ? fs.readFileSync(path.join(dir, targetFile), "utf8") : null;

  // 1. baseline — run each variant straight from the repo, unmutated.
  const baseline = {};
  for (const v of variants) baseline[v.model] = runTestFile(v.path);

  // 2. seeded mutations — one at a time, each in its own temp workspace.
  const perMutation = [];
  for (const spec of mutationSpecs) {
    if (!targetSource) {
      perMutation.push({ id: spec.id, description: spec.description, applied: false, reason: "no targetFile provided", caughtBy: [], testsCaught: {} });
      continue;
    }
    const { applied, content } = applyMutationToSource(targetSource, spec);
    if (!applied) {
      perMutation.push({ id: spec.id, description: spec.description, applied: false, reason: "pattern not found in target", caughtBy: [], testsCaught: {} });
      continue;
    }
    let tempRoot;
    try {
      tempRoot = buildMutantWorkspace(dir, targetFile, content, variants);
      const caughtBy = [];
      const testsCaught = {};
      for (const v of variants) {
        const res = runTestFile(path.join(tempRoot, "test", v.file));
        const base = baseline[v.model];
        const basePassing = new Set((base.tests || []).filter((t) => t.ok).map((t) => t.name));
        const newlyFailing = (res.tests || []).filter((t) => !t.ok && basePassing.has(t.name)).map((t) => t.name);
        // a crashed mutant run (e.g. syntax now invalid) with a previously-clean
        // baseline also counts as "caught" — the mutation broke something the
        // suite would have run cleanly otherwise.
        const crashCaught = res.crashed && base.tests && base.tests.length && !base.crashed;
        if (newlyFailing.length || crashCaught) {
          caughtBy.push(v.model);
          testsCaught[v.model] = newlyFailing;
        }
      }
      perMutation.push({ id: spec.id, description: spec.description, applied: true, caughtBy, testsCaught });
    } finally {
      if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }

  const applied = perMutation.filter((m) => m.applied);
  const totalMutations = applied.length;

  // 3. per-model stats + cost.
  const pricing = opts.pricing || DEFAULT_PRICING;
  const tokensByModel = opts.tokensByModel || {};
  const perModel = models.map((model) => {
    const caught = applied.filter((m) => m.caughtBy.includes(model));
    const unique = caught.filter((m) => m.caughtBy.length === 1);
    const tokens = tokensByModel[model] != null ? tokensByModel[model] : null;
    const cost = tokens != null ? costOfEvent({ tokens, model }, pricing) : null;
    const defectsCaught = caught.length;
    return {
      model,
      totalMutations,
      defectsCaught,
      uniqueDefectsCaught: unique.length,
      catchRate: totalMutations ? round4(defectsCaught / totalMutations) : null,
      uniqueCatchRate: totalMutations ? round4(unique.length / totalMutations) : null,
      tokens,
      cost: round4(cost),
      costPerCaughtDefect: cost != null && defectsCaught ? round4(cost / defectsCaught) : null,
    };
  });

  // 4. overlap matrix — mutations caught by both row and column model
  //    (diagonal = that model's own total catches).
  const overlap = {};
  for (const a of models) {
    overlap[a] = {};
    for (const b of models) {
      overlap[a][b] = applied.filter((m) => m.caughtBy.includes(a) && m.caughtBy.includes(b)).length;
    }
  }

  const skippedCount = perMutation.length - totalMutations;
  const topModel = perModel.slice().sort((a, b) => b.defectsCaught - a.defectsCaught)[0];
  const summary = totalMutations === 0
    ? `0/${perMutation.length} seeded mutations applied (all skipped — target pattern not found); no catch data produced.`
    : `${totalMutations}/${perMutation.length} seeded mutations applied` +
      (skippedCount ? ` (${skippedCount} skipped, pattern not found)` : "") +
      `; ${topModel ? `${topModel.model} caught the most (${topModel.defectsCaught}/${totalMutations})` : "no catches"}.`;

  return {
    ticket,
    dir,
    targetFile,
    mode: opts.mode,
    generatedAt: new Date().toISOString(),
    models,
    baseline: Object.fromEntries(models.map((m) => [m, { pass: baseline[m].pass, fail: baseline[m].fail, crashed: !!baseline[m].crashed }])),
    mutations: perMutation,
    perModel,
    overlap,
    summary,
  };
}

// --- EVIDENCE.md readout --------------------------------------------------

/** Render a runVariantMatrix() result as a markdown section for docs/EVIDENCE.md. */
export function formatEvidenceSection(result) {
  const lines = [];
  const label = result.mode === "harness-validation" ? "harness validation — no real defect data" : "real run";
  lines.push(`## Model eval matrix: ${result.ticket} (${label})`);
  lines.push("");
  lines.push(
    `Generated ${result.generatedAt} by \`eval_model_matrix\` (FBMCPF-148, \`server/modeleval.js\` ` +
    `\`runVariantMatrix\`), against variant test file${result.models.length === 1 ? "" : "s"} ` +
    result.models.map((m) => `\`${result.ticket}.${m}.test.js\``).join(", ") +
    (result.targetFile ? ` — seeded mutations applied to a temp COPY of \`${result.targetFile}\` (repo untouched).` : " (baseline only, no targetFile given — no seeded mutations run).")
  );
  lines.push("");
  if (result.mode === "harness-validation") {
    lines.push(
      "**Harness-validation run — not real defect data.** This proves the matrix runner, seeded-mutation " +
      "harness, unique-catch/overlap math, and cost-per-caught-defect calculation work end-to-end on a small " +
      "fixture. No production bug-catch numbers are represented here; nothing below should be read as evidence " +
      "about real model tiers on real code."
    );
    lines.push("");
  }
  lines.push(`Baseline (unmutated): ${result.models.map((m) => `${m} ${result.baseline[m].pass}/${result.baseline[m].pass + result.baseline[m].fail} passing`).join(", ")}.`);
  lines.push("");
  lines.push("| Model | Defects caught | Unique catches | Catch rate | Unique catch rate | Tokens | Cost | Cost / caught defect |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const pm of result.perModel) {
    lines.push(
      `| ${pm.model} | ${pm.defectsCaught}/${pm.totalMutations} | ${pm.uniqueDefectsCaught} | ` +
      `${pm.catchRate ?? "n/a"} | ${pm.uniqueCatchRate ?? "n/a"} | ${pm.tokens ?? "n/a"} | ${pm.cost ?? "n/a"} | ${pm.costPerCaughtDefect ?? "n/a"} |`
    );
  }
  lines.push("");
  lines.push("Overlap matrix (seeded mutations caught by both row and column model; diagonal = that model's total catches):");
  lines.push("");
  lines.push(`| | ${result.models.join(" | ")} |`);
  lines.push(`| --- | ${result.models.map(() => "---:").join(" | ")} |`);
  for (const a of result.models) {
    lines.push(`| ${a} | ${result.models.map((b) => result.overlap[a][b]).join(" | ")} |`);
  }
  lines.push("");
  lines.push(`Summary: ${result.summary}`);
  lines.push("");
  return lines.join("\n");
}

/** Append a formatted section to an EVIDENCE.md file (creates it if missing). Only called when the caller opts in (writeEvidence:true). */
export function appendEvidence(evidencePath, section) {
  const prev = fs.existsSync(evidencePath) ? fs.readFileSync(evidencePath, "utf8") : "";
  let out;
  if (!prev.trim()) out = section.replace(/\s*$/, "") + "\n";
  else out = prev.replace(/\s*$/, "") + "\n\n" + section.replace(/\s*$/, "") + "\n";
  fs.writeFileSync(evidencePath, out, "utf8");
  return evidencePath;
}
