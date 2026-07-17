// FBMCPB-10 (fable variant) — dueDate must be YYYY-MM-DD everywhere; junk is
// remapped to description on add/import and rejected on explicit update.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Board, normalizeDueDate, DUE_DATE_RE, parseImport } from "../server/storage.js";

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-fable-"));
  fs.mkdirSync(path.join(dir, "Proj"));
  fs.writeFileSync(path.join(dir, "Proj", "featurelist.md"), "# Feature List\n");
  fs.writeFileSync(path.join(dir, "Proj", "buglist.md"), "# Bug List\n");
  return { b: new Board(dir), dir };
}

test("normalizeDueDate: null, undefined and empty string all clear without overflow", () => {
  assert.deepEqual(normalizeDueDate(null), { dueDate: null });
  assert.deepEqual(normalizeDueDate(undefined), { dueDate: null });
  assert.deepEqual(normalizeDueDate(""), { dueDate: null });
  assert.ok(!("overflow" in normalizeDueDate(null)), "clean clear must not carry overflow");
});

test("normalizeDueDate: valid YYYY-MM-DD passes through exactly, whitespace trimmed", () => {
  assert.deepEqual(normalizeDueDate("2026-07-20"), { dueDate: "2026-07-20" });
  assert.deepEqual(normalizeDueDate("  2026-07-20  "), { dueDate: "2026-07-20" });
});

test("normalizeDueDate: prose and near-miss formats become overflow verbatim (trimmed)", () => {
  for (const junk of ["fix the sorting", "07/20/2026", "2026-7-2", "2026-07-20T00:00:00Z", "20260720", "2026-07"]) {
    const r = normalizeDueDate(junk);
    assert.equal(r.dueDate, null, `"${junk}" must not become a dueDate`);
    assert.equal(r.overflow, junk.trim(), "original text must be preserved for remap");
  }
});

test("normalizeDueDate: non-string input is String()-coerced, numbers reject to overflow", () => {
  const r = normalizeDueDate(20260720);
  assert.equal(r.dueDate, null);
  assert.equal(r.overflow, "20260720");
});

test("DUE_DATE_RE is anchored — embedded dates inside prose do not match", () => {
  assert.equal(DUE_DATE_RE.test("due 2026-07-20 latest"), false);
  assert.equal(DUE_DATE_RE.test("2026-07-20"), true);
});

test("addTask: junk dueDate is remapped into description and dueDate is null", () => {
  const { b } = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "F", dueDate: "sometime next sprint" });
  assert.equal(t.dueDate, null);
  assert.match(t.description, /sometime next sprint/);
});

test("addTask: junk dueDate appends to an existing description, space-joined, order preserved", () => {
  const { b } = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "F", description: "base text", dueDate: "when ready" });
  assert.equal(t.description, "base text when ready");
});

test("addTask: valid dueDate is stored and survives a re-read from markdown", () => {
  const { b } = tmpBoard();
  b.addTask("Proj", "feature", { title: "F", dueDate: "2026-08-01" });
  const back = b.listTasks("Proj", {}).find((t) => t.title === "F");
  assert.equal(back.dueDate, "2026-08-01");
});

test("addTask: bugs get the same junk remap as features", () => {
  const { b } = tmpBoard();
  const t = b.addTask("Proj", "bug", { title: "B", dueDate: "asap!!" });
  assert.equal(t.dueDate, null);
  assert.match(t.description, /asap!!/);
});

test("updateTask: junk dueDate throws Invalid dueDate and leaves the task untouched on disk", () => {
  const { b, dir } = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "F", dueDate: "2026-08-01" });
  const before = fs.readFileSync(path.join(dir, "Proj", "featurelist.md"), "utf8");
  assert.throws(() => b.updateTask("Proj", t.ticketNumber, { dueDate: "next week" }), /Invalid dueDate/);
  const after = fs.readFileSync(path.join(dir, "Proj", "featurelist.md"), "utf8");
  assert.equal(after, before, "a rejected update must not modify the file");
});

test("updateTask: null clears the dueDate; omitting dueDate leaves it unchanged", () => {
  const { b } = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "F", dueDate: "2026-08-01" });
  const kept = b.updateTask("Proj", t.ticketNumber, { title: "F2" });
  assert.equal(kept.dueDate, "2026-08-01", "undefined dueDate must not clear");
  const cleared = b.updateTask("Proj", t.ticketNumber, { dueDate: null });
  assert.equal(cleared.dueDate, null);
});

test("updateTask: a valid replacement dueDate is accepted", () => {
  const { b } = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "F", dueDate: "2026-08-01" });
  const u = b.updateTask("Proj", t.ticketNumber, { dueDate: "2026-09-15" });
  assert.equal(u.dueDate, "2026-09-15");
});

test("import (JSON): junk due folds into description, valid dueDate kept, due/dueDate both honored", () => {
  const rows = parseImport(JSON.stringify([
    { title: "A", due: "prose deadline" },
    { title: "B", dueDate: "2026-09-01" },
    { title: "C", description: "has desc", due: "whenever" },
  ]), "json");
  const a = rows.find((r) => r.title === "A");
  assert.equal(a.dueDate, undefined);
  assert.match(a.description, /prose deadline/);
  assert.equal(rows.find((r) => r.title === "B").dueDate, "2026-09-01");
  assert.equal(rows.find((r) => r.title === "C").description, "has desc whenever");
});

test("import (CSV): junk due remaps; every imported dueDate is absent or canonical + sortable", () => {
  const csv = "title,dueDate\nA,fix it friday\nB,2026-01-02\nC,2025-12-31\n";
  const rows = parseImport(csv, "csv");
  for (const r of rows) {
    assert.ok(r.dueDate === undefined || DUE_DATE_RE.test(r.dueDate), `bad dueDate leaked: ${r.dueDate}`);
  }
  const dates = rows.map((r) => r.dueDate).filter(Boolean);
  assert.deepEqual([...dates].sort(), ["2025-12-31", "2026-01-02"], "canonical dates must sort chronologically as strings");
});
