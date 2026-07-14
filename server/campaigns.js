/**
 * FeatureBoard marketing campaigns (FBMCPF-49).
 *
 * Ports the OpenClaw marketingCampaign builder: campaigns with a recipient list,
 * send batching, and open tracking. There is no send connector, so sending is
 * record-only — batching is computed for whoever actually sends, and opens are
 * recorded when a future connector (or manual entry) reports them. Store:
 *
 *   <project>/campaigns.json  { seq, campaigns:[ { id, name, subject, body,
 *     batchSize, status, recipients:[ {email, opened, openedAt} ], createdAt } ] }
 *
 * Pure helpers (buildCampaign, planBatches, campaignStats) are exported for tests.
 */

import fs from "node:fs";
import path from "node:path";
import { validateRecipients } from "./mail.js";

export const CAMPAIGNS_FILE = "campaigns.json";
export const DEFAULT_BATCH_SIZE = 50;

/** Split recipients into send batches of at most batchSize (pure). */
export function planBatches(recipients, batchSize = DEFAULT_BATCH_SIZE) {
  const size = Number(batchSize);
  if (!Number.isInteger(size) || size < 1) throw new Error("batchSize must be a positive integer");
  const batches = [];
  for (let i = 0; i < recipients.length; i += size) batches.push(recipients.slice(i, i + size));
  return batches;
}

/** Build a campaign record (pure). Validates recipients and batch size. */
export function buildCampaign(seq, { name, subject, body, recipients, batchSize = DEFAULT_BATCH_SIZE } = {}, now = new Date()) {
  if (!name || !String(name).trim()) throw new Error("campaign name is required");
  const emails = validateRecipients(recipients);
  const size = Number(batchSize);
  if (!Number.isInteger(size) || size < 1) throw new Error("batchSize must be a positive integer");
  const seen = new Set();
  const list = [];
  for (const e of emails) {
    if (seen.has(e)) continue; // de-dup recipients
    seen.add(e);
    list.push({ email: e, opened: false, openedAt: null });
  }
  return {
    id: `MC${seq}`,
    name: String(name).trim(),
    subject: subject ? String(subject) : "",
    body: body ? String(body) : "",
    batchSize: size,
    status: "draft",
    recipients: list,
    createdAt: now.toISOString(),
  };
}

/** Compute campaign stats: recipient/open counts, open rate, batch count (pure). */
export function campaignStats(campaign) {
  const recipients = Array.isArray(campaign.recipients) ? campaign.recipients : [];
  const opened = recipients.filter((r) => r.opened).length;
  return {
    recipients: recipients.length,
    opened,
    openRate: recipients.length ? Math.round((opened / recipients.length) * 1000) / 10 : 0,
    batches: planBatches(recipients, campaign.batchSize || DEFAULT_BATCH_SIZE).length,
  };
}

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}
function atomicWrite(filePath, data) {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}
function campaignsPath(board, project) {
  return path.join(board.projectDir(project), CAMPAIGNS_FILE);
}
function readStore(board, project) {
  const data = readJsonSafe(campaignsPath(board, project));
  if (!data) return { seq: 0, campaigns: [] };
  return { seq: data.seq || 0, campaigns: Array.isArray(data.campaigns) ? data.campaigns : [] };
}
function writeStore(board, project, store) {
  atomicWrite(campaignsPath(board, project), JSON.stringify(store, null, 2) + "\n");
}

/** Create a campaign (status draft). */
export function createCampaign(board, project, fields = {}, { now = new Date() } = {}) {
  const store = readStore(board, project);
  const seq = store.seq + 1;
  const campaign = buildCampaign(seq, fields, now);
  store.campaigns.push(campaign);
  store.seq = seq;
  writeStore(board, project, store);
  return { project, campaign: { id: campaign.id, name: campaign.name, status: campaign.status }, stats: campaignStats(campaign) };
}

/** List campaigns (newest-first) with summary stats, optionally filtered by status. */
export function listCampaigns(board, project, { status } = {}) {
  const store = readStore(board, project);
  const campaigns = store.campaigns
    .filter((c) => (status ? c.status === status : true))
    .slice()
    .reverse()
    .map((c) => ({ id: c.id, name: c.name, subject: c.subject, status: c.status, createdAt: c.createdAt, stats: campaignStats(c) }));
  return { project, count: campaigns.length, campaigns };
}

/** Full campaign incl. recipients + stats + batch plan sizes. Throws if not found. */
export function getCampaign(board, project, id) {
  const store = readStore(board, project);
  const c = store.campaigns.find((x) => x.id === id);
  if (!c) throw new Error(`campaign ${id} not found`);
  const batches = planBatches(c.recipients, c.batchSize).map((b) => b.length);
  return { ...c, stats: campaignStats(c), batchSizes: batches };
}

/** Record an open for a recipient (idempotent per recipient). Throws if unknown. */
export function recordOpen(board, project, id, email, { now = new Date() } = {}) {
  const store = readStore(board, project);
  const c = store.campaigns.find((x) => x.id === id);
  if (!c) throw new Error(`campaign ${id} not found`);
  const r = (c.recipients || []).find((x) => x.email === email);
  if (!r) throw new Error(`${email} is not a recipient of ${id}`);
  if (!r.opened) {
    r.opened = true;
    r.openedAt = now.toISOString();
    writeStore(board, project, store);
  }
  return { project, campaign: id, email, stats: campaignStats(c) };
}
