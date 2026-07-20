import { test } from "node:test";
import assert from "node:assert/strict";
import { compactAck, ACK_HEAVY_FIELDS } from "../server/metadata.js";

// FBMCPF-237 — compact write echoes for set_status/update_task. compactAck is
// the pure helper both tool handlers share: strip the heavy per-ticket fields,
// rename ticketNumber -> ticket, and merge in whatever conditional extras the
// caller already computed. verbose:true passthrough is caller-side (index.js
// just returns the raw view instead of calling compactAck), so it's not
// exercised here — only the helper itself.

function fullView(overrides = {}) {
  return {
    ticketNumber: "FBF-42",
    title: "Ship the thing",
    description: "A fairly long description of the work involved.",
    status: "Done",
    completionSummary: null,
    createdDate: "2026-07-01",
    dueDate: "2026-07-15",
    completionDate: "2026-07-19",
    product: "Core",
    labels: ["backend", "urgent"],
    linkedIssue: "FBB-3",
    ref: "EXT-9",
    priority: 1,
    attachments: ["design.png"],
    newFile: false,
    website: "https://example.com",
    blockedBy: ["FBF-40"],
    source: "featurelist.md",
    _raw: "- [x] [FBF-42] **Ship the thing**: ...",
    line: "- [x] [FBF-42] **Ship the thing**: ...",
    ...overrides,
  };
}

test("compactAck strips description/_raw/line/labels and the rest of the heavy fields", () => {
  const out = compactAck(fullView());
  for (const field of ACK_HEAVY_FIELDS) {
    assert.equal(out[field], undefined, `expected ${field} to be stripped`);
  }
  assert.equal("description" in out, false);
  assert.equal("_raw" in out, false);
  assert.equal("line" in out, false);
  assert.equal("labels" in out, false);
});

test("compactAck preserves ticket/status/title (renaming ticketNumber -> ticket)", () => {
  const out = compactAck(fullView());
  assert.equal(out.ticket, "FBF-42");
  assert.equal(out.status, "Done");
  assert.equal(out.title, "Ship the thing");
  assert.equal("ticketNumber" in out, false);
});

test("compactAck keeps conditional annotations already attached to the view (e.g. set_status extras)", () => {
  const view = fullView({
    completionSummary: "Shipped it",
    uncommitted: true,
    commitReminder: "FBF-42 moved to Done with no commit found for it yet — consider commit_feature.",
    metrics: { velocity: 3 },
    telemetryHint: "tokens not recorded",
    padMirror: { skipped: false },
    warning: "pad mirror failed: boom",
    automations: [{ rule: "notify" }],
  });
  const out = compactAck(view);
  assert.equal(out.completionSummary, "Shipped it");
  assert.equal(out.uncommitted, true);
  assert.equal(out.commitReminder, view.commitReminder);
  assert.deepEqual(out.metrics, { velocity: 3 });
  assert.equal(out.telemetryHint, "tokens not recorded");
  assert.deepEqual(out.padMirror, { skipped: false });
  assert.equal(out.warning, "pad mirror failed: boom");
  assert.deepEqual(out.automations, [{ rule: "notify" }]);
});

test("compactAck merges extras (update_task's updated:true, optional warning)", () => {
  const out = compactAck(fullView({ status: "Todo" }), { updated: true });
  assert.equal(out.ticket, "FBF-42");
  assert.equal(out.title, "Ship the thing");
  assert.equal(out.status, "Todo");
  assert.equal(out.updated, true);

  const withWarning = compactAck(fullView({ status: "Todo" }), { updated: true, warning: "heads up" });
  assert.equal(withWarning.warning, "heads up");
});

test("compactAck ignores undefined extras (no stray keys for absent conditional fields)", () => {
  const out = compactAck(fullView(), { updated: true, warning: undefined });
  assert.equal("warning" in out, false);
});

test("compactAck handles a minimal view (no conditional extras present)", () => {
  const out = compactAck({ ticketNumber: "FBB-7", title: "Bug", status: "Todo" });
  assert.deepEqual(out, { ticket: "FBB-7", title: "Bug", status: "Todo" });
});
