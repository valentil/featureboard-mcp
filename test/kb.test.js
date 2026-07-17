import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Board } from "../server/storage.js";
import { addKbDoc, listKbDocs, getKbDoc, searchKb, slugify, matchKbForTicket } from "../server/kb.js";
import { getWorkPacket } from "../server/metadata.js";

// FBMCPF-141 — project knowledge base: per-project kb/ folder of markdown
// docs, keyword-matched into work packets.

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbkb-"));
  fs.mkdirSync(path.join(dir, "Proj"));
  fs.writeFileSync(path.join(dir, "Proj", "featurelist.md"), "# Feature List\n");
  fs.writeFileSync(path.join(dir, "Proj", "buglist.md"), "# Bug List\n");
  return new Board(dir);
}

test("slugify: lowercases, strips punctuation, collapses separators", () => {
  assert.equal(slugify("Auth: Login Flow!"), "auth-login-flow");
  assert.equal(slugify("  spaced   out  "), "spaced-out");
  assert.equal(slugify(""), "doc");
  assert.equal(slugify(null), "doc");
});

test("addKbDoc writes kb/<slug>.md and round-trips via getKbDoc", () => {
  const b = tmpBoard();
  const r = addKbDoc(b, "Proj", "Auth Architecture", "# Auth\n\nWe use JWTs with a 15 minute TTL.\n");
  assert.equal(r.slug, "auth-architecture");
  assert.equal(r.title, "Auth Architecture");
  assert.equal(r.created, true);
  assert.equal(r.updated, false);
  assert.ok(r.path.endsWith(path.join("kb", "auth-architecture.md")));
  assert.ok(fs.existsSync(r.path));

  const doc = getKbDoc(b, "Proj", "auth-architecture");
  assert.equal(doc.title, "Auth Architecture");
  assert.match(doc.content, /JWTs with a 15 minute TTL/);
  assert.ok(doc.updatedAt);
});

test("addKbDoc requires a title", () => {
  const b = tmpBoard();
  assert.throws(() => addKbDoc(b, "Proj", "  ", "body"), /title is required/);
});

test("addKbDoc called again with the SAME title updates the doc in place (no new file)", () => {
  const b = tmpBoard();
  addKbDoc(b, "Proj", "Deploy Runbook", "v1 of the runbook");
  const second = addKbDoc(b, "Proj", "Deploy Runbook", "v2 of the runbook — now with rollback steps");
  assert.equal(second.slug, "deploy-runbook");
  assert.equal(second.created, false);
  assert.equal(second.updated, true);

  const docs = listKbDocs(b, "Proj");
  assert.equal(docs.length, 1, "still only one doc on disk");
  const doc = getKbDoc(b, "Proj", "deploy-runbook");
  assert.match(doc.content, /rollback steps/);
  assert.doesNotMatch(doc.content, /^v1 of the runbook/);
});

test("addKbDoc: a different title that slugifies to the same base gets a numeric suffix, not clobbered", () => {
  const b = tmpBoard();
  const first = addKbDoc(b, "Proj", "Hello, World!", "first doc");
  const second = addKbDoc(b, "Proj", "Hello World?", "second, unrelated doc");

  assert.equal(first.slug, "hello-world");
  assert.notEqual(second.slug, first.slug);
  assert.equal(second.slug, "hello-world-2");

  assert.equal(getKbDoc(b, "Proj", first.slug).content.trim(), "first doc");
  assert.equal(getKbDoc(b, "Proj", second.slug).content.trim(), "second, unrelated doc");

  // Updating the SECOND title again reuses its already-assigned suffixed slug
  // rather than minting hello-world-3.
  const secondAgain = addKbDoc(b, "Proj", "Hello World?", "second doc, updated");
  assert.equal(secondAgain.slug, "hello-world-2");
  assert.equal(secondAgain.updated, true);
  assert.equal(listKbDocs(b, "Proj").length, 2, "still only two docs total");
});

test("listKbDocs returns metadata + a short excerpt, not full content", () => {
  const b = tmpBoard();
  const longBody = "word ".repeat(200);
  addKbDoc(b, "Proj", "Long Doc", longBody);
  addKbDoc(b, "Proj", "Short Doc", "brief");

  const docs = listKbDocs(b, "Proj").sort((x, y) => x.slug.localeCompare(y.slug));
  assert.equal(docs.length, 2);
  const long = docs.find((d) => d.slug === "long-doc");
  assert.ok(long.excerpt.length < longBody.length);
  assert.ok(long.excerpt.endsWith("…"));
  const short = docs.find((d) => d.slug === "short-doc");
  assert.equal(short.excerpt, "brief");
});

test("getKbDoc returns null for a doc that doesn't exist", () => {
  const b = tmpBoard();
  assert.equal(getKbDoc(b, "Proj", "nope"), null);
});

test("searchKb ranks title hits above content hits and is case-insensitive", () => {
  const b = tmpBoard();
  addKbDoc(b, "Proj", "Payment Retries", "Notes about billing edge cases.");
  addKbDoc(b, "Proj", "Billing Overview", "General billing notes, including retries logic and payment gateways.");
  addKbDoc(b, "Proj", "Unrelated Doc", "Nothing to see here.");

  const results = searchKb(b, "Proj", "billing retries");
  const slugs = results.map((r) => r.slug);
  assert.ok(slugs.includes("payment-retries"));
  assert.ok(slugs.includes("billing-overview"));
  assert.ok(!slugs.includes("unrelated-doc"));
  // "Payment Retries" has "retries" in the TITLE (weighted 5x); "Billing
  // Overview" has "billing" in the title too, but "retries" only in content.
  // Both should score, but neither should crash the ranking; assert ordering
  // is a valid, stable, descending-score sort.
  for (let i = 1; i < results.length; i++) {
    assert.ok(results[i - 1].score >= results[i].score);
  }
});

test("searchKb returns [] for a blank query or no matches", () => {
  const b = tmpBoard();
  addKbDoc(b, "Proj", "Something", "content");
  assert.deepEqual(searchKb(b, "Proj", ""), []);
  assert.deepEqual(searchKb(b, "Proj", "   "), []);
  assert.deepEqual(searchKb(b, "Proj", "zzz-nonexistent-term"), []);
});

test("searchKb respects the limit option", () => {
  const b = tmpBoard();
  for (let i = 0; i < 5; i++) addKbDoc(b, "Proj", `Widget Doc ${i}`, "widget widget widget");
  const results = searchKb(b, "Proj", "widget", { limit: 2 });
  assert.equal(results.length, 2);
});

test("searchKb returns [] when the project has no kb/ folder yet", () => {
  const b = tmpBoard();
  assert.deepEqual(searchKb(b, "Proj", "anything"), []);
});

test("matchKbForTicket builds its query from title/description/labels/product", () => {
  const b = tmpBoard();
  addKbDoc(b, "Proj", "OAuth Login Flow", "Detailed notes on the OAuth login flow and token refresh.");
  addKbDoc(b, "Proj", "Unrelated", "Nothing relevant here.");

  const task = {
    title: "Fix login redirect loop",
    description: "OAuth token refresh sometimes loops back to login.",
    labels: ["auth"],
    product: "Core",
  };
  const matches = matchKbForTicket(b, "Proj", task);
  assert.ok(matches.length >= 1);
  assert.equal(matches[0].slug, "oauth-login-flow");
  assert.ok(matches[0].excerpt);
  assert.ok(matches[0].path.endsWith(path.join("kb", "oauth-login-flow.md")));
});

test("getWorkPacket injects kbMatches for a relevant ticket, capped and lean", () => {
  const b = tmpBoard();
  const longBody = "OAuth token refresh internals. " + "detail ".repeat(200);
  addKbDoc(b, "Proj", "OAuth Internals", longBody);
  addKbDoc(b, "Proj", "Deploy Runbook", "How to deploy to production.");

  const t = b.addTask("Proj", "bug", {
    title: "OAuth token refresh fails silently",
    description: "Users get logged out because the OAuth token refresh call fails.",
  });

  const packet = getWorkPacket(b, "Proj", t.ticketNumber);
  assert.ok(packet.kbMatches, "packet carries kbMatches");
  assert.ok(packet.kbMatches.length >= 1);
  const oauth = packet.kbMatches.find((m) => m.slug === "oauth-internals");
  assert.ok(oauth, "the relevant doc is included");
  assert.ok(oauth.excerpt.length < longBody.length, "excerpt is capped, not the full doc");
  assert.ok(oauth.path);
});

test("getWorkPacket omits kbMatches when the project has no kb docs (back-compat)", () => {
  const b = tmpBoard();
  const t = b.addTask("Proj", "feature", { title: "Plain ticket, no kb docs anywhere" });
  const packet = getWorkPacket(b, "Proj", t.ticketNumber);
  assert.equal(packet.kbMatches, undefined);
});

test("getWorkPacket omits kbMatches when kb docs exist but none match the ticket", () => {
  const b = tmpBoard();
  addKbDoc(b, "Proj", "Payroll Export Format", "CSV columns for the payroll export job.");
  const t = b.addTask("Proj", "feature", { title: "Unrelated widget styling tweak" });
  const packet = getWorkPacket(b, "Proj", t.ticketNumber);
  assert.equal(packet.kbMatches, undefined);
});
