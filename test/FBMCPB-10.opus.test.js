// FBMCPB-10 regression suite.
//
// Ticket: add_feature / log_bug / import_tasks must validate dueDate as
// YYYY-MM-DD. Legacy tickets carried prose descriptions in their `due` field,
// which breaks date sorting / range filters in the board and analytics. Junk
// due values must be REMAPPED to the description on the add / import paths
// (data preserving), and REJECTED (thrown) on the explicit update path — never
// silently stored, so no non-date string can ever reach a dueDate field.
//
// Code under test: server/storage.js — normalizeDueDate() and every consumer:
// addTask, updateTask, and normalizeImported/parseImport.
//
// Flat top-level test() calls only; each board test builds its own throwaway
// workspace under os.tmpdir(). No node_modules, deterministic, fast.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Board, normalizeDueDate, DUE_DATE_RE, parseImport } from "../server/storage.js";

// A syntactically well-formed calendar date used across the happy paths.
const GOOD = "2026-07-14";
// Legacy prose junk — deliberately contains no ':', '|', '[', ']' or the token
// "Summary", so it survives a markdown serialize/re-parse round-trip verbatim
// and we can assert exact data preservation.
const JUNK = "sometime around the Q3 demo ask Dana";

function freshBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbmcpb10-"));
  const board = new Board(dir);
  board.createProject("Proj");
  return { board, dir, project: "Proj" };
}

function featureFile(dir, project) {
  return fs.readFileSync(path.join(dir, project, "featurelist.md"), "utf8");
}

// ---------------------------------------------------------------------------
// normalizeDueDate — the single validator every path funnels through
// ---------------------------------------------------------------------------

test("normalizeDueDate: null/undefined/empty clear the field with no overflow", () => {
  for (const v of [null, undefined, ""]) {
    const r = normalizeDueDate(v);
    assert.deepEqual(r, { dueDate: null }, `input ${JSON.stringify(v)}`);
    // The absence of an `overflow` key is load-bearing: consumers branch on
    // `due.overflow` to decide remap-vs-reject, so an empty due must not carry
    // a remap payload.
    assert.ok(!("overflow" in r), "empty input must not produce an overflow key");
  }
});

test("normalizeDueDate: a valid YYYY-MM-DD passes through unchanged, no overflow", () => {
  const r = normalizeDueDate(GOOD);
  assert.deepEqual(r, { dueDate: GOOD });
  assert.ok(!("overflow" in r));
});

test("normalizeDueDate: surrounding whitespace is trimmed off a valid date", () => {
  assert.deepEqual(normalizeDueDate("   2026-07-14 \t"), { dueDate: GOOD });
});

test("normalizeDueDate: junk is rejected as a date and preserved verbatim in overflow", () => {
  const r = normalizeDueDate("  " + JUNK + "  ");
  assert.equal(r.dueDate, null, "junk must not become a dueDate");
  assert.equal(r.overflow, JUNK, "overflow must be the trimmed original prose, byte-for-byte");
});

test("normalizeDueDate: format validation is strict on digit counts and anchoring", () => {
  // Each of these is close-but-wrong and must land in overflow, not dueDate.
  const bad = [
    "2026-7-14", // 1-digit month
    "2026-07-4", // 1-digit day
    "999-07-14", // 3-digit year
    "26-07-14", // 2-digit year
    "2026/07/14", // wrong separator
    "2026-07-14x", // trailing junk (end anchor)
    "x2026-07-14", // leading junk (start anchor)
    "2026-07-14T00:00:00", // ISO datetime, not a bare date
    "2026-07-14 is the target", // date embedded in prose
    20260714, // non-string coerced via String(), still not YYYY-MM-DD
  ];
  for (const v of bad) {
    const r = normalizeDueDate(v);
    assert.equal(r.dueDate, null, `expected reject for ${JSON.stringify(v)}`);
    assert.equal(r.overflow, String(v).trim(), `overflow should mirror input for ${JSON.stringify(v)}`);
  }
});

test("DUE_DATE_RE only matches a bare, fully-zero-padded YYYY-MM-DD", () => {
  assert.equal(DUE_DATE_RE.test("2026-07-14"), true);
  assert.equal(DUE_DATE_RE.test("0001-01-01"), true);
  assert.equal(DUE_DATE_RE.test("2026-7-14"), false);
  assert.equal(DUE_DATE_RE.test(" 2026-07-14"), false);
  assert.equal(DUE_DATE_RE.test("2026-07-14 "), false);
  assert.equal(DUE_DATE_RE.test(""), false);
});

test("normalizeDueDate: validation is structural (format), not calendrical", () => {
  // Documents the current contract precisely: an impossible calendar date that
  // is still well-formed as YYYY-MM-DD is accepted. This pins the boundary so a
  // change to the validator (tightening OR loosening) is caught by a test.
  assert.deepEqual(normalizeDueDate("2026-13-40"), { dueDate: "2026-13-40" });
  assert.deepEqual(normalizeDueDate("2026-02-30"), { dueDate: "2026-02-30" });
});

test("addTask: a valid dueDate is stored and serialized with a Due: token", () => {
  const { board, dir, project } = freshBoard();
  const t = board.addTask(project, "feature", { title: "Ship it", dueDate: GOOD });
  assert.equal(t.dueDate, GOOD);
  const md = featureFile(dir, project);
  assert.match(md, /\| Due: 2026-07-14\]/, "markdown must carry the Due: token");
  // round-trips through parseMarkdown on re-read
  const back = board.getTask(project, t.ticketNumber);
  assert.equal(back.dueDate, GOOD);
});

test("addTask: junk dueDate is remapped to description; no dueDate stored", () => {
  const { board, dir, project } = freshBoard();
  const t = board.addTask(project, "feature", { title: "Legacy import", dueDate: JUNK });
  assert.equal(t.dueDate, null, "junk must not be stored as a date");
  assert.equal(t.description, JUNK, "prose must be preserved in the description");
  // No Due: token should be serialized for a null dueDate.
  const md = featureFile(dir, project);
  assert.ok(!/Due:/.test(md), "no Due: token should appear for a remapped junk due");
  // survives a full markdown round-trip
  const back = board.getTask(project, t.ticketNumber);
  assert.equal(back.dueDate, null);
  assert.equal(back.description, JUNK);
});

test("addTask: junk dueDate appends to an EXISTING description, preserving both", () => {
  const { board, project } = freshBoard();
  const t = board.addTask(project, "feature", {
    title: "Legacy import",
    description: "Refactor the parser",
    dueDate: JUNK,
  });
  assert.equal(t.dueDate, null);
  assert.equal(t.description, `Refactor the parser ${JUNK}`, "existing desc + space + prose");
  const back = board.getTask(project, t.ticketNumber);
  assert.equal(back.description, `Refactor the parser ${JUNK}`);
});

test("addTask: the due field only affects dueDate, not other fields", () => {
  const { board, project } = freshBoard();
  const t = board.addTask(project, "bug", { title: "Crash on save", dueDate: GOOD, product: "Core" });
  assert.equal(t.dueDate, GOOD);
  assert.equal(t.product, "Core");
  assert.equal(t.description, ""); // untouched — valid due does not spill into description
});

test("updateTask: a valid dueDate change persists to disk", () => {
  const { board, project } = freshBoard();
  const t = board.addTask(project, "feature", { title: "Plan work", dueDate: GOOD });
  board.updateTask(project, t.ticketNumber, { dueDate: "2026-08-01" });
  assert.equal(board.getTask(project, t.ticketNumber).dueDate, "2026-08-01");
});

test("updateTask: dueDate:null clears the field", () => {
  const { board, project } = freshBoard();
  const t = board.addTask(project, "feature", { title: "Plan work", dueDate: GOOD });
  board.updateTask(project, t.ticketNumber, { dueDate: null });
  assert.equal(board.getTask(project, t.ticketNumber).dueDate, null);
});

test("updateTask: junk dueDate THROWS and mutates nothing on disk (reject, not remap)", () => {
  const { board, dir, project } = freshBoard();
  const t = board.addTask(project, "feature", {
    title: "Plan work",
    description: "Original scope note",
    dueDate: GOOD,
  });
  const before = featureFile(dir, project);
  assert.throws(
    () => board.updateTask(project, t.ticketNumber, { dueDate: JUNK }),
    (err) => {
      assert.match(err.message, /Invalid dueDate/);
      assert.match(err.message, /YYYY-MM-DD/);
      return true;
    }
  );
  // The whole line must be byte-identical: a rejected update must not append
  // the prose to the description the way the add path does, and must not clear
  // or corrupt the existing valid dueDate.
  assert.equal(featureFile(dir, project), before, "file must be untouched after a rejected update");
  const back = board.getTask(project, t.ticketNumber);
  assert.equal(back.dueDate, GOOD, "existing valid dueDate preserved");
  assert.equal(back.description, "Original scope note", "description NOT remapped on the update path");
});

test("updateTask: omitting dueDate leaves the existing value untouched", () => {
  const { board, project } = freshBoard();
  const t = board.addTask(project, "feature", { title: "Plan work", dueDate: GOOD });
  board.updateTask(project, t.ticketNumber, { title: "Plan the work" });
  const back = board.getTask(project, t.ticketNumber);
  assert.equal(back.title, "Plan the work");
  assert.equal(back.dueDate, GOOD, "dueDate must survive an unrelated field update");
});

test("parseImport JSON: legacy due prose is remapped to description; valid dueDate kept", () => {
  const json = JSON.stringify([
    { title: "Legacy A", due: JUNK },
    { title: "Fresh B", dueDate: GOOD },
  ]);
  const [a, b] = parseImport(json, "json");
  assert.equal(a.dueDate, undefined, "junk legacy due must not survive as a date");
  assert.equal(a.description, JUNK, "junk prose remapped into description");
  assert.equal(b.dueDate, GOOD, "valid dueDate preserved");
});

test("parseImport JSON: junk due appends to an existing description (data preservation)", () => {
  const json = JSON.stringify([{ title: "Legacy", description: "Port the widget", due: JUNK }]);
  const [t] = parseImport(json, "json");
  assert.equal(t.dueDate, undefined);
  assert.equal(t.description, `Port the widget ${JUNK}`);
});

test("parseImport CSV: junk in a due column is remapped; a valid due column is kept", () => {
  const csv =
    "title,due,description\n" +
    `Ship it,${JUNK},Existing note\n` +
    "Do later,2026-09-09,Second note\n";
  const rows = parseImport(csv, "csv");
  const shipIt = rows.find((r) => r.title === "Ship it");
  const doLater = rows.find((r) => r.title === "Do later");
  assert.equal(shipIt.dueDate, undefined);
  assert.equal(shipIt.description, `Existing note ${JUNK}`);
  assert.equal(doLater.dueDate, "2026-09-09");
  assert.equal(doLater.description, "Second note");
});

test("parseImport: no imported task ever carries a non-date dueDate (sort/filter integrity)", () => {
  // A mixed legacy backlog: valid dates, prose junk, and a datetime string.
  const json = JSON.stringify([
    { title: "A", dueDate: "2026-03-01" },
    { title: "B", due: "early next quarter, whenever planning wraps" },
    { title: "C", dueDate: "2026-01-15" },
    { title: "D", dueDate: "2026-01-15T09:00:00" },
  ]);
  const rows = parseImport(json, "json");

  // Invariant that makes date sorting / range filters safe downstream: every
  // dueDate is either absent or a canonical YYYY-MM-DD — never prose.
  for (const r of rows) {
    assert.ok(
      r.dueDate === undefined || DUE_DATE_RE.test(r.dueDate),
      `dueDate must be absent or canonical, got ${JSON.stringify(r.dueDate)} for ${r.title}`
    );
  }

  // The junk-due rows fell back to no date and kept their prose as description.
  const b = rows.find((r) => r.title === "B");
  assert.equal(b.dueDate, undefined);
  assert.equal(b.description, "early next quarter, whenever planning wraps");
  const d = rows.find((r) => r.title === "D");
  assert.equal(d.dueDate, undefined, "an ISO datetime is not a bare date and must not be stored as one");

  // The surviving dates sort lexically == chronologically, uncontaminated by junk.
  const dates = rows.map((r) => r.dueDate).filter(Boolean);
  assert.deepEqual(dates.slice().sort(), ["2026-01-15", "2026-03-01"]);
});
