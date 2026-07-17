import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getTicketDiff } from "../server/git.js";
import { setProjectConfig } from "../server/metadata.js";
import { appendEvent } from "../server/events.js";

// FBMCPF-135 — per-ticket diff capture (get_ticket_diff)

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

// A board whose config lives in `boardDir`, pointing codeLocation at a real
// throwaway git repo we populate with ticket-tagged commits.
function setup() {
  const boardDir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-diffboard-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "fb-diffrepo-"));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "t@t.dev"]);
  git(repo, ["config", "user.name", "Tester"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  const board = { projectDir: () => boardDir };
  setProjectConfig(board, "Proj", { codeLocation: repo });
  return { board, repo, boardDir };
}

function commit(repo, file, content, message) {
  fs.writeFileSync(path.join(repo, file), content);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", message]);
}

test("get_ticket_diff: returns per-commit summary + unified diff for tagged commits", () => {
  const { board, repo } = setup();
  commit(repo, "a.txt", "hello\n", "FBMCPF-135: first change");
  commit(repo, "b.txt", "unrelated\n", "FBMCPF-200: other work");
  commit(repo, "a.txt", "hello world\n", "FBMCPF-135: second change");

  const res = getTicketDiff(board, "Proj", "FBMCPF-135");
  assert.equal(res.count, 2);
  const subjects = res.commits.map((c) => c.subject).sort();
  assert.deepEqual(subjects, ["FBMCPF-135: first change", "FBMCPF-135: second change"]);
  // diffs are real unified diffs mentioning the file, and the unrelated commit is excluded
  assert.ok(res.commits.some((c) => /a\.txt/.test(c.diff) && /hello world/.test(c.diff)));
  assert.ok(!res.commits.some((c) => /b\.txt/.test(c.diff)));
  assert.ok(res.commits[0].shortHash.length === 8);
  assert.equal(res.truncated, false);
});

test("get_ticket_diff: no matching commits returns an empty list with a message", () => {
  const { board, repo } = setup();
  commit(repo, "a.txt", "x\n", "FBMCPF-999: nothing to see");
  const res = getTicketDiff(board, "Proj", "FBMCPF-135");
  assert.equal(res.count, 0);
  assert.deepEqual(res.commits, []);
  assert.match(res.message, /no commits mention FBMCPF-135/);
});

test("get_ticket_diff: oversized diff is truncated with a notice", () => {
  const { board, repo } = setup();
  const big = "line of content\n".repeat(4000); // ~64KB
  commit(repo, "big.txt", big, "FBMCPF-135: add a large file");
  const res = getTicketDiff(board, "Proj", "FBMCPF-135", { maxBytes: 2000 });
  assert.equal(res.truncated, true);
  assert.equal(res.commits[0].diffTruncated, true);
  assert.match(res.commits[0].diff, /diff truncated/);
  assert.ok(res.commits[0].diff.length < big.length);
});

test("get_ticket_diff: no codeLocation configured -> warning, no throw", () => {
  const boardDir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-nocfg-"));
  const board = { projectDir: () => boardDir };
  const res = getTicketDiff(board, "Proj", "FBMCPF-135");
  assert.equal(res.count, 0);
  assert.match(res.warning, /no codeLocation/);
});

test("get_ticket_diff: codeLocation is not a git repo -> warning, no throw", () => {
  const boardDir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-nogit-"));
  const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), "fb-plain-"));
  const board = { projectDir: () => boardDir };
  setProjectConfig(board, "Proj", { codeLocation: notRepo });
  const res = getTicketDiff(board, "Proj", "FBMCPF-135");
  assert.equal(res.count, 0);
  assert.match(res.warning, /no git repository/);
});

// FBMCPF-188 — get_ticket_diff prefers commit_feature's recorded hashes
// (real correlation, from events.jsonl) over grepping commit messages, and
// falls back to grep for legacy tickets / stale recorded hashes.

test("get_ticket_diff: prefers recorded commit hashes over grep when the ticket has recorded commits", () => {
  const { board, repo } = setup();
  commit(repo, "a.txt", "hello\n", "FBMCPF-135: first change"); // would grep-match
  commit(repo, "b.txt", "tracked\n", "unrelated message, no ticket id"); // NOT grep-matched
  const hash = git(repo, ["rev-parse", "HEAD"]).trim();

  // simulate what commit_feature's enrichment records for the b.txt commit
  appendEvent(board, "Proj", {
    ticket: "FBMCPF-135", field: "commit", from: null, to: hash.slice(0, 8),
    hash, shortHash: hash.slice(0, 8), additions: 1, deletions: 0, source: "commit_feature",
  });

  const res = getTicketDiff(board, "Proj", "FBMCPF-135");
  assert.equal(res.source, "recorded");
  assert.equal(res.count, 1);
  assert.equal(res.commits[0].hash, hash);
  assert.ok(/b\.txt/.test(res.commits[0].diff));
  assert.ok(!/a\.txt/.test(res.commits[0].diff));
});

test("get_ticket_diff: falls back to grep for legacy tickets with no recorded commits", () => {
  const { board, repo } = setup();
  commit(repo, "a.txt", "hello\n", "FBMCPF-135: first change");
  const res = getTicketDiff(board, "Proj", "FBMCPF-135");
  assert.equal(res.source, "grep");
  assert.equal(res.count, 1);
});

test("get_ticket_diff: falls back to grep when a recorded hash no longer resolves in the repo", () => {
  const { board, repo } = setup();
  commit(repo, "a.txt", "hello\n", "FBMCPF-135: first change");
  const fakeHash = "deadbeef".repeat(5); // 40 hex-looking chars that don't resolve
  appendEvent(board, "Proj", {
    ticket: "FBMCPF-135", field: "commit", from: null, to: "deadbeef",
    hash: fakeHash, shortHash: "deadbeef", additions: 3, deletions: 1, source: "commit_feature",
  });

  const res = getTicketDiff(board, "Proj", "FBMCPF-135");
  assert.equal(res.source, "grep");
  assert.equal(res.count, 1);
  assert.equal(res.commits[0].subject, "FBMCPF-135: first change");
});
