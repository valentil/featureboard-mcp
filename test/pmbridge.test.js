import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Board, parseImport } from "../server/storage.js";
import { detectPmFormat, parsePmImport, exportBoard } from "../server/pmbridge.js";

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-pmbridge-"));
  fs.mkdirSync(path.join(dir, "Proj"));
  fs.writeFileSync(path.join(dir, "Proj", "featurelist.md"), "# Feature List\n");
  fs.writeFileSync(path.join(dir, "Proj", "buglist.md"), "# Bug List\n");
  return new Board(dir);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const LINEAR_CSV = [
  "ID,Team,Title,Description,Status,Priority,Labels,Type",
  'LIN-101,Core,Login page,Simple login form,Todo,Medium,"auth,ui",Feature',
  'LIN-102,Core,Payment retry,"Retry billing, then notify user",Done,Low,billing,Feature',
  "LIN-103,Core,Crash on boot,App crashes on start,Todo,Urgent,crash,Bug",
  "LIN-104,Core,Docs update,Update readme,In Review,Low,,Feature",
  "LIN-105,Core,Random status,Something backlog,Backlog,,misc,",
].join("\n");

const JIRA_CSV = [
  "Issue key,Summary,Description,Issue Type,Status,Priority,Labels",
  "PROJ-1,Set up CI,Configure the pipeline,Task,To Do,Medium,ci",
  'PROJ-2,Export bug,"Export crashes, no error shown",Bug,In Progress,Urgent,export;urgent',
  "PROJ-3,Review flow,Add review step,Story,In Review,Low,flow",
  "PROJ-4,Old ticket,Legacy,Task,Done,3,",
  "PROJ-5,Backlog item,,Bug,Backlog,,misc",
].join("\n");

const GENERIC_CSV = ["Name,Owner,Notes", "Widget,Alice,Some notes"].join("\n");

// ---------------------------------------------------------------------------
// detectPmFormat
// ---------------------------------------------------------------------------

test("detectPmFormat: Linear / Jira / generic", () => {
  assert.equal(detectPmFormat(LINEAR_CSV), "linear-csv");
  assert.equal(detectPmFormat(JIRA_CSV), "jira-csv");
  assert.equal(detectPmFormat(GENERIC_CSV), "generic");
  assert.equal(detectPmFormat(""), "generic");
});

// ---------------------------------------------------------------------------
// parsePmImport — Linear
// ---------------------------------------------------------------------------

test("parsePmImport: Linear CSV maps ref/title/description/status/priority/labels/type", () => {
  const tasks = parsePmImport(LINEAR_CSV);
  assert.equal(tasks.length, 5);

  const [row1, row2, row3, row4, row5] = tasks;

  // Todo passthrough
  assert.equal(row1.ref, "LIN-101");
  assert.equal(row1.title, "Login page");
  assert.equal(row1.description, "Simple login form");
  assert.equal(row1.status, "Todo");
  assert.equal(row1.priority, 3); // Medium
  assert.deepEqual(row1.labels, ["auth", "ui"]);

  // quoted-comma description + Done status + Low priority
  assert.equal(row2.title, "Payment retry");
  assert.equal(row2.description, "Retry billing, then notify user");
  assert.equal(row2.status, "Done");
  assert.equal(row2.priority, 4);

  // Urgent bug
  assert.equal(row3.status, "Todo");
  assert.equal(row3.priority, 1);
  assert.equal(row3.type, "bug");

  // In Review
  assert.equal(row4.status, "Review");
  assert.equal(row4.labels, undefined);

  // Backlog (unrecognized) falls back to Todo; blank priority stays unset
  assert.equal(row5.status, "Todo");
  assert.equal(row5.priority, undefined);
  assert.deepEqual(row5.labels, ["misc"]);
});

// ---------------------------------------------------------------------------
// parsePmImport — Jira
// ---------------------------------------------------------------------------

test("parsePmImport: Jira CSV maps issue key/summary/status/priority/labels/type", () => {
  const tasks = parsePmImport(JIRA_CSV);
  assert.equal(tasks.length, 5);

  const [row1, row2, row3, row4, row5] = tasks;

  assert.equal(row1.ref, "PROJ-1");
  assert.equal(row1.title, "Set up CI");
  assert.equal(row1.status, "Todo"); // "To Do" -> Todo
  assert.equal(row1.priority, 3); // Medium
  assert.equal(row1.type, "feature"); // Task -> not bug -> feature

  // quoted-comma description + Bug + Urgent + In Progress
  assert.equal(row2.description, "Export crashes, no error shown");
  assert.equal(row2.status, "In Progress");
  assert.equal(row2.priority, 1);
  assert.equal(row2.type, "bug");
  assert.deepEqual(row2.labels, ["export", "urgent"]);

  assert.equal(row3.status, "Review");
  assert.equal(row3.type, "feature");

  // numeric priority passes through
  assert.equal(row4.status, "Done");
  assert.equal(row4.priority, 3);

  // Backlog -> Todo, Bug type, no priority
  assert.equal(row5.status, "Todo");
  assert.equal(row5.type, "bug");
  assert.equal(row5.priority, undefined);
});

test("parsePmImport: empty content returns []", () => {
  assert.deepEqual(parsePmImport(""), []);
  assert.deepEqual(parsePmImport("   \n  "), []);
});

// ---------------------------------------------------------------------------
// exportBoard
// ---------------------------------------------------------------------------

function seedBoard() {
  const b = tmpBoard();
  const f1 = b.addTask("Proj", "feature", {
    title: "Ticket One",
    description: "First ticket",
    status: "Todo",
    priority: 2,
    labels: ["alpha", "beta"],
  });
  const f2 = b.addTask("Proj", "bug", {
    title: "Ticket Two, with a comma",
    description: "Second ticket",
    status: "Done",
    priority: 1,
    labels: ["gamma"],
  });
  b.setStatus("Proj", f2.ticketNumber, "Done", "fixed it");
  return { b, f1, f2 };
}

test("exportBoard: json shape", () => {
  const { b, f1, f2 } = seedBoard();
  const out = exportBoard(b, "Proj", "json");
  const rows = JSON.parse(out);
  assert.equal(rows.length, 2);
  const byTicket = Object.fromEntries(rows.map((r) => [r.ticket, r]));
  assert.equal(byTicket[f1.ticketNumber].title, "Ticket One");
  assert.equal(byTicket[f1.ticketNumber].status, "Todo");
  assert.equal(byTicket[f1.ticketNumber].priority, 2);
  assert.deepEqual(byTicket[f1.ticketNumber].labels, ["alpha", "beta"]);
  assert.equal(byTicket[f2.ticketNumber].status, "Done");
  assert.equal(byTicket[f2.ticketNumber].type, "bug");
  // full column set present
  for (const key of ["ticket", "title", "description", "status", "type", "product", "priority", "labels", "dueDate", "created", "completed", "ref", "linkedIssue"]) {
    assert.ok(key in rows[0], `missing column ${key}`);
  }
});

test("exportBoard: csv shape + quoting", () => {
  const { b } = seedBoard();
  const out = exportBoard(b, "Proj", "csv");
  const lines = out.trim().split("\n");
  assert.equal(lines[0], "ticket,title,description,status,type,product,priority,labels,dueDate,created,completed,ref,linkedIssue");
  assert.equal(lines.length, 3); // header + 2 rows
  // the comma-containing title must be quoted
  assert.ok(lines.some((l) => l.includes('"Ticket Two, with a comma"')));
});

test("exportBoard: markdown grouped checklist", () => {
  const { b } = seedBoard();
  const out = exportBoard(b, "Proj", "markdown");
  assert.match(out, /^## Todo/m);
  assert.match(out, /## Done/);
  assert.match(out, /- \[ \] \[.+\] Ticket One/);
  assert.match(out, /- \[x\] \[.+\] Ticket Two, with a comma/);
});

test("exportBoard: unknown format throws; unknown project throws", () => {
  const { b } = seedBoard();
  assert.throws(() => exportBoard(b, "Proj", "xml"), /Unknown export format/);
  assert.throws(() => exportBoard(b, "Nope", "json"), /not found/);
});

// ---------------------------------------------------------------------------
// Round-trip: exportBoard -> storage.parseImport preserves title/status/
// priority/labels for csv and json.
// ---------------------------------------------------------------------------

test("round-trip: csv export re-imports with title/status/priority/labels intact", () => {
  const { b, f1, f2 } = seedBoard();
  const csv = exportBoard(b, "Proj", "csv");
  const reimported = parseImport(csv, "csv");
  assert.equal(reimported.length, 2);

  const one = reimported.find((t) => t.title === "Ticket One");
  assert.ok(one);
  assert.equal(one.status, "Todo");
  assert.equal(one.priority, 2);
  assert.deepEqual(one.labels, ["alpha", "beta"]);

  const two = reimported.find((t) => t.title === "Ticket Two, with a comma");
  assert.ok(two);
  assert.equal(two.status, "Done");
  assert.equal(two.priority, 1);
  assert.deepEqual(two.labels, ["gamma"]);
});

test("round-trip: json export re-imports with title/status/priority/labels intact", () => {
  const { b } = seedBoard();
  const json = exportBoard(b, "Proj", "json");
  const reimported = parseImport(json, "json");
  assert.equal(reimported.length, 2);

  const one = reimported.find((t) => t.title === "Ticket One");
  assert.equal(one.status, "Todo");
  assert.equal(one.priority, 2);
  assert.deepEqual(one.labels, ["alpha", "beta"]);

  const two = reimported.find((t) => t.title === "Ticket Two, with a comma");
  assert.equal(two.status, "Done");
  assert.equal(two.priority, 1);
  assert.deepEqual(two.labels, ["gamma"]);
});
