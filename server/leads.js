/**
 * FeatureBoard leads (FBMCPF-44).
 *
 * Ports the OpenClaw leads store + geographic leads map. Leads live alongside the
 * CRM under the board:
 *
 *   <project>/crm/leads.json  { seq, leads:[ { id, name, company, email, source,
 *                               value, city, lat, lng, status, createdAt, updatedAt } ] }
 *
 * Statuses model a simple pipeline (new → contacted → qualified → won/lost).
 * `leadsMap` aggregates the pipeline for a geographic view: the points that carry
 * lat/lng, plus counts + pipeline value by status and by city. Rendering (an actual
 * map) is left to the board artifact or a generated media report; this returns the
 * data. Pure helpers are exported for tests.
 */

import fs from "node:fs";
import path from "node:path";

export const LEADS_FILE = path.join("crm", "leads.json");
export const LEAD_STATUSES = ["new", "contacted", "qualified", "won", "lost"];

/** Normalize/validate a lead status, or throw. */
export function validateLeadStatus(status) {
  const s = String(status || "").trim().toLowerCase();
  if (!LEAD_STATUSES.includes(s)) {
    throw new Error(`status must be one of ${LEAD_STATUSES.join(", ")} (got "${status}")`);
  }
  return s;
}

/** Validate an optional coordinate pair; returns { lat, lng } (numbers) or nulls. */
export function normalizeCoords(lat, lng) {
  const has = lat != null || lng != null;
  if (!has) return { lat: null, lng: null };
  const la = Number(lat);
  const ln = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln)) throw new Error("lat/lng must both be numbers");
  if (la < -90 || la > 90) throw new Error("lat must be between -90 and 90");
  if (ln < -180 || ln > 180) throw new Error("lng must be between -180 and 180");
  return { lat: la, lng: ln };
}

/** Build a lead record (pure). */
export function buildLead(seq, fields = {}, now = new Date()) {
  const { name, company, email, source, value, city, lat, lng, status } = fields;
  if (!name || !String(name).trim()) throw new Error("lead name is required");
  const coords = normalizeCoords(lat, lng);
  return {
    id: `L${seq}`,
    name: String(name).trim(),
    company: company ? String(company) : null,
    email: email ? String(email) : null,
    source: source ? String(source) : null,
    value: value != null && value !== "" ? Number(value) : null,
    city: city ? String(city) : null,
    lat: coords.lat,
    lng: coords.lng,
    status: status ? validateLeadStatus(status) : "new",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
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

function leadsFilePath(board, project) {
  return path.join(board.projectDir(project), LEADS_FILE);
}
function readStore(board, project) {
  const data = readJsonSafe(leadsFilePath(board, project));
  if (!data) return { seq: 0, leads: [] };
  return { seq: data.seq || 0, leads: Array.isArray(data.leads) ? data.leads : [] };
}
function writeStore(board, project, store) {
  const p = leadsFilePath(board, project);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  atomicWrite(p, JSON.stringify(store, null, 2) + "\n");
}

/** Add a lead (defaults to status "new"). */
export function addLead(board, project, fields = {}, { now = new Date() } = {}) {
  const store = readStore(board, project);
  const seq = store.seq + 1;
  const lead = buildLead(seq, fields, now);
  store.leads.push(lead);
  store.seq = seq;
  writeStore(board, project, store);
  return { project, lead, count: store.leads.length };
}

/** List leads (newest-first), optionally filtered by status and/or company. */
export function listLeads(board, project, { status, company } = {}) {
  const store = readStore(board, project);
  const key = status ? validateLeadStatus(status) : null;
  const leads = store.leads
    .filter((l) => (key ? l.status === key : true))
    .filter((l) => (company ? l.company === company : true))
    .slice()
    .reverse();
  return { project, count: leads.length, leads };
}

/** Update a lead's pipeline status. Throws if the id isn't found. */
export function setLeadStatus(board, project, id, status, { now = new Date() } = {}) {
  const s = validateLeadStatus(status);
  const store = readStore(board, project);
  const lead = store.leads.find((l) => l.id === id);
  if (!lead) throw new Error(`lead ${id} not found`);
  lead.status = s;
  lead.updatedAt = now.toISOString();
  writeStore(board, project, store);
  return { project, lead };
}

/**
 * Geographic + pipeline rollup for the leads map: mappable points (those with
 * coords), counts + pipeline value by status and by city, and a geocoded tally.
 */
export function leadsMap(board, project) {
  const { leads } = readStore(board, project);
  const points = [];
  const byStatus = {};
  const byCity = {};
  let totalValue = 0;
  let withCoords = 0;
  for (const l of leads) {
    byStatus[l.status] = (byStatus[l.status] || 0) + 1;
    if (l.city) byCity[l.city] = (byCity[l.city] || 0) + 1;
    if (typeof l.value === "number" && Number.isFinite(l.value)) totalValue += l.value;
    if (typeof l.lat === "number" && typeof l.lng === "number") {
      withCoords += 1;
      points.push({ id: l.id, name: l.name, company: l.company, city: l.city, lat: l.lat, lng: l.lng, status: l.status, value: l.value });
    }
  }
  return {
    project,
    total: leads.length,
    geocoded: withCoords,
    ungeocoded: leads.length - withCoords,
    totalValue,
    byStatus,
    byCity,
    points,
  };
}
