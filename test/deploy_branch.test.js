// FBMCPB-35 — deploy_site pushed the WEBSITE repo using the project git
// config's branch (the CODE repo's branch, e.g. "main"), so a website repo
// checked out on "master" failed with "src refspec main does not match any".
// commitFeature must, when running under deploy_site's repoOverride, resolve
// the branch as: gitTargets.websiteRepo.branch → the website repo's actual
// checked-out branch → the git config branch (last resort) — and the remote
// analogously from gitTargets.websiteRepo.remote. The code-repo path
// (commit_feature without repoOverride) keeps its old resolution untouched.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { setGitConfig, commitFeature, buildCommitPlan, DEFAULT_GIT_CONFIG } from "../server/git.js";
import { setProjectConfig } from "../server/metadata.js";

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbdeploy-"));
  return { dir, board: { projectDir: () => dir } };
}

function realGitExec(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { status: r.status == null ? 1 : r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

/** A working website repo checked out on "master" with a bare origin, one
 *  commit already pushed so the deploy push ADVANCES master rather than
 *  creating it. Returns { siteRepo, bare }. */
function websiteRepoOnMaster() {
  const siteRepo = fs.mkdtempSync(path.join(os.tmpdir(), "fbdeploy-site-"));
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "fbdeploy-bare-"));
  realGitExec(["init", "-q", "--bare"], bare);

  realGitExec(["init", "-q"], siteRepo);
  // Force the checked-out branch to "master" regardless of init.defaultBranch.
  realGitExec(["symbolic-ref", "HEAD", "refs/heads/master"], siteRepo);
  realGitExec(["config", "user.email", "t@t.dev"], siteRepo);
  realGitExec(["config", "user.name", "Tester"], siteRepo);
  realGitExec(["config", "commit.gpgsign", "false"], siteRepo);
  realGitExec(["remote", "add", "origin", bare], siteRepo);

  fs.writeFileSync(path.join(siteRepo, "index.html"), "<html>v1</html>\n");
  realGitExec(["add", "-A"], siteRepo);
  realGitExec(["commit", "-q", "-m", "initial site"], siteRepo);
  assert.equal(realGitExec(["push", "-q", "origin", "master"], siteRepo).status, 0, "seed push to bare master");
  return { siteRepo, bare };
}

function bareRef(bare, ref) {
  const r = realGitExec(["rev-parse", "--verify", "--quiet", ref], bare);
  return r.status === 0 ? r.stdout.trim() : null;
}

test("deploy push honors gitTargets.websiteRepo.branch over the git config branch", () => {
  const { board } = tmpBoard();
  const { siteRepo, bare } = websiteRepoOnMaster();
  const seeded = bareRef(bare, "refs/heads/master");
  assert.ok(seeded, "bare has a seeded master");

  // Project git config points the CODE repo at "main" — the production footgun.
  setGitConfig(board, "P", { enabled: true, remote: "origin", branch: "main" });
  setProjectConfig(board, "P", { gitTargets: { websiteRepo: { path: siteRepo, branch: "master" } } });

  fs.writeFileSync(path.join(siteRepo, "index.html"), "<html>v2</html>\n");
  const out = commitFeature(
    board, "P",
    { title: "Deploy P site", push: true },
    { cwd: siteRepo, repoOverride: siteRepo } // exactly how deploy_site calls it
  );

  assert.equal(out.committed, true, `commit failed: ${JSON.stringify(out.results)}`);
  assert.equal(out.pushed, true);
  const pushStep = out.results.find((r) => r.step === "push");
  assert.ok(pushStep, "a push step ran");
  assert.equal(pushStep.status, 0, `push failed: ${pushStep.stderr}`);

  // The bare repo's master ADVANCED to the new deploy commit…
  const head = realGitExec(["rev-parse", "HEAD"], siteRepo).stdout.trim();
  assert.equal(bareRef(bare, "refs/heads/master"), head, "bare master advanced to the deploy commit");
  assert.notEqual(head, seeded, "deploy created a new commit past the seed");
  // …and nothing was pushed to a "main" ref (the old broken refspec).
  assert.equal(bareRef(bare, "refs/heads/main"), null, "no main ref was created on the bare origin");
});

test("no websiteRepo.branch configured: the checked-out branch (master) is detected and used", () => {
  const { board } = tmpBoard();
  const { siteRepo, bare } = websiteRepoOnMaster();
  const seeded = bareRef(bare, "refs/heads/master");

  setGitConfig(board, "P", { enabled: true, remote: "origin", branch: "main" });
  // Only a path — no branch. commitFeature must fall back to rev-parse HEAD.
  setProjectConfig(board, "P", { gitTargets: { websiteRepo: { path: siteRepo } } });

  fs.writeFileSync(path.join(siteRepo, "index.html"), "<html>v2 fallback</html>\n");
  const out = commitFeature(
    board, "P",
    { title: "Deploy P site", push: true },
    { cwd: siteRepo, repoOverride: siteRepo }
  );

  assert.equal(out.committed, true, `commit failed: ${JSON.stringify(out.results)}`);
  const pushStep = out.results.find((r) => r.step === "push");
  assert.equal(pushStep.status, 0, `push failed: ${pushStep.stderr}`);

  const head = realGitExec(["rev-parse", "HEAD"], siteRepo).stdout.trim();
  assert.equal(bareRef(bare, "refs/heads/master"), head, "bare master advanced via the detected branch");
  assert.notEqual(head, seeded);
  assert.equal(bareRef(bare, "refs/heads/main"), null, "config branch 'main' was not used");
});

test("branch detection failure falls back to the git config branch (last resort)", () => {
  const { board } = tmpBoard();
  setGitConfig(board, "P", { enabled: true, remote: "origin", branch: "main" });
  setProjectConfig(board, "P", { gitTargets: { websiteRepo: { path: "/site/repo" } } });

  // Fake exec: rev-parse fails (as in a non-repo/hosed cwd); everything else succeeds.
  const calls = [];
  const fakeExec = (args, cwd) => {
    calls.push({ args, cwd });
    if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { status: 128, stdout: "", stderr: "fatal: not a git repository" };
    return { status: 0, stdout: "", stderr: "" };
  };

  const out = commitFeature(board, "P", { title: "Deploy", push: true }, { exec: fakeExec, repoOverride: "/site/repo" });
  assert.equal(out.committed, true);
  const push = calls.find((c) => c.args[0] === "push");
  assert.deepEqual(push.args, ["push", "origin", "main"], "falls back to the config branch");
  assert.equal(push.cwd, "/site/repo");
});

test("gitTargets.websiteRepo.remote wins over the config remote for the deploy push", () => {
  const { board } = tmpBoard();
  setGitConfig(board, "P", { enabled: true, remote: "origin", branch: "main" });
  setProjectConfig(board, "P", { gitTargets: { websiteRepo: { path: "/site/repo", branch: "master", remote: "site-origin" } } });

  const calls = [];
  const fakeExec = (args, cwd) => { calls.push({ args, cwd }); return { status: 0, stdout: "", stderr: "" }; };

  const out = commitFeature(board, "P", { title: "Deploy", push: true }, { exec: fakeExec, repoOverride: "/site/repo" });
  assert.equal(out.committed, true);
  const push = calls.find((c) => c.args[0] === "push");
  assert.deepEqual(push.args, ["push", "site-origin", "master"]);
  // Explicit websiteRepo.branch means NO rev-parse probe was needed.
  assert.ok(!calls.some((c) => c.args[0] === "rev-parse" && c.args[1] === "--abbrev-ref"), "no branch probe when configured");
});

test("code-repo path (no repoOverride) keeps the old resolution: config branch, untouched", () => {
  const { board } = tmpBoard();
  setGitConfig(board, "P", { enabled: true, remote: "origin", branch: "main" });
  // Even with a websiteRepo configured on master, commit_feature (no override)
  // must keep pushing the code repo to the config branch.
  setProjectConfig(board, "P", { codeLocation: "/code/repo", gitTargets: { codeRepo: { path: "/code/repo" }, websiteRepo: { path: "/site/repo", branch: "master" } } });

  const calls = [];
  const fakeExec = (args, cwd) => { calls.push({ args, cwd }); return { status: 0, stdout: "", stderr: "" }; };

  const out = commitFeature(board, "P", { ticket: "T-1", title: "Code change", push: true }, { exec: fakeExec });
  assert.equal(out.committed, true);
  const push = calls.find((c) => c.args[0] === "push");
  assert.deepEqual(push.args, ["push", "origin", "main"], "code path still uses the config branch");
  assert.equal(push.cwd, "/code/repo");
  assert.ok(!calls.some((c) => c.args[0] === "rev-parse" && c.args[1] === "--abbrev-ref"), "no website branch probe on the code path");
});

test("buildCommitPlan itself is unchanged (pure plan still uses the passed config's branch)", () => {
  const plan = buildCommitPlan({ ...DEFAULT_GIT_CONFIG, remote: "origin", branch: "main" }, { title: "x", push: true });
  assert.deepEqual(plan.steps[2].args, ["push", "origin", "main"]);
});
