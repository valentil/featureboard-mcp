import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// FBMCPF-239 — scripts/apply-edits.mjs, a sandbox-safe exact-match patcher.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, "../scripts/apply-edits.mjs");

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "apply-edits-test-"));
}

function writeFile(dir, name, content) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, "utf8");
  return p;
}

function writePayload(dir, payload) {
  const p = path.join(dir, "payload.json");
  fs.writeFileSync(p, JSON.stringify(payload), "utf8");
  return p;
}

function run(payloadFile, cwd) {
  return spawnSync(process.execPath, [SCRIPT, payloadFile], {
    cwd,
    encoding: "utf8",
  });
}

test("single exact match applies the edit", () => {
  const dir = mkTmpDir();
  const target = writeFile(dir, "target.txt", "hello world\n");
  const payloadFile = writePayload(dir, {
    file: "target.txt",
    edits: [{ old: "hello world", new: "hello there" }],
  });

  const result = run(payloadFile, dir);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /patched target\.txt: 1 edits/);
  assert.equal(fs.readFileSync(target, "utf8"), "hello there\n");
});

test("zero matches aborts without modifying the file", () => {
  const dir = mkTmpDir();
  const original = "hello world\n";
  const target = writeFile(dir, "target.txt", original);
  const payloadFile = writePayload(dir, {
    file: "target.txt",
    edits: [{ old: "not present anywhere", new: "replacement" }],
  });

  const result = run(payloadFile, dir);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /target\.txt/);
  assert.match(result.stderr, /edit\[0\]/);
  assert.equal(fs.readFileSync(target, "utf8"), original);
});

test("duplicate matches abort without modifying the file", () => {
  const dir = mkTmpDir();
  const original = "dup dup dup\n";
  const target = writeFile(dir, "target.txt", original);
  const payloadFile = writePayload(dir, {
    file: "target.txt",
    edits: [{ old: "dup", new: "single" }],
  });

  const result = run(payloadFile, dir);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /target\.txt/);
  assert.match(result.stderr, /found 3/);
  assert.equal(fs.readFileSync(target, "utf8"), original);
});

test("all:true replaces every occurrence", () => {
  const dir = mkTmpDir();
  const target = writeFile(dir, "target.txt", "foo foo foo\n");
  const payloadFile = writePayload(dir, {
    file: "target.txt",
    edits: [{ old: "foo", new: "bar", all: true }],
  });

  const result = run(payloadFile, dir);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /patched target\.txt: 1 edits/);
  assert.equal(fs.readFileSync(target, "utf8"), "bar bar bar\n");
});

test("all:true with zero occurrences aborts without modifying the file", () => {
  const dir = mkTmpDir();
  const original = "foo foo foo\n";
  const target = writeFile(dir, "target.txt", original);
  const payloadFile = writePayload(dir, {
    file: "target.txt",
    edits: [{ old: "missing", new: "bar", all: true }],
  });

  const result = run(payloadFile, dir);

  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(target, "utf8"), original);
});

test("syntax-breaking edit to a .js file is rolled back", () => {
  const dir = mkTmpDir();
  const original = "function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n";
  const target = writeFile(dir, "target.js", original);
  // Introduce an unmatched brace so the resulting file fails `node --check`.
  const payloadFile = writePayload(dir, {
    file: "target.js",
    edits: [{ old: "function add(a, b) {", new: "function add(a, b) {{{" }],
  });

  const result = run(payloadFile, dir);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /syntax check failed/);
  assert.equal(fs.readFileSync(target, "utf8"), original);
});

test("multiple files in one payload array are all patched, reported per file", () => {
  const dir = mkTmpDir();
  const targetA = writeFile(dir, "a.txt", "alpha\n");
  const targetB = writeFile(dir, "b.txt", "beta\n");
  const payloadFile = writePayload(dir, [
    { file: "a.txt", edits: [{ old: "alpha", new: "ALPHA" }] },
    { file: "b.txt", edits: [{ old: "beta", new: "BETA" }] },
  ]);

  const result = run(payloadFile, dir);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /patched a\.txt: 1 edits/);
  assert.match(result.stdout, /patched b\.txt: 1 edits/);
  assert.equal(fs.readFileSync(targetA, "utf8"), "ALPHA\n");
  assert.equal(fs.readFileSync(targetB, "utf8"), "BETA\n");
});

test("a failing edit in a multi-file payload aborts the whole run, changing nothing", () => {
  const dir = mkTmpDir();
  const originalA = "alpha\n";
  const originalB = "beta\n";
  const targetA = writeFile(dir, "a.txt", originalA);
  const targetB = writeFile(dir, "b.txt", originalB);
  const payloadFile = writePayload(dir, [
    { file: "a.txt", edits: [{ old: "alpha", new: "ALPHA" }] },
    { file: "b.txt", edits: [{ old: "not-there", new: "BETA" }] },
  ]);

  const result = run(payloadFile, dir);

  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(targetA, "utf8"), originalA);
  assert.equal(fs.readFileSync(targetB, "utf8"), originalB);
});

test("reads payload from stdin when no file argument is given", () => {
  const dir = mkTmpDir();
  const target = writeFile(dir, "target.txt", "hello world\n");
  const payload = JSON.stringify({
    file: "target.txt",
    edits: [{ old: "hello world", new: "hi world" }],
  });

  const result = spawnSync(process.execPath, [SCRIPT], {
    cwd: dir,
    input: payload,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(target, "utf8"), "hi world\n");
});
