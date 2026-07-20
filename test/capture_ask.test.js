import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Board } from "../server/storage.js";
import { setProjectConfig } from "../server/metadata.js";
import { captureAsk, askLabel } from "../server/feedback.js";

// FBMCPF-216 — capture_ask: paste-to-structure external requests.

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbask-"));
  fs.mkdirSync(path.join(dir, "Proj"));
  fs.writeFileSync(path.join(dir, "Proj", "featurelist.md"), "# Feature List\n");
  fs.writeFileSync(path.join(dir, "Proj", "buglist.md"), "# Bug List\n");
  const b = new Board(dir);
  setProjectConfig(b, "Proj", { products: ["Analytics", "CRM"] });
  return b;
}

test("askLabel slugs weird sources", () => {
  assert.equal(askLabel("Slack #general"), "ask:slack-general");
  assert.equal(askLabel(""), "ask:external");
});

test("bug-flavored ask becomes a bug with source label, from header, and model/cap labels", () => {
  const b = tmpBoard();
  const r = captureAsk(b, "Proj", {
    source: "slack",
    from: "@maria",
    text: "The Analytics export is broken — it crashes every time I click download. Urgent!",
  });
  assert.equal(r.type, "bug");
  const t = b.getTask("Proj", r.ticketNumber);
  assert.ok(t.labels.includes("ask:slack"));
  assert.ok(t.labels.some((l) => l.startsWith("model:")));
  assert.ok(t.labels.some((l) => l.startsWith("cap:")));
  assert.equal(t.product, "Analytics");
  assert.equal(t.priority, 1);
  assert.match(t.description, /Source: slack/);
  assert.match(t.description, /From: @maria/);
});

test("plain request becomes a feature; empty text throws", () => {
  const b = tmpBoard();
  const r = captureAsk(b, "Proj", { source: "email", text: "Could we get a weekly summary view for the CRM pipeline?" });
  assert.equal(r.type, "feature");
  assert.equal(r.ask.source, "email");
  assert.throws(() => captureAsk(b, "Proj", { source: "email", text: "  " }), /text is required/);
});
