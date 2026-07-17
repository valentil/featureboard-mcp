import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Board } from "../server/storage.js";
import { getWorkPacket } from "../server/metadata.js";
import {
  addReviewComment,
  listReviewComments,
  resolveReviewComment,
  unresolvedReviewComments,
  ticketsWithUnresolvedReviews,
  REVIEW_COMMENTS_FILE,
} from "../server/reviews.js";

// FBMCPF-135 — per-ticket PR-style review comments

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-rc-"));
  fs.mkdirSync(path.join(dir, "Proj"));
  fs.writeFileSync(path.join(dir, "Proj", "featurelist.md"), "# Feature List\n");
  fs.writeFileSync(path.join(dir, "Proj", "buglist.md"), "# Bug List\n");
  return new Board(dir);
}

test("add_review_comment: increments RC ids and normalizes fields", () => {
  const b = tmpBoard();
  const c1 = addReviewComment(b, "Proj", "FBF-9", { comment: "  tighten the loop ", author: "lewis", file: "server/x.js", line: "42" });
  assert.equal(c1.id, "RC-1");
  assert.equal(c1.comment, "tighten the loop");
  assert.equal(c1.author, "lewis");
  assert.equal(c1.file, "server/x.js");
  assert.equal(c1.line, 42);
  assert.equal(c1.resolved, false);
  assert.equal(c1.resolvedAt, null);
  const c2 = addReviewComment(b, "Proj", "FBF-9", { comment: "no author here" });
  assert.equal(c2.id, "RC-2");
  assert.equal(c2.author, null);
  assert.equal(c2.file, null);
  assert.equal(c2.line, null);
  // persisted to the per-project jsonl file
  assert.ok(fs.existsSync(path.join(b.projectDir("Proj"), REVIEW_COMMENTS_FILE)));
});

test("add_review_comment: requires ticket and comment", () => {
  const b = tmpBoard();
  assert.throws(() => addReviewComment(b, "Proj", "", { comment: "x" }), /ticket is required/);
  assert.throws(() => addReviewComment(b, "Proj", "FBF-1", { comment: "   " }), /comment text is required/);
});

test("list_review_comments: scope by ticket and includeResolved filter", () => {
  const b = tmpBoard();
  addReviewComment(b, "Proj", "FBF-1", { comment: "a" });
  addReviewComment(b, "Proj", "FBF-2", { comment: "b" });
  const r2 = addReviewComment(b, "Proj", "FBF-1", { comment: "c" });
  assert.equal(listReviewComments(b, "Proj").length, 3);
  assert.equal(listReviewComments(b, "Proj", "FBF-1").length, 2);
  resolveReviewComment(b, "Proj", r2.id);
  assert.equal(listReviewComments(b, "Proj", "FBF-1").length, 2); // still listed by default
  assert.equal(listReviewComments(b, "Proj", "FBF-1", { includeResolved: false }).length, 1);
});

test("resolve_review_comment: flips resolved, idempotent, unknown id throws", () => {
  const b = tmpBoard();
  const c = addReviewComment(b, "Proj", "FBF-1", { comment: "fix it" });
  const r = resolveReviewComment(b, "Proj", c.id);
  assert.equal(r.resolved, true);
  assert.ok(r.resolvedAt);
  const again = resolveReviewComment(b, "Proj", c.id); // idempotent
  assert.equal(again.resolved, true);
  assert.equal(again.resolvedAt, r.resolvedAt);
  assert.throws(() => resolveReviewComment(b, "Proj", "RC-999"), /not found/);
});

test("unresolved helpers back next_task's Review exclusion", () => {
  const b = tmpBoard();
  // no comments -> ticket not in the unresolved set (next_task would SKIP it in Review)
  assert.equal(ticketsWithUnresolvedReviews(b, "Proj").has("FBF-1"), false);
  const c = addReviewComment(b, "Proj", "FBF-1", { comment: "please rework" });
  // now it carries unresolved feedback -> next_task should serve it back
  assert.equal(unresolvedReviewComments(b, "Proj", "FBF-1").length, 1);
  assert.equal(ticketsWithUnresolvedReviews(b, "Proj").has("FBF-1"), true);
  resolveReviewComment(b, "Proj", c.id);
  // resolved -> back to being skipped in Review
  assert.equal(unresolvedReviewComments(b, "Proj", "FBF-1").length, 0);
  assert.equal(ticketsWithUnresolvedReviews(b, "Proj").has("FBF-1"), false);
});

test("getWorkPacket surfaces unresolved review comments, drops them once resolved", () => {
  const b = tmpBoard();
  const f = b.addTask("Proj", "feature", { title: "Thing" });
  // no comments -> no reviewComments field
  assert.equal(getWorkPacket(b, "Proj", f.ticketNumber).reviewComments, undefined);
  const c = addReviewComment(b, "Proj", f.ticketNumber, { comment: "handle the empty case", file: "server/x.js", line: 10 });
  const packet = getWorkPacket(b, "Proj", f.ticketNumber);
  assert.equal(packet.reviewComments.length, 1);
  assert.equal(packet.reviewComments[0].comment, "handle the empty case");
  resolveReviewComment(b, "Proj", c.id);
  assert.equal(getWorkPacket(b, "Proj", f.ticketNumber).reviewComments, undefined);
});
