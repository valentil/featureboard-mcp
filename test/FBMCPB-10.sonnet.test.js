// Regression tests for FBMCPB-10:
//   "Validation: add_feature/import accept non-date dueDate (legacy tickets
//   have descriptions in due)."
//
// Pins the behavior of normalizeDueDate() and every path that consumes it:
// addTask, updateTask, and the import parsers (parseImport -> normalizeImported)
// that feed addTask.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Board, normalizeDueDate, parseImport } from "../server/storage.js";

function makeBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbmcpb10-"));
  const board = new Board(dir);
  board.createProject("proj");
  return board;
}

// ---------------------------------------------------------------------------
// normalizeDueDate()
// ---------------------------------------------------------------------------

test("normalizeDueDate accepts a well-formed YYYY-MM-DD string", () => {
  const result = normalizeDueDate("2026-07-16");
  assert.deepEqual(result, { dueDate: "2026-07-16" });
});

test("normalizeDueDate treats null and empty string as an explicit clear, no overflow", () => {
  assert.deepEqual(normalizeDueDate(null), { dueDate: null });
  assert.deepEqual(normalizeDueDate(undefined), { dueDate: null });
  assert.deepEqual(normalizeDueDate(""), { dueDate: null });
  assert.equal("overflow" in normalizeDueDate(null), false);
});

test("normalizeDueDate flags prose as overflow and does not set dueDate", () => {
  const result = normalizeDueDate("waiting on legal sign-off");
  assert.equal(result.dueDate, null);
  assert.equal(result.overflow, "waiting on legal sign-off");
});

test("normalizeDueDate trims surrounding whitespace before validating", () => {
  assert.deepEqual(normalizeDueDate("  2026-07-16  "), { dueDate: "2026-07-16" });
  const junk = normalizeDueDate("  needs review  ");
  assert.equal(junk.dueDate, null);
  assert.equal(junk.overflow, "needs review");
});

test("normalizeDueDate rejects date-time and slash-formatted strings as overflow", () => {
  const iso = normalizeDueDate("2026-07-16T10:00:00Z");
  assert.equal(iso.dueDate, null);
  assert.equal(iso.overflow, "2026-07-16T10:00:00Z");

  const slash = normalizeDueDate("07/16/2026");
  assert.equal(slash.dueDate, null);
  assert.equal(slash.overflow, "07/16/2026");
});

test("normalizeDueDate only validates shape, not calendar correctness", () => {
  // FBMCPB-10 only requires the YYYY-MM-DD shape; it does not check that the
  // month/day are real calendar values. Pinning current behavior.
  const result = normalizeDueDate("2026-13-45");
  assert.deepEqual(result, { dueDate: "2026-13-45" });
});

test("normalizeDueDate coerces non-string values via String()", () => {
  const result = normalizeDueDate(20260716);
  assert.equal(result.dueDate, null);
  assert.equal(result.overflow, "20260716");
});

test("addTask stores a valid dueDate and leaves description untouched", () => {
  const board = makeBoard();
  const task = board.addTask("proj", "feature", {
    title: "Add dark mode",
    description: "Ship a dark theme toggle.",
    dueDate: "2026-08-01",
  });
  assert.equal(task.dueDate, "2026-08-01");
  assert.equal(task.description, "Ship a dark theme toggle.");

  const stored = board.getTask("proj", task.ticketNumber);
  assert.equal(stored.dueDate, "2026-08-01");
  assert.equal(stored.description, "Ship a dark theme toggle.");
});

test("addTask remaps a prose dueDate into description and clears dueDate", () => {
  const board = makeBoard();
  const task = board.addTask("proj", "feature", {
    title: "Legacy ticket",
    description: "Original description.",
    dueDate: "waiting on design review",
  });
  assert.equal(task.dueDate, null);
  assert.equal(task.description, "Original description. waiting on design review");

  const stored = board.getTask("proj", task.ticketNumber);
  assert.equal(stored.dueDate, null);
  assert.equal(stored.description, "Original description. waiting on design review");
});

test("addTask uses junk due text as the description when none was provided", () => {
  const board = makeBoard();
  const task = board.addTask("proj", "bug", {
    title: "Legacy bug import",
    dueDate: "sometime next quarter",
  });
  assert.equal(task.dueDate, null);
  assert.equal(task.description, "sometime next quarter");

  const stored = board.getTask("proj", task.ticketNumber);
  assert.equal(stored.dueDate, null);
  assert.equal(stored.description, "sometime next quarter");
});

test("addTask leaves dueDate null when it is omitted entirely", () => {
  const board = makeBoard();
  const task = board.addTask("proj", "feature", { title: "No due date" });
  assert.equal(task.dueDate, null);
  assert.equal(task.description, "");
});

test("updateTask accepts a valid replacement dueDate", () => {
  const board = makeBoard();
  const task = board.addTask("proj", "feature", { title: "Reschedule me", dueDate: "2026-08-01" });
  const updated = board.updateTask("proj", task.ticketNumber, { dueDate: "2026-09-01" });
  assert.equal(updated.dueDate, "2026-09-01");

  const stored = board.getTask("proj", task.ticketNumber);
  assert.equal(stored.dueDate, "2026-09-01");
});

test("updateTask rejects a prose dueDate with a descriptive error and writes nothing", () => {
  const board = makeBoard();
  const task = board.addTask("proj", "feature", {
    title: "Do not corrupt me",
    dueDate: "2026-08-01",
  });

  assert.throws(
    () => board.updateTask("proj", task.ticketNumber, { dueDate: "blocked on legal" }),
    /Invalid dueDate/
  );

  // The on-disk task must be completely unchanged after the rejected update.
  const stored = board.getTask("proj", task.ticketNumber);
  assert.equal(stored.dueDate, "2026-08-01");
  assert.equal(stored.title, "Do not corrupt me");
});

test("parseImport (csv) remaps a junk due column into the description", () => {
  const csv = 'title,description,due\n"Legacy row","Old ticket","needs triage"\n';
  const [task] = parseImport(csv, "csv");
  assert.equal(task.title, "Legacy row");
  assert.equal(task.dueDate, undefined);
  assert.equal(task.description, "Old ticket needs triage");
});

test("parseImport (csv) keeps a valid duedate column as dueDate untouched", () => {
  const csv = 'title,description,duedate\n"Valid row","Ships soon","2026-09-01"\n';
  const [task] = parseImport(csv, "csv");
  assert.equal(task.title, "Valid row");
  assert.equal(task.dueDate, "2026-09-01");
  assert.equal(task.description, "Ships soon");
});

test("parseImport (json) remaps a junk dueDate field into description for tasks array", () => {
  const json = JSON.stringify({
    tasks: [{ title: "Imported legacy ticket", description: "keep me", dueDate: "ASAP - overdue" }],
  });
  const [task] = parseImport(json, "json");
  assert.equal(task.title, "Imported legacy ticket");
  assert.equal(task.dueDate, undefined);
  assert.equal(task.description, "keep me ASAP - overdue");
});

test("parseImport (json) keeps a valid dueDate field for a bare object payload", () => {
  const json = JSON.stringify({ title: "Single import", dueDate: "2026-12-25" });
  const [task] = parseImport(json, "json");
  assert.equal(task.title, "Single import");
  assert.equal(task.dueDate, "2026-12-25");
});

test("end-to-end: importing a legacy CSV row through addTask never leaves a junk dueDate on disk", () => {
  const board = makeBoard();
  const csv = 'title,description,due\n"Old prose due date","Migrated from legacy tool","see attached spec doc"\n';
  const [fields] = parseImport(csv, "csv");
  const created = board.addTask("proj", "feature", fields);

  assert.equal(created.dueDate, null);
  assert.equal(created.description, "Migrated from legacy tool see attached spec doc");

  const stored = board.getTask("proj", created.ticketNumber);
  assert.equal(stored.dueDate, null);
  assert.equal(stored.description, "Migrated from legacy tool see attached spec doc");

  // Sanity: the on-disk markdown line itself must not contain a "Due:" marker,
  // since a null dueDate must not be serialized.
  const raw = fs.readFileSync(path.join(board.projectDir("proj"), "featurelist.md"), "utf8");
  assert.equal(/Due:/.test(raw), false);
});

test("end-to-end: importing a legacy CSV row with a valid due date preserves it through addTask", () => {
  const board = makeBoard();
  const csv = 'title,description,due\n"Clean row","Has a real date","2026-10-05"\n';
  const [fields] = parseImport(csv, "csv");
  const created = board.addTask("proj", "bug", fields);

  assert.equal(created.dueDate, "2026-10-05");
  assert.equal(created.description, "Has a real date");

  const stored = board.getTask("proj", created.ticketNumber);
  assert.equal(stored.dueDate, "2026-10-05");

  const raw = fs.readFileSync(path.join(board.projectDir("proj"), "buglist.md"), "utf8");
  assert.match(raw, /Due: 2026-10-05/);
});
