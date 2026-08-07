import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  runChecksPipeline, parseRelativeDeps, discoverTestEntries, buildImpactGraph, impactedTests,
} from "../scripts/run-checks.mjs";
import { startChecks, resolveChecksConfig, impactGraphPath, readImpactGraph } from "../server/checks.js";
import { setProjectConfig } from "../server/metadata.js";
import { Board } from "../server/storage.js";

// FBMCPF-387 — impact testing: builtin impact check type + impact-graph database.

function initRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbimpact-repo-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: dir });
  spawnSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
  return dir;
}
function commit(dir, files, msg) {
  for (const [name, content] of Object.entries(files)) {
    const p = path.join(dir, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", msg], { cwd: dir });
  return spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout.trim();
}
function tmpResults() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbimpact-out-"));
  return path.join(dir, "run.json");
}

/** A tiny repo: a.js & b.js, one test each, both wired into package.json scripts. */
function seedRepo() {
  const repo = initRepo();
  const rev = commit(repo, {
    "package.json": JSON.stringify({
      name: "t", version: "0.0.0",
      scripts: {
        "test:unit": "node tests/test_a.js && node tests/test_b.js",
        "check": "node --check a.js",
        "bench": "node bench/bench_slow.js",
      },
    }),
    "a.js": "module.exports = { val: () => 1 };\n",
    "b.js": "module.exports = { val: () => 2 };\n",
    "tests/test_a.js": "const a = require('../a.js'); if (a.val() !== 1) process.exit(1); console.log('A OK');\n",
    "tests/test_b.js": "const b = require('../b.js'); if (b.val() !== 2) process.exit(1); console.log('B OK');\n",
    "bench/bench_slow.js": "const a = require('../a.js'); console.log('BENCH', a.val());\n",
  }, "seed");
  return { repo, rev };
}

test("FBMCPF-387: parseRelativeDeps finds require/import/dynamic-import/re-export specifiers", () => {
  const deps = parseRelativeDeps(`
    const a = require('./a.js');
    import b from "../b.js";
    const c = await import('./sub/c.js');
    export { d } from "./d.js";
    require('node:fs'); import zod from "zod";
  `);
  assert.deepEqual(deps.sort(), ["../b.js", "./a.js", "./d.js", "./sub/c.js"]);
});

test("FBMCPF-387: discoverTestEntries reads package.json scripts, skipping bare --check", () => {
  const { repo } = seedRepo();
  assert.deepEqual(discoverTestEntries(repo), ["bench/bench_slow.js", "tests/test_a.js", "tests/test_b.js"]);
});

test("FBMCPF-387: buildImpactGraph + impactedTests map a changed file to only the tests that see it", () => {
  const { repo } = seedRepo();
  const graph = buildImpactGraph(repo, ["tests/test_a.js", "tests/test_b.js"]);
  assert.equal(graph.version, 1);
  assert.ok(graph.files["a.js"], "graph reached a.js through test_a");

  const hit = impactedTests(graph, ["a.js"]);
  assert.deepEqual(hit.impacted, ["tests/test_a.js"], "only test_a sees a.js");
  assert.deepEqual(hit.unmapped, []);

  const miss = impactedTests(graph, ["orphan.js", "README.md"]);
  assert.deepEqual(miss.impacted, []);
  assert.deepEqual(miss.unmapped, ["orphan.js"], "js files nothing reaches are reported; non-js are not");
});

test("FBMCPF-387: incremental rebuild re-parses only changed files (prior m/s reused)", () => {
  const { repo } = seedRepo();
  const g1 = buildImpactGraph(repo, ["tests/test_a.js"]);
  const g2 = buildImpactGraph(repo, ["tests/test_a.js"], g1);
  assert.deepEqual(g2.files["a.js"], g1.files["a.js"], "unchanged file entry is reused verbatim");
});

test("FBMCPF-387: builtin impact stage runs only impacted entries; slowPatterns defer; graph DB is written", () => {
  const { repo } = seedRepo();
  const rev = commit(repo, { "a.js": "module.exports = { val: () => 1 }; // touched\n" }, "touch a");
  const resultsFile = tmpResults();
  const graphPath = path.join(path.dirname(resultsFile), "impact-graph.json");

  const results = runChecksPipeline({
    runId: "r1", repo, resultsFile, revision: rev, project: "P",
    checks: {
      syntaxCheckChangedFiles: false,
      testImpact: { graphPath, slowPatterns: ["bench/"] },
    },
  });

  assert.equal(results.status, "passed");
  const names = results.checks.map((c) => c.name);
  assert.ok(names.includes("impact:tests/test_a.js"), "impacted test ran");
  assert.ok(!names.includes("impact:tests/test_b.js"), "unimpacted test did NOT run");
  assert.ok(!names.includes("impact:bench/bench_slow.js"), "slow entry did not run");

  const map = results.checks.find((c) => c.type === "impact-map");
  assert.ok(map, "impact-map summary entry present");
  assert.deepEqual(map.deferred, ["bench/bench_slow.js"], "slow-but-impacted entry reported as deferred");

  const db = JSON.parse(fs.readFileSync(graphPath, "utf8"));
  assert.equal(db.version, 1, "impact-graph database persisted");
  assert.ok(db.files["a.js"], "database contains the touched file");
});

test("FBMCPF-387: a failing impacted test fails the run", () => {
  const { repo } = seedRepo();
  commit(repo, { "a.js": "module.exports = { val: () => 42 };\n" }, "break a"); // test_a expects 1
  const resultsFile = tmpResults();
  const results = runChecksPipeline({
    runId: "r2", repo, resultsFile, revision: null, project: "P",
    checks: { syntaxCheckChangedFiles: false, testImpact: {} },
  });
  assert.equal(results.status, "failed");
  const failed = results.checks.find((c) => c.name === "impact:tests/test_a.js");
  assert.equal(failed.status, "failed");
});

test("FBMCPF-387: delegated mode runs the configured command once with FB_IMPACT_CHANGED", () => {
  const { repo } = seedRepo();
  const rev = commit(repo, {
    "a.js": "module.exports = { val: () => 1 }; // touched again\n",
    "echo-changed.js": "console.log('CHANGED=' + (process.env.FB_IMPACT_CHANGED || '').split('\\n').filter(Boolean).length);\n",
  }, "touch + add echo");
  const resultsFile = tmpResults();
  const results = runChecksPipeline({
    runId: "r3", repo, resultsFile, revision: rev, project: "P",
    checks: { syntaxCheckChangedFiles: false, testImpact: { command: "node echo-changed.js" } },
  });
  const cmd = results.checks.find((c) => c.type === "impact");
  assert.equal(cmd.status, "passed");
  assert.match(cmd.output, /CHANGED=2/, "command saw both changed files in FB_IMPACT_CHANGED");
  const names = results.checks.filter((c) => c.name.startsWith("impact:tests/"));
  assert.equal(names.length, 0, "delegated mode does not also run builtin per-test entries");
});

test("FBMCPF-387: resolveChecksConfig passes testImpact through; startChecks defaults graphPath into the board DB", async () => {
  const boardDir = fs.mkdtempSync(path.join(os.tmpdir(), "fbimpact-board-"));
  fs.mkdirSync(path.join(boardDir, "Proj"));
  fs.writeFileSync(path.join(boardDir, "Proj", "featurelist.md"), "# Feature List\n");
  fs.writeFileSync(path.join(boardDir, "Proj", "buglist.md"), "# Bug List\n");
  const board = new Board(boardDir);

  const { repo } = seedRepo();
  setProjectConfig(board, "Proj", {
    codeLocation: repo,
    checks: { autoOnCommit: true, syntaxCheckChangedFiles: false, testImpact: { slowPatterns: ["bench/"] } },
  });

  const resolved = resolveChecksConfig(board, "Proj");
  assert.ok(resolved.testImpact, "testImpact survives config resolution");
  assert.deepEqual(resolved.testImpact.slowPatterns, ["bench/"]);

  const started = startChecks(board, "Proj", { ticket: "FBF-1" });
  assert.equal(started.started, true);
  const args = JSON.parse(fs.readFileSync(path.join(path.dirname(started.resultsFile), `${started.runId}.args.json`), "utf8"));
  assert.equal(args.checks.testImpact.graphPath, impactGraphPath(board, "Proj"),
    "runner args carry the board-owned impact-graph DB path");

  // wait for the detached runner to finish, then the DB must exist board-side
  for (let i = 0; i < 100; i++) {
    try {
      const r = JSON.parse(fs.readFileSync(started.resultsFile, "utf8"));
      if (r.status !== "running") break;
    } catch { /* runner not started yet */ }
    await new Promise((res) => setTimeout(res, 100));
  }
  const db = readImpactGraph(board, "Proj");
  assert.ok(db && db.version === 1, "impact-graph database exists under <project>/.featureboard/checks/");
});
