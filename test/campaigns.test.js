import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  planBatches, buildCampaign, campaignStats,
  createCampaign, listCampaigns, getCampaign, recordOpen, CAMPAIGNS_FILE,
} from "../server/campaigns.js";

// FBMCPF-49 — Marketing campaign builder + tracking

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbcamp-"));
  return { dir, board: { projectDir: () => dir } };
}
const recips = (n) => Array.from({ length: n }, (_, i) => `u${i}@x.com`);

test("planBatches splits into batchSize chunks; rejects bad size", () => {
  assert.equal(planBatches(recips(10), 4).length, 3); // 4+4+2
  assert.deepEqual(planBatches(recips(2), 5), [["u0@x.com", "u1@x.com"]]);
  assert.throws(() => planBatches(recips(1), 0), /positive integer/);
});

test("buildCampaign validates name/recipients, de-dups recipients", () => {
  const c = buildCampaign(1, { name: "Launch", recipients: ["a@x.com", "a@x.com", "b@x.com"], batchSize: 2 });
  assert.equal(c.id, "MC1");
  assert.equal(c.status, "draft");
  assert.equal(c.recipients.length, 2); // de-duped
  assert.equal(c.recipients[0].opened, false);
  assert.throws(() => buildCampaign(2, { name: "", recipients: ["a@x.com"] }), /name is required/);
  assert.throws(() => buildCampaign(3, { name: "X", recipients: ["bad"] }), /invalid email/);
});

test("campaignStats computes open rate + batch count", () => {
  const c = buildCampaign(1, { name: "L", recipients: recips(10), batchSize: 4 });
  c.recipients[0].opened = true;
  c.recipients[1].opened = true;
  const s = campaignStats(c);
  assert.equal(s.recipients, 10);
  assert.equal(s.opened, 2);
  assert.equal(s.openRate, 20);
  assert.equal(s.batches, 3);
});

test("create + list + get roundtrip with stats", () => {
  const { board } = tmpBoard();
  createCampaign(board, "P", { name: "Spring", recipients: recips(3), subject: "Hi" });
  createCampaign(board, "P", { name: "Fall", recipients: recips(1) });
  assert.equal(listCampaigns(board, "P").count, 2);
  assert.equal(listCampaigns(board, "P").campaigns[0].name, "Fall"); // newest-first
  const full = getCampaign(board, "P", "MC1");
  assert.equal(full.name, "Spring");
  assert.equal(full.stats.recipients, 3);
  assert.throws(() => getCampaign(board, "P", "MC9"), /not found/);
});

test("recordOpen is idempotent + updates stats; guards unknown recipient", () => {
  const { board } = tmpBoard();
  createCampaign(board, "P", { name: "L", recipients: ["a@x.com", "b@x.com"] });
  let r = recordOpen(board, "P", "MC1", "a@x.com");
  assert.equal(r.stats.opened, 1);
  r = recordOpen(board, "P", "MC1", "a@x.com"); // idempotent
  assert.equal(r.stats.opened, 1);
  assert.equal(getCampaign(board, "P", "MC1").stats.openRate, 50);
  assert.throws(() => recordOpen(board, "P", "MC1", "z@x.com"), /not a recipient/);
  assert.throws(() => recordOpen(board, "P", "MC9", "a@x.com"), /not found/);
});

test("store lives at campaigns.json", () => {
  const { dir, board } = tmpBoard();
  createCampaign(board, "P", { name: "L", recipients: ["a@x.com"] });
  assert.ok(fs.existsSync(path.join(dir, CAMPAIGNS_FILE)));
});
