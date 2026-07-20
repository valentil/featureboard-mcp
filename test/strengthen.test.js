import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { appendFindings } from "../scripts/strengthen.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, "..", "scripts", "strengthen.mjs");

// ---------------------------------------------------------------------------
// Full end-to-end pass (real process, real board fixtures) — the suite stage
// is skipped so this stays fast in CI; the fuzz stages and perf still run
// for real against the healthy codebase.
// ---------------------------------------------------------------------------

test("strengthen --once --skip-suite --jobs 2 runs a clean pass", () => {
  const res = spawnSync(process.execPath, [SCRIPT, "--once", "--skip-suite", "--jobs", "2"], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf8",
    timeout: 90_000,
  });

  assert.equal(res.status, 0, `expected exit code 0, got ${res.status}.\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.match(res.stdout, /strengthen pass/, `missing summary line.\nstdout:\n${res.stdout}`);
  assert.match(res.stdout, /suite skipped/, `expected the suite stage to be skipped.\nstdout:\n${res.stdout}`);

  // Fuzz stages must report OK with zero findings against the healthy codebase.
  assert.match(res.stdout, /fuzz-md OK \(200\)/, `fuzz-markdown reported issues.\nstdout:\n${res.stdout}`);
  assert.match(res.stdout, /fuzz-lic OK \(500\)/, `fuzz-license reported issues.\nstdout:\n${res.stdout}`);
  assert.match(res.stdout, /pmbridge OK/, `fuzz-pmbridge reported issues.\nstdout:\n${res.stdout}`);
});

// ---------------------------------------------------------------------------
// Findings appender — must survive a corrupt findings file without crashing,
// rotating it to .bak and starting fresh instead.
// ---------------------------------------------------------------------------

test("appendFindings rotates a corrupt findings file to .bak and starts fresh", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-strengthen-findings-"));
  const findingsPath = path.join(tmpDir, "strengthen_findings.json");
  const bakPath = `${findingsPath}.bak`;
  const corrupt = "{ this is not valid json ][";
  fs.writeFileSync(findingsPath, corrupt, "utf8");

  const result = appendFindings(tmpDir, [
    { at: new Date().toISOString(), stage: "test", severity: "warn", detail: "synthetic finding" },
  ]);

  assert.ok(Array.isArray(result));
  assert.equal(result.length, 1);
  assert.equal(result[0].detail, "synthetic finding");

  const onDisk = JSON.parse(fs.readFileSync(findingsPath, "utf8"));
  assert.equal(onDisk.length, 1);
  assert.equal(onDisk[0].stage, "test");
  assert.equal(onDisk[0].severity, "warn");

  assert.ok(fs.existsSync(bakPath), "corrupt file should have been rotated to .bak");
  assert.equal(fs.readFileSync(bakPath, "utf8"), corrupt);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("appendFindings creates strengthen_findings.json fresh when missing", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-strengthen-findings2-"));
  const findingsPath = path.join(tmpDir, "strengthen_findings.json");
  assert.ok(!fs.existsSync(findingsPath));

  appendFindings(tmpDir, [{ at: new Date().toISOString(), stage: "x", severity: "fail", detail: "d" }]);

  assert.ok(fs.existsSync(findingsPath));
  const onDisk = JSON.parse(fs.readFileSync(findingsPath, "utf8"));
  assert.equal(onDisk.length, 1);
  assert.equal(onDisk[0].stage, "x");

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("appendFindings accumulates across calls on a healthy existing file", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-strengthen-findings3-"));
  appendFindings(tmpDir, [{ at: new Date().toISOString(), stage: "a", severity: "fail", detail: "first" }]);
  appendFindings(tmpDir, [{ at: new Date().toISOString(), stage: "b", severity: "warn", detail: "second" }]);

  const findingsPath = path.join(tmpDir, "strengthen_findings.json");
  const onDisk = JSON.parse(fs.readFileSync(findingsPath, "utf8"));
  assert.equal(onDisk.length, 2);
  assert.deepEqual(onDisk.map((f) => f.stage), ["a", "b"]);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
