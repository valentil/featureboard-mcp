import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Board, normalizeDueDate, parseImport } from "../server/storage.js";

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-"));
  fs.mkdirSync(path.join(dir, "Proj"));
  fs.writeFileSync(path.join(dir, "Proj", "featurelist.md"), "# Feature List\n");
  fs.writeFileSync(path.join(dir, "Proj", "buglist.md"), "# Bug List\n");
  return new Board(dir);
}

test("normalizeDueDate accepts YYYY-MM-DD, flags junk (FBMCPB-10)", () => {
  assert.deepEqual(normalizeDueDate("2026-07-20"), { dueDate: "2026-07-20" });
  assert.deepEqual(normalizeDueDate(null), { dueDate: null });
  assert.deepEqual(normalizeDueDate(""), { dueDate: null });
  assert.deepEqual(normalizeDueDate("Make paths platform-agnostic."), { dueDate: null, overflow: "Make paths platform-agnostic." });
});

test("addTask remaps junk dueDate into the description", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "F", dueDate: "Make paths platform-agnostic to support Linux." });
  assert.equal(t.dueDate, null);
  assert.match(t.description, /platform-agnostic/);
  const ok = b.addTask("Proj", "feature", { title: "G", dueDate: "2026-08-01" });
  assert.equal(ok.dueDate, "2026-08-01");
});

test("updateTask rejects junk dueDate outright", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "H" });
  assert.throws(() => b.updateTask("Proj", t.ticketNumber, { dueDate: "next Tuesday-ish" }), /Invalid dueDate/);
  b.updateTask("Proj", t.ticketNumber, { dueDate: "2026-08-02" });
  assert.equal(b.getTask("Proj", t.ticketNumber).dueDate, "2026-08-02");
  b.updateTask("Proj", t.ticketNumber, { dueDate: null });
  assert.equal(b.getTask("Proj", t.ticketNumber).dueDate, null);
});

test("imports remap junk due to description across formats", () => {
  const json = JSON.stringify([{ title: "A", due: "prose not a date" }, { title: "B", due: "2026-08-03" }]);
  const tasks = parseImport(json, "json");
  assert.equal(tasks[0].dueDate, undefined);
  assert.match(tasks[0].description, /prose not a date/);
  assert.equal(tasks[1].dueDate, "2026-08-03");
});
