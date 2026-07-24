import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Board } from "../server/storage.js";
import { postProjectUpdate, listUpdates, getLatestUpdate, UPDATE_HEALTH } from "../server/updates.js";

// FBMCPF-199 — narrative project updates (dated pad log + staleness).

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-updates-"));
  fs.mkdirSync(path.join(dir, "Proj"));
  fs.writeFileSync(path.join(dir, "Proj", "featurelist.md"), "# Feature List\n");
  fs.writeFileSync(path.join(dir, "Proj", "buglist.md"), "# Bug List\n");
  return new Board(dir);
}

test("postProjectUpdate validates health and requires a narrative", () => {
  const b = tmpBoard();
  assert.throws(() => postProjectUpdate(b, "Proj", { health: "green", narrative: "x" }), /health must be one of/);
  assert.throws(() => postProjectUpdate(b, "Proj", { health: "on-track", narrative: "" }), /narrative is required/);
  assert.deepEqual(UPDATE_HEALTH, ["on-track", "at-risk", "off-track"]);
});

test("posts are stored and parsed back oldest-first", () => {
  const b = tmpBoard();
  postProjectUpdate(b, "Proj", { health: "on-track", narrative: "kickoff", date: "2026-07-01" });
  postProjectUpdate(b, "Proj", { health: "at-risk", narrative: "scope creep", date: "2026-07-10" });
  const all = listUpdates(b, "Proj");
  assert.equal(all.length, 2);
  assert.deepEqual(all.map((u) => u.health), ["on-track", "at-risk"]);
  assert.equal(all[1].narrative, "scope creep");
});

test("getLatestUpdate returns the newest entry with age + staleness", () => {
  const b = tmpBoard();
  postProjectUpdate(b, "Proj", { health: "on-track", narrative: "old", date: "2026-07-01" });
  postProjectUpdate(b, "Proj", { health: "off-track", narrative: "fresh", date: "2026-07-16" });
  const now = new Date("2026-07-17T12:00:00Z");
  const latest = getLatestUpdate(b, "Proj", { now });
  assert.equal(latest.latest.narrative, "fresh");
  assert.equal(latest.latest.health, "off-track");
  assert.equal(latest.ageDays, 1);
  assert.equal(latest.stale, false);
  assert.equal(latest.staleHint, null);
  assert.equal(latest.count, 2);
});

test("an update older than 7 days is flagged stale with a hint", () => {
  const b = tmpBoard();
  postProjectUpdate(b, "Proj", { health: "at-risk", narrative: "stale one", date: "2026-07-01" });
  const now = new Date("2026-07-17T12:00:00Z");
  const latest = getLatestUpdate(b, "Proj", { now });
  assert.equal(latest.stale, true);
  assert.match(latest.staleHint, /consider post_project_update/);
});

test("getLatestUpdate is null when nothing has been posted", () => {
  const b = tmpBoard();
  assert.equal(getLatestUpdate(b, "Proj"), null);
});

