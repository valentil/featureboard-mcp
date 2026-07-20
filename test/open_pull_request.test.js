import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Board } from "../server/storage.js";
import { setProjectConfig } from "../server/metadata.js";
import { openPullRequest, normalizeRemoteUrl, setGitConfig } from "../server/git.js";

// FBMCPF-213 — open_pull_request: pushed ticket branch → PR.

function tmpBoard(withRepo = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbpr-"));
  fs.mkdirSync(path.join(dir, "Proj"));
  fs.writeFileSync(path.join(dir, "Proj", "featurelist.md"), "# Feature List\n");
  fs.writeFileSync(path.join(dir, "Proj", "buglist.md"), "# Bug List\n");
  const b = new Board(dir);
  let repo = null;
  if (withRepo) {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "fbpr-repo-"));
    fs.mkdirSync(path.join(repo, ".git"));
    setProjectConfig(b, "Proj", { codeLocation: repo });
  }
  return { b, repo };
}

/** Scripted git exec: map "subcommand key" → result. Default success. */
function fakeExec(script) {
  const calls = [];
  const exec = (args, cwd) => {
    calls.push(args.join(" "));
    for (const [prefix, result] of script) {
      if (args.join(" ").startsWith(prefix)) return result;
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  exec.calls = calls;
  return exec;
}

const OK = { status: 0, stdout: "", stderr: "" };
const FAIL = { status: 1, stdout: "", stderr: "nope" };

test("normalizeRemoteUrl handles ssh, https, and git@ forms", () => {
  assert.equal(normalizeRemoteUrl("git@github.com:acme/widget.git"), "https://github.com/acme/widget");
  assert.equal(normalizeRemoteUrl("https://github.com/acme/widget.git"), "https://github.com/acme/widget");
  assert.equal(normalizeRemoteUrl("https://github.com/acme/widget/"), "https://github.com/acme/widget");
  assert.equal(normalizeRemoteUrl("ssh://git@gitlab.com/acme/widget.git"), "https://gitlab.com/acme/widget");
  assert.equal(normalizeRemoteUrl("not a url"), null);
});

test("no codeLocation → opened:false with reason", () => {
  const { b } = tmpBoard(false);
  const r = openPullRequest(b, "Proj", { ticket: "FBF-1" });
  assert.equal(r.opened, false);
  assert.match(r.reason, /codeLocation/);
});

test("missing branch → opened:false", () => {
  const { b } = tmpBoard();
  const exec = fakeExec([["rev-parse --verify --quiet ticket/FBF-1", FAIL]]);
  const r = openPullRequest(b, "Proj", { ticket: "FBF-1" }, { exec, gh: () => FAIL });
  assert.equal(r.opened, false);
  assert.match(r.reason, /does not exist/);
});

test("unpushed branch under commit-only mode refuses instead of pushing", () => {
  const { b } = tmpBoard();
  setGitConfig(b, "Proj", { mode: "commit-only" });
  const exec = fakeExec([
    ["rev-parse --verify --quiet origin/ticket/FBF-1", FAIL],
    ["remote get-url origin", { status: 0, stdout: "git@github.com:acme/widget.git\n", stderr: "" }],
  ]);
  const r = openPullRequest(b, "Proj", { ticket: "FBF-1" }, { exec, gh: () => FAIL });
  assert.equal(r.opened, false);
  assert.match(r.reason, /not on origin/);
  assert.ok(!exec.calls.some((c) => c.startsWith("push")));
});

test("gh available → PR created with ticket title/body and URL parsed", () => {
  const { b } = tmpBoard();
  const exec = fakeExec([
    ["remote get-url origin", { status: 0, stdout: "https://github.com/acme/widget.git\n", stderr: "" }],
  ]);
  const ghCalls = [];
  const gh = (args) => {
    ghCalls.push(args);
    if (args[0] === "--version") return OK;
    return { status: 0, stdout: "https://github.com/acme/widget/pull/7\n", stderr: "" };
  };
  const r = openPullRequest(
    b, "Proj",
    { ticket: "FBF-1", title: "Do the thing", description: "Details here", base: "main", draft: true },
    { exec, gh }
  );
  assert.equal(r.opened, true);
  assert.equal(r.url, "https://github.com/acme/widget/pull/7");
  const createArgs = ghCalls.find((a) => a[0] === "pr");
  assert.ok(createArgs.includes("FBF-1: Do the thing"));
  assert.ok(createArgs.some((a) => /Closes FBF-1/.test(a)));
  assert.ok(createArgs.includes("--base") && createArgs.includes("main") && createArgs.includes("--draft"));
});

test("no gh → compare URL fallback", () => {
  const { b } = tmpBoard();
  const exec = fakeExec([
    ["remote get-url origin", { status: 0, stdout: "git@github.com:acme/widget.git\n", stderr: "" }],
  ]);
  const r = openPullRequest(b, "Proj", { ticket: "FBF-1", title: "T" }, { exec, gh: () => ({ status: 127, stdout: "", stderr: "gh not found" }) });
  assert.equal(r.opened, false);
  assert.equal(r.via, "compare-url");
  assert.equal(r.compareUrl, "https://github.com/acme/widget/compare/ticket%2FFBF-1?expand=1");
});
