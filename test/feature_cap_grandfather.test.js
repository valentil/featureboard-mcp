// FBMCPB-36: grandfather clause for the free-tier feature cap (FBMCPF-294).
//
// The 0.7.0 cap counted ALL top-level features across ALL boards — including
// Done and pre-existing ones — so an existing free user who upgraded was
// instantly hard-frozen. Now the first personal-tier evaluate() stamps
// capStartDate into license state, and only features CREATED on/after that
// date count toward the soft/hard caps. Legacy lines with no [Created: ...]
// tag never count when the grandfather cutoff is in effect.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  evaluate,
  setUsageType,
  activate,
  readState,
  writeState,
  countTopLevelFeatures,
  FREE_FEATURE_SOFT,
  FREE_FEATURE_HARD,
  CHECKOUT_URL,
} from "../server/license.js";
import { localDateStr } from "../server/storage.js";

// FBMCPB-46: capStartDate and feature [Created: ...] tags share ONE calendar
// basis — the LOCAL day (localDateStr), not UTC. Deriving TODAY the same way
// keeps this suite correct in any timezone (the old UTC slice could drift a
// day near midnight and spuriously fail).
const TODAY = localDateStr();
const OLD_DATE = "2026-01-05"; // safely before any capStartDate stamped today

function tmpDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fb-cap-gf-"));
}

function featureLine(i, created) {
  const tag = created ? ` [Created: ${created}]` : "";
  return `- [ ] [FBF-${i}] **Feature ${i}**: some description${tag}`;
}

function writeBoard(dataDir, boardName, lines) {
  const dir = path.join(dataDir, boardName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "featurelist.md"),
    `# Feature List\n${lines.join("\n")}\n`,
    "utf8"
  );
}

// (a) A board with 40 pre-existing features (created before capStartDate)
// evaluates as personal/ok with count 0 after the stamp.
test("40 pre-existing features are grandfathered: personal/ok, count 0, capStartDate stamped", () => {
  const dir = tmpDataDir();
  const lines = [];
  for (let i = 1; i <= 40; i++) lines.push(featureLine(i, OLD_DATE));
  writeBoard(dir, "Proj", lines);
  setUsageType(dir, "personal");

  const ev = evaluate(dir);
  assert.equal(ev.status, "personal");
  assert.equal(ev.allowWrites, true);
  assert.equal(ev.featureCount, 0);
  assert.equal(ev.warn, undefined);
  assert.equal(ev.capStartDate, TODAY);

  // Stamp is persisted and merged — usageType survives.
  const state = readState(dir);
  assert.equal(state.capStartDate, TODAY);
  assert.equal(state.usageType, "personal");

  // Un-scoped counting still sees everything (legacy signature preserved).
  assert.equal(countTopLevelFeatures(dir), 40);
});

// (b) Features created on/after capStartDate count and trip soft/hard as before.
test("features created on/after capStartDate trip soft and hard caps", () => {
  const dir = tmpDataDir();
  writeState(dir, { usageType: "personal", capStartDate: TODAY });

  // 40 grandfathered + exactly SOFT new ones -> soft warn, writes still allowed.
  const lines = [];
  for (let i = 1; i <= 40; i++) lines.push(featureLine(i, OLD_DATE));
  for (let i = 41; i < 41 + FREE_FEATURE_SOFT; i++) lines.push(featureLine(i, TODAY));
  writeBoard(dir, "Proj", lines);

  let ev = evaluate(dir);
  assert.equal(ev.status, "personal");
  assert.equal(ev.warn, true);
  assert.equal(ev.allowWrites, true);
  assert.equal(ev.featureCount, FREE_FEATURE_SOFT);
  assert.equal(ev.capStartDate, TODAY);
  assert.ok(ev.message.includes(`since ${TODAY}`), "soft message explains the since-date meter");

  // Top up to HARD new ones -> hard freeze.
  for (let i = 41 + FREE_FEATURE_SOFT; i < 41 + FREE_FEATURE_HARD; i++) {
    lines.push(featureLine(i, TODAY));
  }
  writeBoard(dir, "Proj", lines);

  ev = evaluate(dir);
  assert.equal(ev.status, "free-limit-reached");
  assert.equal(ev.allowWrites, false);
  assert.equal(ev.featureCount, FREE_FEATURE_HARD);
  assert.equal(ev.capStartDate, TODAY);
  assert.equal(ev.checkoutUrl, CHECKOUT_URL);
  assert.ok(ev.message.includes(`since ${TODAY}`), "hard message explains the since-date meter");
});

// (c) Lines without a [Created: ...] tag never count when since is set.
test("countTopLevelFeatures: untagged legacy lines don't count when since is set", () => {
  const dir = tmpDataDir();
  writeBoard(dir, "Proj", [
    featureLine(1, "2026-06-01"), // before since
    featureLine(2, "2026-06-30"), // before since
    featureLine(3, "2026-07-01"), // exactly since -> counts
    featureLine(4, "2026-07-15"), // after since -> counts
    featureLine(5, null), // no [Created:] tag -> grandfathered
    featureLine(6, null), // no [Created:] tag -> grandfathered
    "- [ ] [FBF-7] **Subtask**: linked 🔗 FBF-3 [Created: 2026-07-15]", // decompose subtask -> never counts
  ]);
  assert.equal(countTopLevelFeatures(dir, { since: "2026-07-01" }), 2);
  // Without since, everything top-level counts (untagged included), as before.
  assert.equal(countTopLevelFeatures(dir), 6);
});

// (d) capStartDate is stamped once and stable across evaluates.
test("capStartDate is stamped once and never re-stamped", () => {
  const dir = tmpDataDir();
  writeBoard(dir, "Proj", [featureLine(1, OLD_DATE)]);
  setUsageType(dir, "personal");

  const ev1 = evaluate(dir);
  assert.equal(ev1.capStartDate, TODAY);
  const stamped = readState(dir).capStartDate;
  assert.equal(stamped, TODAY);

  const ev2 = evaluate(dir);
  assert.equal(ev2.capStartDate, stamped);
  assert.equal(readState(dir).capStartDate, stamped);

  // A pre-existing capStartDate is honored verbatim, never overwritten.
  const dir2 = tmpDataDir();
  writeBoard(dir2, "Proj", [featureLine(1, "2026-07-10")]);
  writeState(dir2, { usageType: "personal", capStartDate: "2026-07-01" });
  const ev3 = evaluate(dir2);
  assert.equal(ev3.capStartDate, "2026-07-01");
  assert.equal(readState(dir2).capStartDate, "2026-07-01");
  assert.equal(ev3.featureCount, 1); // created 2026-07-10 >= 2026-07-01
});

// (e) Reads stay available at the hard cap; only writes freeze.
test("hard cap freezes writes only — reads remain available", () => {
  const dir = tmpDataDir();
  writeState(dir, { usageType: "personal", capStartDate: "2026-07-01" });
  const lines = [];
  for (let i = 1; i <= FREE_FEATURE_HARD; i++) lines.push(featureLine(i, TODAY));
  writeBoard(dir, "Proj", lines);

  const ev = evaluate(dir);
  assert.equal(ev.status, "free-limit-reached");
  assert.equal(ev.allowWrites, false);
  assert.ok(/reads still work/i.test(ev.message), "message reassures that reads keep working");
});

// (f) FBMCPB-46: the stamped capStartDate uses the local-day helper, so it
// shares a basis with serializeTask's [Created: ...] tag (no UTC-vs-local drift).
test("FBMCPB-46: capStartDate is stamped in the local calendar day (localDateStr basis)", () => {
  const dir = tmpDataDir();
  writeBoard(dir, "Proj", [featureLine(1, OLD_DATE)]);
  setUsageType(dir, "personal");

  const ev = evaluate(dir);
  assert.equal(ev.capStartDate, localDateStr(), "capStartDate must match the local-day helper, not a UTC slice");
  assert.equal(readState(dir).capStartDate, localDateStr());
});

// Non-personal tiers never get a capStartDate stamp.
test("public / commercial-trial / commercial tiers are never stamped with capStartDate", () => {
  for (const type of ["public", "commercial-trial", "commercial"]) {
    const dir = tmpDataDir();
    writeBoard(dir, "Proj", [featureLine(1, OLD_DATE)]);
    setUsageType(dir, type);
    evaluate(dir);
    assert.equal(readState(dir).capStartDate, undefined, `${type} must not stamp capStartDate`);
  }
});

// activate / set_usage_type paths are untouched by the grandfather change.
test("setUsageType and activate behave as before", () => {
  const dir = tmpDataDir();
  const s = setUsageType(dir, "personal");
  assert.equal(s.usageType, "personal");
  assert.equal(s.capStartDate, undefined); // stamping happens in evaluate(), not here
  assert.throws(() => setUsageType(dir, "freeloader"), /Unknown usage type/);
  assert.throws(() => activate(dir, "not-a-key"), /Invalid license key/);
  assert.equal(readState(dir).capStartDate, undefined);
  assert.equal(readState(dir).usageType, "personal");
});
