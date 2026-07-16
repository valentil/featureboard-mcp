import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Board } from "../server/storage.js";
import { getProjectConfig, setProjectConfig } from "../server/metadata.js";
import {
  PAD_FILES,
  DEFAULT_EXCLUDES,
  planGraduation,
  graduateProject,
} from "../server/graduate.js";

// FBMCPF-150 — graduate_project: incubator -> dedicated-repo workflow.

// Build a fake pad dir that mixes pad files, real code (incl. subdirs), and junk.
function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbgrad-"));
  const proj = path.join(dir, "Proj");
  fs.mkdirSync(proj);
  // pad files (must NOT be copied into the code repo)
  fs.writeFileSync(path.join(proj, "featurelist.md"), "# Feature List\n");
  fs.writeFileSync(path.join(proj, "buglist.md"), "# Bug List\n");
  fs.writeFileSync(path.join(proj, "scratchpad.md"), "notes\n");
  fs.writeFileSync(path.join(proj, "agent_work_log.md"), "log\n");
  fs.writeFileSync(path.join(proj, "project_config.json"), "{}\n");
  fs.writeFileSync(path.join(proj, "experiments.json"), "[]\n");
  // real code (should be copied)
  fs.writeFileSync(path.join(proj, "main.js"), "console.log('hi');\n");
  fs.writeFileSync(path.join(proj, "README.md"), "# CADSolver\n");
  fs.mkdirSync(path.join(proj, "src"));
  fs.writeFileSync(path.join(proj, "src", "solver.js"), "export const solve = () => 42;\n");
  // junk (should be excluded)
  fs.mkdirSync(path.join(proj, "node_modules"));
  fs.writeFileSync(path.join(proj, "node_modules", "dep.js"), "junk\n");
  fs.writeFileSync(path.join(proj, "debug.log"), "log junk\n");
  fs.writeFileSync(path.join(proj, "_syncprobe.txt"), "probe\n");
  fs.writeFileSync(path.join(proj, "tmp_scratch.bin"), "tmp\n");
  fs.writeFileSync(path.join(proj, "test_mesh_cache.json"), "{}\n");
  return { board: new Board(dir), proj };
}

function countFiles(dir) {
  let n = 0;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) n += countFiles(path.join(dir, ent.name));
    else n += 1;
  }
  return n;
}

test("constants: PAD_FILES and DEFAULT_EXCLUDES are the documented sets", () => {
  assert.ok(PAD_FILES.includes("featurelist.md"));
  assert.ok(PAD_FILES.includes("project_config.json"));
  assert.ok(DEFAULT_EXCLUDES.includes("node_modules"));
  assert.ok(DEFAULT_EXCLUDES.includes("*.log"));
  assert.ok(DEFAULT_EXCLUDES.includes("tmp_*"));
});

test("planGraduation: pad files + junk excluded, code (incl. subdirs) included", () => {
  const { board } = tmpBoard();
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "fbgrad-tgt-"));
  fs.rmSync(target, { recursive: true, force: true }); // target does not exist yet
  const plan = planGraduation(board, "Proj", target);

  // code included
  assert.ok(plan.files.includes("main.js"));
  assert.ok(plan.files.includes("README.md"));
  assert.ok(plan.files.includes("src/solver.js"));
  // pad files excluded
  for (const pf of ["featurelist.md", "buglist.md", "scratchpad.md", "project_config.json"]) {
    assert.ok(!plan.files.includes(pf), `${pf} must be excluded`);
  }
  // junk excluded (node_modules descendant never appears)
  assert.ok(!plan.files.some((f) => f.startsWith("node_modules")));
  assert.ok(!plan.files.includes("debug.log"));
  assert.ok(!plan.files.includes("_syncprobe.txt"));
  assert.ok(!plan.files.includes("tmp_scratch.bin"));
  assert.ok(!plan.files.includes("test_mesh_cache.json"));
  // skipped records the excluded entries (node_modules skipped whole, not descended)
  assert.ok(plan.skipped.includes("node_modules"));
  assert.ok(plan.skipped.includes("featurelist.md"));
  assert.equal(plan.targetExists, false);
  assert.equal(plan.alreadyGraduated, false);
});

test("extra excludes apply on top of the defaults", () => {
  const { board } = tmpBoard();
  const plan = planGraduation(board, "Proj", path.join(os.tmpdir(), "fbgrad-x"), { excludes: ["README.md"] });
  assert.ok(!plan.files.includes("README.md"));
  assert.ok(plan.files.includes("main.js"));
});

test("dryRun makes NO filesystem changes", () => {
  const { board, proj } = tmpBoard();
  const target = path.join(os.tmpdir(), "fbgrad-dry-" + Date.now());
  const before = countFiles(proj);
  const res = graduateProject(board, "Proj", target, { dryRun: true });
  assert.equal(res.dryRun, true);
  assert.ok(Array.isArray(res.files));
  assert.equal(fs.existsSync(target), false, "target not created on dry-run");
  assert.equal(countFiles(proj), before, "source untouched");
  // config not repointed
  const cfg = getProjectConfig(board, "Proj");
  assert.notEqual(cfg.stage, "graduated");
});

test("real run (commit:false): copies code, mirrors pad, repoints config, source untouched", () => {
  const { board, proj } = tmpBoard();
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "fbgrad-run-"));
  fs.rmSync(target, { recursive: true, force: true });
  const sourceCountBefore = countFiles(proj);

  const res = graduateProject(board, "Proj", target, { commit: false, dryRun: false });
  assert.equal(res.dryRun, false);

  // code copied, subdirs preserved
  assert.ok(fs.existsSync(path.join(target, "main.js")));
  assert.ok(fs.existsSync(path.join(target, "src", "solver.js")));
  // pad files NOT in the code root
  assert.ok(!fs.existsSync(path.join(target, "featurelist.md")));
  assert.ok(!fs.existsSync(path.join(target, "node_modules")));
  // .featureboard mirror contains pad files
  assert.ok(fs.existsSync(path.join(target, ".featureboard", "featurelist.md")));
  assert.ok(fs.existsSync(path.join(target, ".featureboard", "buglist.md")));
  assert.ok(res.mirror.includes(".featureboard/featurelist.md"));
  // git skipped because commit:false
  assert.equal(res.git.committed, false);

  // config repointed
  const cfg = getProjectConfig(board, "Proj");
  assert.equal(cfg.codeLocation, target);
  assert.equal(cfg.stage, "graduated");
  assert.equal(cfg.gitTargets.codeRepo.path, target);

  // scratchpad records the graduation
  const pad = fs.readFileSync(path.join(proj, "scratchpad.md"), "utf8");
  assert.match(pad, /\[GRADUATION/);
  assert.ok(pad.includes(target));

  // SOURCE untouched: no code copied out is ever deleted from the source, pad files
  // stay put, and no repo is created in the source. The pad dir does gain the board's
  // own managed config (.featureboard.config.json) because setProjectConfig repoints
  // codeLocation there by design \u2014 that is board metadata, not a source mutation.
  for (const f of ["main.js", "README.md", "src/solver.js", "featurelist.md", "buglist.md", "scratchpad.md"]) {
    assert.ok(fs.existsSync(path.join(proj, ...f.split("/"))), `source ${f} still present`);
  }
  assert.equal(fs.readFileSync(path.join(proj, "src", "solver.js"), "utf8"), "export const solve = () => 42;\n");
  assert.ok(!fs.existsSync(path.join(proj, ".git")), "no repo created in source");
  // only board-metadata files may be added; nothing removed
  assert.ok(countFiles(proj) >= sourceCountBefore, "no source file removed");
});

test("separate codeLocation source: code dir is byte-for-byte untouched (exact count)", () => {
  const { board } = tmpBoard();
  // point codeLocation at a distinct code repo that graduation must only READ
  const codeDir = fs.mkdtempSync(path.join(os.tmpdir(), "fbgrad-code-"));
  fs.writeFileSync(path.join(codeDir, "app.js"), "module.exports = 1;\n");
  fs.mkdirSync(path.join(codeDir, "lib"));
  fs.writeFileSync(path.join(codeDir, "lib", "util.js"), "exports.x = 2;\n");
  fs.writeFileSync(path.join(codeDir, "notes.log"), "junk\n"); // excluded
  setProjectConfig(board, "Proj", { codeLocation: codeDir });

  const target = fs.mkdtempSync(path.join(os.tmpdir(), "fbgrad-sep-tgt-"));
  fs.rmSync(target, { recursive: true, force: true });
  const codeCountBefore = countFiles(codeDir);

  const res = graduateProject(board, "Proj", target, { commit: false, dryRun: false });
  assert.equal(res.source, codeDir);
  assert.ok(res.files.includes("app.js"));
  assert.ok(res.files.includes("lib/util.js"));
  assert.ok(!res.files.includes("notes.log"));
  // the true source (a real code dir) is EXACTLY unchanged \u2014 nothing added or removed
  assert.equal(countFiles(codeDir), codeCountBefore, "code dir file count unchanged");
  assert.ok(!fs.existsSync(path.join(codeDir, ".git")), "no repo created in code source");
  // copied out correctly, and pad mirror still comes from the boards dir
  assert.ok(fs.existsSync(path.join(target, "lib", "util.js")));
  assert.ok(fs.existsSync(path.join(target, ".featureboard", "featurelist.md")));
});

test("preserves an existing padRepo in gitTargets", () => {
  const { board } = tmpBoard();
  // seed a padRepo
  setProjectConfig(board, "Proj", { gitTargets: { padRepo: { path: "/pad/repo", branch: "master" } } });
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "fbgrad-pad-"));
  fs.rmSync(target, { recursive: true, force: true });
  graduateProject(board, "Proj", target, { commit: false, dryRun: false });
  const cfg = getProjectConfig(board, "Proj");
  assert.equal(cfg.gitTargets.codeRepo.path, target);
  assert.deepEqual(cfg.gitTargets.padRepo, { path: "/pad/repo", branch: "master" });
});

test("targetPath equal to source is rejected", () => {
  const { board, proj } = tmpBoard();
  assert.throws(() => planGraduation(board, "Proj", proj), /must differ/);
});

// Git commit test — only runs if `git` is present in this environment.
test("real run with commit creates a commit in the target repo", (t) => {
  const probe = spawnSync("git", ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    t.skip("git not available");
    return;
  }
  const { board } = tmpBoard();
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "fbgrad-git-"));
  fs.rmSync(target, { recursive: true, force: true });
  // Supply a git identity via env so the commit can actually succeed in CI/sandboxes
  // that have no global git config. spawnSync inherits process.env.
  const savedEnv = { ...process.env };
  process.env.GIT_AUTHOR_NAME = process.env.GIT_AUTHOR_NAME || "FeatureBoard Test";
  process.env.GIT_AUTHOR_EMAIL = process.env.GIT_AUTHOR_EMAIL || "test@featureboard.local";
  process.env.GIT_COMMITTER_NAME = process.env.GIT_COMMITTER_NAME || "FeatureBoard Test";
  process.env.GIT_COMMITTER_EMAIL = process.env.GIT_COMMITTER_EMAIL || "test@featureboard.local";
  try {
    const res = graduateProject(board, "Proj", target, { commit: true, dryRun: false });
    // git may still fail if user.email/name are unset; tolerate that as a warning.
    if (!res.git.committed) {
      t.diagnostic("git commit did not complete: " + (res.git.warning || "unknown"));
      assert.ok(res.git.warning, "a warning is captured when commit fails");
      return;
    }
    assert.equal(res.git.initialized, true);
    assert.ok(fs.existsSync(path.join(target, ".git")), "repo initialized in target");
    const log = spawnSync("git", ["-C", target, "log", "--oneline"], { encoding: "utf8" });
    assert.match(log.stdout, /graduation/i);
  } finally {
    process.env = savedEnv;
    fs.rmSync(target, { recursive: true, force: true });
  }
});
