/**
 * FBMCPB-65 — retire the pre-FBMCPB-55 checks directory.
 *
 * FBMCPB-55 moved the runner's transient files from <projectDir>/checks/ to
 * <projectDir>/.featureboard/checks/ so they would sit outside the Cowork-watched pad root.
 * The move worked but shipped no migration, so every pad that had ever run checks kept its
 * old directory: unreachable by any tool, yet still the freshest visible files in the pad, so
 * the desktop app kept offering them as chat attachments. 122 orphans across three pads on
 * the reporter's machine.
 *
 * The risk in fixing it is deleting something a user meant to keep. These tests exist mostly
 * to prove the guard refuses anything it does not fully recognise.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sweepLegacyChecksDir } from "../server/checks.js";

function tmpBoard() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fbsweep-"));
  const board = { dataDir, projectDir: (p) => path.join(dataDir, p) };
  fs.mkdirSync(board.projectDir("Proj"), { recursive: true });
  return board;
}
const legacyDir = (board) => path.join(board.projectDir("Proj"), "checks");
function seed(board, files) {
  const dir = legacyDir(board);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body ?? "{}");
  return dir;
}

// ── the happy path: exactly the shapes the runner writes ─────────────────────
test("removes a legacy dir containing only runner artifacts", () => {
  const board = tmpBoard();
  const dir = seed(board, {
    "1784914348690-ge1g1i.args.json": "{}",
    "1784910396559-a2jq4a.args.json": "{}",
    "1784910396559-a2jq4a.json": "{}",
    "run-checks.mjs": "// staged runner",
  });
  const res = sweepLegacyChecksDir(board, "Proj");
  assert.ok(res, "expected a sweep result");
  assert.equal(res.files, 4);
  assert.equal(res.removed, dir);
  assert.ok(!fs.existsSync(dir), "legacy dir should be gone");
});

test("removes an empty legacy dir", () => {
  const board = tmpBoard();
  const dir = legacyDir(board);
  fs.mkdirSync(dir, { recursive: true });
  const res = sweepLegacyChecksDir(board, "Proj");
  assert.ok(res);
  assert.equal(res.files, 0);
  assert.ok(!fs.existsSync(dir));
});

// ── the guard: anything unrecognised means hands off entirely ────────────────
test("refuses when even ONE unrecognised file is present", () => {
  const board = tmpBoard();
  const dir = seed(board, {
    "1784914348690-ge1g1i.args.json": "{}",
    "run-checks.mjs": "//",
    "my-notes.md": "# do not delete me",
  });
  assert.equal(sweepLegacyChecksDir(board, "Proj"), null, "must decline");
  assert.ok(fs.existsSync(dir), "directory must survive");
  assert.equal(fs.readdirSync(dir).length, 3, "every file must survive, not just the odd one");
  assert.equal(fs.readFileSync(path.join(dir, "my-notes.md"), "utf8"), "# do not delete me");
});

test("refuses when the dir contains a subdirectory", () => {
  const board = tmpBoard();
  const dir = seed(board, { "1784914348690-ge1g1i.args.json": "{}" });
  fs.mkdirSync(path.join(dir, "nested"));
  assert.equal(sweepLegacyChecksDir(board, "Proj"), null);
  assert.ok(fs.existsSync(path.join(dir, "nested")));
});

test("refuses near-miss filenames that are not the runner's shape", () => {
  for (const name of [
    "checks.json",                    // no runId prefix
    "abc-def.json",                   // non-numeric timestamp
    "1784914348690.json",             // missing the random suffix
    "1784914348690-ge1g1i.args.txt",  // wrong extension
    "1784914348690-GE1G1I.json",      // uppercase suffix (runner uses lowercase base36)
    "run-checks.js",                  // not the staged .mjs
  ]) {
    const board = tmpBoard();
    const dir = seed(board, { "1784914348690-ge1g1i.args.json": "{}", [name]: "x" });
    assert.equal(sweepLegacyChecksDir(board, "Proj"), null, `should refuse because of ${name}`);
    assert.ok(fs.existsSync(dir), `dir must survive ${name}`);
  }
});

// ── no-ops ───────────────────────────────────────────────────────────────────
test("no-ops when there is no legacy dir", () => {
  const board = tmpBoard();
  assert.equal(sweepLegacyChecksDir(board, "Proj"), null);
});

test("is idempotent — a second call is a clean no-op", () => {
  const board = tmpBoard();
  seed(board, { "1784914348690-ge1g1i.args.json": "{}" });
  assert.ok(sweepLegacyChecksDir(board, "Proj"));
  assert.equal(sweepLegacyChecksDir(board, "Proj"), null);
});

test("never throws on an unreadable//bogus project", () => {
  const board = { dataDir: "/nonexistent-xyz", projectDir: () => "/nonexistent-xyz/Nope" };
  assert.doesNotThrow(() => sweepLegacyChecksDir(board, "Nope"));
  assert.equal(sweepLegacyChecksDir(board, "Nope"), null);
});

// ── the NEW location must be untouched by the sweep ─────────────────────────
test("leaves the current .featureboard/checks dir completely alone", () => {
  const board = tmpBoard();
  seed(board, { "1784914348690-ge1g1i.args.json": "{}" });
  const current = path.join(board.projectDir("Proj"), ".featureboard", "checks");
  fs.mkdirSync(current, { recursive: true });
  fs.writeFileSync(path.join(current, "1784925998197-hnicm2.args.json"), "{}");

  sweepLegacyChecksDir(board, "Proj");
  assert.ok(!fs.existsSync(legacyDir(board)), "legacy gone");
  assert.ok(fs.existsSync(path.join(current, "1784925998197-hnicm2.args.json")),
    "the live checks dir must be untouched");
});
