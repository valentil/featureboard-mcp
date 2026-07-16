import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Board } from "../server/storage.js";
import { slackConfigured, formatTicketEvent, notifySlack, notifyTicketEvent, DEFAULT_SLACK_EVENTS } from "../server/slack.js";

const WEBHOOK = "https://hooks.slack.com/services/T000/B000/xxxxYYYYzzzz";

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-"));
  fs.mkdirSync(path.join(dir, "Proj"));
  fs.writeFileSync(path.join(dir, "Proj", "featurelist.md"), "# Feature List\n");
  fs.writeFileSync(path.join(dir, "Proj", "buglist.md"), "# Bug List\n");
  return new Board(dir);
}

// slackWebhook/slackEvents aren't in CONFIG_KEYS until the orchestrator adds them, so
// setProjectConfig would filter them out. Write the managed config file directly — the
// same file getSlackConfig reads from — to configure Slack in tests.
function configureSlack(board, project, patch) {
  const p = path.join(board.projectDir(project), ".featureboard.config.json");
  fs.writeFileSync(p, JSON.stringify(patch, null, 2));
}

// A fetch stub factory: records the call and returns a chosen response (or throws).
function stubFetch({ ok = true, status = 200, throwErr = null } = {}) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, opts });
    if (throwErr) throw throwErr;
    return { ok, status };
  };
  impl.calls = calls;
  return impl;
}

test("slackConfigured accepts https hooks.slack.com and rejects everything else", () => {
  assert.equal(slackConfigured({ slackWebhook: WEBHOOK }), true);
  assert.equal(slackConfigured({ slackWebhook: "https://hooks.slack.com/services/x" }), true);
  // host validation prevents arbitrary egress
  assert.equal(slackConfigured({ slackWebhook: "https://evil.example.com/services/x" }), false);
  assert.equal(slackConfigured({ slackWebhook: "https://hooks.slack.com.evil.com/x" }), false);
  // http rejected
  assert.equal(slackConfigured({ slackWebhook: "http://hooks.slack.com/services/x" }), false);
  // junk / empty / missing
  assert.equal(slackConfigured({ slackWebhook: "not a url" }), false);
  assert.equal(slackConfigured({ slackWebhook: "" }), false);
  assert.equal(slackConfigured({}), false);
  assert.equal(slackConfigured(null), false);
  assert.equal(slackConfigured({ slackWebhook: 123 }), false);
});

test("formatTicketEvent shapes done/review/summary text", () => {
  const done = formatTicketEvent("done", { ticketNumber: "FBF-12", title: "Title" }, "Proj");
  assert.equal(done, "✅ *FBF-12* Title — Done (Proj)");
  // done with a completion summary appends a quoted line
  const doneSum = formatTicketEvent("done", { ticketNumber: "FBF-12", title: "Title", completionSummary: "Shipped it" }, "Proj");
  assert.ok(doneSum.startsWith("✅ *FBF-12* Title — Done (Proj)"));
  assert.ok(doneSum.includes("\n> Shipped it"));
  // review
  const review = formatTicketEvent("review", { ticketNumber: "FBF-12", title: "Title" }, "Proj");
  assert.equal(review, "👀 *FBF-12* Title — ready for review (Proj)");
  // fallback for other events still returns usable text
  const other = formatTicketEvent("summary", { ticketNumber: "FBF-9", title: "T" }, "Proj");
  assert.ok(other.includes("*FBF-9* T"));
  assert.ok(other.includes("(Proj)"));
});

test("notifySlack returns sent:false with a reason when unconfigured (no fetch call)", async () => {
  const b = tmpBoard();
  const impl = stubFetch();
  const r = await notifySlack(b, "Proj", { text: "hi", event: "done", fetchImpl: impl });
  assert.equal(r.sent, false);
  assert.match(r.reason, /not configured/i);
  assert.equal(impl.calls.length, 0);
});

test("notifySlack filters events not in slackEvents (no fetch call)", async () => {
  const b = tmpBoard();
  configureSlack(b, "Proj", { slackWebhook: WEBHOOK, slackEvents: ["done"] });
  const impl = stubFetch();
  // review is not allowed
  const blocked = await notifySlack(b, "Proj", { text: "hi", event: "review", fetchImpl: impl });
  assert.equal(blocked.sent, false);
  assert.match(blocked.reason, /not in slackEvents/i);
  assert.equal(impl.calls.length, 0);
  // done is allowed → posts
  const ok = await notifySlack(b, "Proj", { text: "hi", event: "done", fetchImpl: impl });
  assert.equal(ok.sent, true);
  assert.equal(impl.calls.length, 1);
});

test("notifySlack posts JSON {text} to the webhook on success", async () => {
  const b = tmpBoard();
  configureSlack(b, "Proj", { slackWebhook: WEBHOOK });
  const impl = stubFetch({ ok: true, status: 200 });
  const r = await notifySlack(b, "Proj", { text: "hello world", event: "summary", fetchImpl: impl });
  assert.equal(r.sent, true);
  assert.equal(impl.calls.length, 1);
  const call = impl.calls[0];
  assert.equal(call.url, WEBHOOK);
  assert.equal(call.opts.method, "POST");
  assert.deepEqual(JSON.parse(call.opts.body), { text: "hello world" });
  assert.ok(call.opts.signal, "an AbortController signal is passed");
});

test("notifySlack returns a warning (never throws) on HTTP 500", async () => {
  const b = tmpBoard();
  configureSlack(b, "Proj", { slackWebhook: WEBHOOK });
  const impl = stubFetch({ ok: false, status: 500 });
  const r = await notifySlack(b, "Proj", { text: "hi", event: "done", fetchImpl: impl });
  assert.equal(r.sent, false);
  assert.match(r.warning, /500/);
});

test("notifySlack returns a warning (never throws) when fetch rejects", async () => {
  const b = tmpBoard();
  configureSlack(b, "Proj", { slackWebhook: WEBHOOK });
  const impl = stubFetch({ throwErr: new Error("ECONNREFUSED") });
  const r = await notifySlack(b, "Proj", { text: "hi", event: "done", fetchImpl: impl });
  assert.equal(r.sent, false);
  assert.match(r.warning, /ECONNREFUSED/);
});

test("notifySlack defaults slackEvents to the built-in list when unset", async () => {
  const b = tmpBoard();
  configureSlack(b, "Proj", { slackWebhook: WEBHOOK });
  const impl = stubFetch();
  for (const ev of DEFAULT_SLACK_EVENTS) {
    const r = await notifySlack(b, "Proj", { text: "x", event: ev, fetchImpl: impl });
    assert.equal(r.sent, true, `event ${ev} should be allowed by default`);
  }
});

test("notifyTicketEvent formats and posts in one call", async () => {
  const b = tmpBoard();
  configureSlack(b, "Proj", { slackWebhook: WEBHOOK });
  const impl = stubFetch();
  const r = await notifyTicketEvent(b, "Proj", "done", { ticketNumber: "FBF-3", title: "Do it", completionSummary: "done" }, { fetchImpl: impl });
  assert.equal(r.sent, true);
  assert.equal(impl.calls.length, 1);
  const body = JSON.parse(impl.calls[0].opts.body);
  assert.match(body.text, /✅ \*FBF-3\* Do it — Done \(Proj\)/);
});
