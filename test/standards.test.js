// Project standards (rigor profiles): presets, lock-once semantics, resolution
// precedence, packet injection, and how the level bends research-on-intake.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  STANDARD_LEVELS, STANDARD_PRESETS, normalizeStandard, applyStandard,
  resolveStandard, standardPacketBlock, definitionOfDoneExtras, researchProfile,
} from "../server/standards.js";
import { Board } from "../server/storage.js";
import { setProjectConfig, getWorkPacket } from "../server/metadata.js";
import { prepareResearch } from "../server/research.js";

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-std-"));
  const board = new Board(dir);
  board.createProject("Proj");
  return { dir, board };
}

// ---------------------------------------------------------------------------
// pure semantics
// ---------------------------------------------------------------------------

test("presets exist for every level and polished is research-first", () => {
  for (const l of STANDARD_LEVELS) assert.ok(STANDARD_PRESETS[l], l);
  assert.equal(researchProfile({ level: "polished" }).defaultOn, true);
  assert.equal(researchProfile({ level: "prototype" }).defaultOn, false);
  assert.equal(researchProfile({ level: "standard" }).defaultOn, null);
  assert.ok(researchProfile({ level: "polished" }).extraQuestions.length >= 4);
  assert.ok(definitionOfDoneExtras({ level: "polished" }).length >= 2);
  assert.equal(definitionOfDoneExtras({ level: "prototype" }).length, 0);
});

test("normalizeStandard validates level and trims mandate", () => {
  assert.throws(() => normalizeStandard({ level: "artisanal" }), /Unknown standard level/);
  const n = normalizeStandard({ level: "POLISHED", mandate: "  automate everywhere  " });
  assert.equal(n.level, "polished");
  assert.equal(n.mandate, "automate everywhere");
  assert.equal(n.locked, true); // locked unless explicitly false
});

test("applyStandard: set once, locked wins, force overrides", () => {
  const first = applyStandard(null, { level: "polished", mandate: "ship like it has users", source: "inferred" });
  assert.equal(first.applied, true);
  assert.equal(first.standard.locked, true);
  // a second inference attempt must be refused — "don't keep trying to figure it out"
  const again = applyStandard(first.standard, { level: "prototype", source: "inferred" });
  assert.equal(again.applied, false);
  assert.match(again.reason, /locked/i);
  assert.equal(again.standard.level, "polished");
  // the user explicitly asking = force
  const forced = applyStandard(first.standard, { level: "standard", source: "user" }, { force: true });
  assert.equal(forced.applied, true);
  assert.equal(forced.standard.level, "standard");
});

test("resolveStandard precedence: project > global default > built-in", () => {
  assert.equal(resolveStandard({ level: "polished", locked: true }).level, "polished");
  const viaGlobal = resolveStandard(null, { level: "prototype" });
  assert.equal(viaGlobal.level, "prototype");
  assert.equal(viaGlobal.source, "default");
  assert.equal(viaGlobal.locked, false); // a default never counts as locked
  const builtin = resolveStandard(null, null);
  assert.equal(builtin.level, "standard");
  assert.equal(builtin.locked, false);
  // malformed stored value falls through instead of throwing
  assert.equal(resolveStandard({ level: "junk" }, null).level, "standard");
});

test("standardPacketBlock carries mandate and nags only while unlocked", () => {
  const locked = standardPacketBlock({ level: "polished", locked: true, source: "user", mandate: "competitor research + whitepapers" });
  assert.equal(locked.mandate, "competitor research + whitepapers");
  assert.ok(!locked.note);
  const unlocked = standardPacketBlock({ level: "standard", locked: false, source: "default" });
  assert.match(unlocked.note, /set_standard ONCE/);
});

// ---------------------------------------------------------------------------
// integration: packets + research
// ---------------------------------------------------------------------------

test("getWorkPacket injects the standard and polished extends the DoD", () => {
  const { board } = tmpBoard();
  const t = board.addTask("Proj", "feature", { title: "Layout the settings screen" });
  // default (no standard configured)
  let packet = getWorkPacket(board, "Proj", t.ticketNumber);
  assert.equal(packet.standard.level, "standard");
  assert.equal(packet.standard.locked, false);
  const baseDoD = packet.definitionOfDone.length;
  // lock polished with a mandate
  const res = applyStandard(null, { level: "polished", mandate: "highly polished engineering standard", source: "user" });
  setProjectConfig(board, "Proj", { standard: res.standard });
  packet = getWorkPacket(board, "Proj", t.ticketNumber);
  assert.equal(packet.standard.level, "polished");
  assert.equal(packet.standard.locked, true);
  assert.equal(packet.standard.mandate, "highly polished engineering standard");
  assert.ok(packet.definitionOfDone.length > baseDoD, "polished adds DoD items");
  // global default reaches packets for unconfigured projects via opts
  setProjectConfig(board, "Proj", { standard: null });
  packet = getWorkPacket(board, "Proj", t.ticketNumber, { globalDefaultStandard: { level: "prototype" } });
  assert.equal(packet.standard.level, "prototype");
});

test("research: polished forces it on with expanded questions; prototype skips", () => {
  const { board } = tmpBoard();
  const t = board.addTask("Proj", "feature", { title: "Comparables for the pricing page" });
  setProjectConfig(board, "Proj", { standard: applyStandard(null, { level: "polished" }).standard });
  const r = prepareResearch(board, "Proj", t.ticketNumber);
  assert.equal(r.skip, false);
  const qs = r.questions.join(" ");
  assert.match(qs, /Competitor teardown/);
  assert.match(qs, /white papers/i);
  assert.match(qs, /heuristics/i);
  assert.match(qs, /automated, generated, or scripted/);

  setProjectConfig(board, "Proj", { standard: applyStandard(null, { level: "prototype" }).standard });
  const r2 = prepareResearch(board, "Proj", t.ticketNumber);
  assert.equal(r2.skip, true);
  assert.match(r2.reason, /prototype/);
  // ...but an explicit research:on label still wins over the prototype default
  board.updateTask("Proj", t.ticketNumber, { labels: ["research:on"] });
  const r3 = prepareResearch(board, "Proj", t.ticketNumber);
  assert.equal(r3.skip, false);
});
