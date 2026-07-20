import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Board } from "../server/storage.js";
import { logWork } from "../server/metadata.js";
import { appendEvent } from "../server/events.js";
import { buildReportPacket } from "../server/reports.js";

// FBMCPB-23 — sprint report commits come from recorded commit events
// (commit_feature enrichment, FBMCPF-188), not regex over work-log prose;
// the regex path survives only as a legacy fallback.

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbrepcommits-"));
  fs.mkdirSync(path.join(dir, "Proj"));
  fs.writeFileSync(path.join(dir, "Proj", "featurelist.md"), "# Feature List\n");
  fs.writeFileSync(path.join(dir, "Proj", "buglist.md"), "# Bug List\n");
  return new Board(dir);
}

test("report commits prefer recorded commit events over work-log text", () => {
  const b = tmpBoard();
  const f = b.addTask("Proj", "feature", { title: "Real commit", labels: ["sprint:S"] });
  b.setStatus("Proj", f.ticketNumber, "Done", "done");
  // work-log text contains NO hash — the old regex path would find nothing
  logWork(b, "Proj", { ticket: f.ticketNumber, summary: "implemented and verified", additions: 10, deletions: 1, tokens: 1000, model: "sonnet" });
  // but commit_feature's enrichment recorded the real commit event
  appendEvent(b, "Proj", { ticket: f.ticketNumber, field: "commit", hash: "aabbccddeeff00112233445566778899aabbccdd", source: "commit_feature" });

  const packet = buildReportPacket(b, "Proj", "S");
  const t = packet.tickets.find((x) => x.ticket === f.ticketNumber);
  assert.deepEqual(t.commits, ["aabbccdd"]); // shortened recorded hash, found despite hash-free prose
});

test("report commits fall back to text regex for legacy tickets with no recorded events", () => {
  const b = tmpBoard();
  const f = b.addTask("Proj", "feature", { title: "Legacy commit", labels: ["sprint:S"] });
  b.setStatus("Proj", f.ticketNumber, "Done", "done");
  logWork(b, "Proj", { ticket: f.ticketNumber, summary: "shipped in commit a1b2c3d4e5", additions: 5, deletions: 0, tokens: 500, model: "haiku" });

  const packet = buildReportPacket(b, "Proj", "S");
  const t = packet.tickets.find((x) => x.ticket === f.ticketNumber);
  assert.deepEqual(t.commits, ["a1b2c3d4e5"]); // regex fallback still works
});

test("recorded events win even when prose contains a different hash-like string", () => {
  const b = tmpBoard();
  const f = b.addTask("Proj", "feature", { title: "Both", labels: ["sprint:S"] });
  b.setStatus("Proj", f.ticketNumber, "Done", "done");
  logWork(b, "Proj", { ticket: f.ticketNumber, summary: "mentions deadbeef1234 in prose", additions: 1, deletions: 0, tokens: 100, model: "haiku" });
  appendEvent(b, "Proj", { ticket: f.ticketNumber, field: "commit", hash: "0123456789abcdef0123456789abcdef01234567", source: "commit_feature" });

  const packet = buildReportPacket(b, "Proj", "S");
  const t = packet.tickets.find((x) => x.ticket === f.ticketNumber);
  assert.deepEqual(t.commits, ["01234567"]); // recorded correlation, not the prose match
});
