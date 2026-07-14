import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  validatePlatform, platformLimit, buildShare,
  draftShare, listShares, removeShare, SHARES_FILE,
} from "../server/social.js";

// FBMCPF-42 — Social share drafts (draft-only; never posts)

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbsocial-"));
  return { dir, board: { projectDir: () => dir } };
}

test("validatePlatform normalizes aliases and rejects unknown", () => {
  assert.equal(validatePlatform("X"), "x");
  assert.equal(validatePlatform("twitter"), "x");
  assert.equal(validatePlatform("LinkedIn"), "linkedin");
  assert.equal(validatePlatform("li"), "linkedin");
  assert.throws(() => validatePlatform("facebook"), /unknown platform/);
});

test("platformLimit: X 280, LinkedIn 3000", () => {
  assert.equal(platformLimit("x"), 280);
  assert.equal(platformLimit("linkedin"), 3000);
});

test("buildShare enforces the length budget and records metadata", () => {
  const now = new Date("2026-07-13T10:00:00Z");
  const s = buildShare(1, { asset: "q.png", platform: "x", text: "hello" }, now);
  assert.equal(s.id, "s1");
  assert.equal(s.platform, "x");
  assert.equal(s.length, 5);
  assert.equal(s.status, "draft");
  assert.equal(s.createdAt, "2026-07-13T10:00:00.000Z");
  assert.throws(() => buildShare(2, { platform: "x", text: "a".repeat(281) }, now), /limit is 280/);
  assert.throws(() => buildShare(3, { platform: "x", text: "  " }, now), /text is required/);
});

test("draftShare persists monotonic ids and never mutates ids on removal", () => {
  const { board } = tmpBoard();
  const a = draftShare(board, "P", { asset: "q.png", platform: "x", text: "tweet copy" });
  assert.equal(a.share.id, "s1");
  const b = draftShare(board, "P", { asset: "q.png", platform: "linkedin", text: "longer post" });
  assert.equal(b.share.id, "s2");
  assert.equal(b.count, 2);
  removeShare(board, "P", "s1");
  const c = draftShare(board, "P", { asset: "q.png", platform: "x", text: "third" });
  assert.equal(c.share.id, "s3"); // seq not reused
});

test("listShares filters by asset and platform, newest-first", () => {
  const { board } = tmpBoard();
  draftShare(board, "P", { asset: "q.png", platform: "x", text: "one" });
  draftShare(board, "P", { asset: "r.png", platform: "linkedin", text: "two" });
  draftShare(board, "P", { asset: "q.png", platform: "linkedin", text: "three" });
  assert.equal(listShares(board, "P").count, 3);
  assert.equal(listShares(board, "P").shares[0].text, "three"); // newest-first
  assert.equal(listShares(board, "P", { asset: "q.png" }).count, 2);
  assert.equal(listShares(board, "P", { platform: "x" }).count, 1);
  assert.equal(listShares(board, "P", { asset: "q.png", platform: "linkedin" }).count, 1);
});

test("removeShare throws for unknown id", () => {
  const { board } = tmpBoard();
  draftShare(board, "P", { platform: "x", text: "hi" });
  assert.throws(() => removeShare(board, "P", "sX"), /not found/);
});

test("store lives in shares.json", () => {
  const { dir, board } = tmpBoard();
  draftShare(board, "P", { platform: "x", text: "hi" });
  assert.ok(fs.existsSync(path.join(dir, SHARES_FILE)));
});
