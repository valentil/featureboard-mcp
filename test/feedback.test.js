import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Board } from "../server/storage.js";
import {
  splitFeedbackItems,
  classifyFeedback,
  suggestPriority,
  suggestProduct,
  parseFeedback,
  createFeedbackTickets,
} from "../server/feedback.js";

// FBMCPF-140 — validate_feedback: raw feedback -> structured candidate tickets.

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-feedback-"));
  fs.mkdirSync(path.join(dir, "Proj"));
  fs.writeFileSync(path.join(dir, "Proj", "featurelist.md"), "# Feature List\n");
  fs.writeFileSync(path.join(dir, "Proj", "buglist.md"), "# Bug List\n");
  return new Board(dir);
}

// ---------------------------------------------------------------------------
// splitFeedbackItems
// ---------------------------------------------------------------------------

test("splitFeedbackItems: splits on '-' bullets", () => {
  const items = splitFeedbackItems(
    "- First item here.\n- Second item here.\n- Third item here."
  );
  assert.deepEqual(items, ["First item here.", "Second item here.", "Third item here."]);
});

test("splitFeedbackItems: splits on numbered items and merges continuation lines", () => {
  const items = splitFeedbackItems(
    "1. The export button\ncrashes on click.\n2. Add a dark mode toggle."
  );
  assert.deepEqual(items, [
    "The export button crashes on click.",
    "Add a dark mode toggle.",
  ]);
});

test("splitFeedbackItems: falls back to blank-line paragraphs when there are no markers", () => {
  const items = splitFeedbackItems(
    "The login page is broken on Safari.\n\nIt would be great to support SSO."
  );
  assert.deepEqual(items, [
    "The login page is broken on Safari.",
    "It would be great to support SSO.",
  ]);
});

test("splitFeedbackItems: whole text is one item with no markers and no blank lines", () => {
  const items = splitFeedbackItems("Just a single unstructured note about the app.");
  assert.deepEqual(items, ["Just a single unstructured note about the app."]);
});

test("splitFeedbackItems: preamble before the first marker is dropped", () => {
  const items = splitFeedbackItems(
    "Notes from the customer call:\n- Payments fail intermittently.\n- Please add CSV export."
  );
  assert.deepEqual(items, ["Payments fail intermittently.", "Please add CSV export."]);
});

test("splitFeedbackItems: empty/whitespace input yields no items", () => {
  assert.deepEqual(splitFeedbackItems(""), []);
  assert.deepEqual(splitFeedbackItems("   \n  \n "), []);
});

// ---------------------------------------------------------------------------
// classifyFeedback
// ---------------------------------------------------------------------------

test("classifyFeedback: bug keywords win", () => {
  const r = classifyFeedback("The app crashes and shows an error every time I export.");
  assert.equal(r.type, "bug");
  assert.ok(r.matchedBugKeywords.includes("crashes"));
  assert.ok(r.matchedBugKeywords.includes("error"));
});

test("classifyFeedback: feature keywords", () => {
  const r = classifyFeedback("Would be nice to add support for dark mode.");
  assert.equal(r.type, "feature");
  assert.ok(r.matchedFeatureKeywords.length > 0);
});

test("classifyFeedback: no signal defaults to feature", () => {
  const r = classifyFeedback("The onboarding flow feels a bit long.");
  assert.equal(r.type, "feature");
  assert.deepEqual(r.matchedBugKeywords, []);
});

test("classifyFeedback: ties go to bug", () => {
  // one bug word ("broken"), one feature phrase ("consider adding") -> bug wins the tie
  const r = classifyFeedback("The button is broken; consider adding a fallback.");
  assert.equal(r.type, "bug");
  assert.deepEqual(r.matchedBugKeywords, ["broken"]);
  assert.deepEqual(r.matchedFeatureKeywords, ["consider adding"]);
});

test("classifyFeedback: word-boundary matching avoids false positives", () => {
  // "address" contains "add" as a substring but must not match the "add" keyword
  const r = classifyFeedback("Please update the address field validation.");
  assert.deepEqual(r.matchedFeatureKeywords, []);
});

// ---------------------------------------------------------------------------
// suggestPriority
// ---------------------------------------------------------------------------

test("suggestPriority: explicit urgent/critical/P1 cues -> priority 1", () => {
  assert.equal(suggestPriority("This is urgent, please fix ASAP.").priority, 1);
  assert.equal(suggestPriority("Critical issue in prod.").priority, 1);
  assert.equal(suggestPriority("Marked as P1 by support.").priority, 1);
  assert.equal(suggestPriority("This is a blocker for launch.").priority, 1);
});

test("suggestPriority: no cue -> null", () => {
  const r = suggestPriority("Just a minor cosmetic nit.");
  assert.equal(r.priority, null);
  assert.deepEqual(r.matchedKeywords, []);
});

// ---------------------------------------------------------------------------
// suggestProduct
// ---------------------------------------------------------------------------

test("suggestProduct: matches a configured product name in the text", () => {
  const r = suggestProduct("The Mobile App keeps crashing on launch.", ["Mobile App", "Web Dashboard"]);
  assert.equal(r.product, "Mobile App");
});

test("suggestProduct: longer product name wins over a shorter overlapping one", () => {
  const r = suggestProduct("Issue in the Web Dashboard Pro tier.", ["Web Dashboard", "Web Dashboard Pro"]);
  assert.equal(r.product, "Web Dashboard Pro");
});

test("suggestProduct: no match -> null", () => {
  const r = suggestProduct("General feedback about the onboarding.", ["Mobile App", "Web Dashboard"]);
  assert.equal(r.product, null);
});

test("suggestProduct: empty product list -> null", () => {
  assert.equal(suggestProduct("Anything here", []).product, null);
  assert.equal(suggestProduct("Anything here", undefined).product, null);
});

// ---------------------------------------------------------------------------
// parseFeedback (end to end candidate shape)
// ---------------------------------------------------------------------------

test("parseFeedback: produces editable candidates with title/type/product/priority", () => {
  const raw = [
    "- The Mobile App crashes when exporting, gives a 500 error. URGENT!",
    "- Would be nice to add CSV export support to Web Dashboard.",
    "- The onboarding copy is a little confusing.",
  ].join("\n");
  const candidates = parseFeedback(raw, ["Mobile App", "Web Dashboard"]);
  assert.equal(candidates.length, 3);

  assert.equal(candidates[0].type, "bug");
  assert.equal(candidates[0].product, "Mobile App");
  assert.equal(candidates[0].priority, 1);
  assert.match(candidates[0].title, /crashes/);
  assert.ok(candidates[0].signals.bugKeywords.length > 0);

  assert.equal(candidates[1].type, "feature");
  assert.equal(candidates[1].product, "Web Dashboard");
  assert.equal(candidates[1].priority, null);

  assert.equal(candidates[2].type, "feature");
  assert.equal(candidates[2].product, null);
  assert.equal(candidates[2].priority, null);
});

test("parseFeedback: title is capped and derived from the first sentence", () => {
  const longSentence =
    "This is a very long piece of feedback that goes on and on about many different aspects of the product experience and should be truncated for the title.";
  const candidates = parseFeedback(`- ${longSentence}`, []);
  assert.equal(candidates.length, 1);
  assert.ok(candidates[0].title.length <= 91); // maxLen 90 + ellipsis
  assert.equal(candidates[0].description, longSentence);
});

// ---------------------------------------------------------------------------
// createFeedbackTickets (apply mode) — dry-run creates nothing, apply creates
// ---------------------------------------------------------------------------

test("dry-run (parseFeedback alone) creates nothing on the board", () => {
  const b = tmpBoard();
  const raw = "- The app crashes on launch.\n- Please add dark mode.";
  parseFeedback(raw, []);
  const tasks = b.listTasks("Proj", {});
  assert.equal(tasks.length, 0, "parseFeedback must not touch the board");
});

test("createFeedbackTickets: bulk-creates candidates as bug/feature tickets", () => {
  const b = tmpBoard();
  const raw = [
    "- The Mobile App crashes when exporting. URGENT!",
    "- Would be nice to add CSV export to Web Dashboard.",
  ].join("\n");
  const candidates = parseFeedback(raw, ["Mobile App", "Web Dashboard"]);
  const created = createFeedbackTickets(b, "Proj", candidates);

  assert.equal(created.length, 2);
  assert.equal(created[0].type, "bug");
  assert.equal(created[0].product, "Mobile App");
  assert.equal(created[0].priority, 1);
  assert.match(created[0].ticketNumber, /-\d+$/);

  assert.equal(created[1].type, "feature");
  assert.equal(created[1].product, "Web Dashboard");
  assert.match(created[1].ticketNumber, /-\d+$/);
  assert.notEqual(created[0].ticketNumber, created[1].ticketNumber);

  const tasks = b.listTasks("Proj", {});
  assert.equal(tasks.length, 2);
});

test("createFeedbackTickets: an edited candidates array (overridden fields) is respected", () => {
  const b = tmpBoard();
  const candidates = parseFeedback("- The button is broken.", ["Mobile App"]);
  // caller reviewed the dry-run output and corrected the suggestions
  candidates[0].type = "feature";
  candidates[0].product = "Mobile App";
  candidates[0].priority = 2;
  candidates[0].title = "Rework the broken button into a toggle";

  const created = createFeedbackTickets(b, "Proj", candidates);
  assert.equal(created.length, 1);
  assert.equal(created[0].type, "feature");
  assert.equal(created[0].product, "Mobile App");
  assert.equal(created[0].priority, 2);
  assert.equal(created[0].title, "Rework the broken button into a toggle");
});

test("createFeedbackTickets: rejects a candidate missing a title without creating a partial batch", () => {
  const b = tmpBoard();
  const candidates = [
    { title: "Good one", type: "feature" },
    { title: "", type: "bug" },
  ];
  assert.throws(() => createFeedbackTickets(b, "Proj", candidates), /missing a title/);
  assert.equal(b.listTasks("Proj", {}).length, 0, "no partial writes on validation failure");
});
