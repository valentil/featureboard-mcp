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

/** Extract a bare hostname/domain from a URL or domain string (null if none). */
export function deriveDomain(url) {
  if (!url) return null;
  let s = String(url).trim();
  if (!s) return null;
  s = s.replace(/^[a-z]+:\/\//i, "").replace(/^www\./i, "");
  s = s.split(/[/?#]/)[0].trim().toLowerCase();
  return s || null;
}

// Fields that website enrichment may fill in on a lead.
const ENRICH_KEYS = ["website", "domain", "phone", "industry", "description", "contactName", "employees", "email", "city", "source", "value", "notes"];

/**
 * Merge website-sourced enrichment fields onto a lead (non-destructive: only the
 * provided allow-listed keys are set). Records enrichedAt + enrichmentSource.
 * Claude fetches/extracts the website; this persists what it found.
 */
export function enrichLead(board, project, id, fields = {}, { now = new Date(), source = "website" } = {}) {
  const store = readStore(board, project);
  const lead = store.leads.find((l) => l.id === id);
  if (!lead) throw new Error(`lead ${id} not found`);
  const applied = [];
  for (const k of ENRICH_KEYS) {
    if (fields[k] == null || fields[k] === "") continue;
    lead[k] = k === "value" ? Number(fields[k]) : k === "domain" ? deriveDomain(fields[k]) : String(fields[k]);
    applied.push(k);
  }
  if (fields.website && !lead.domain) lead.domain = deriveDomain(fields.website);
  lead.enrichedAt = now.toISOString();
  lead.enrichmentSource = source;
  lead.updatedAt = now.toISOString();
  writeStore(board, project, store);
  return { project, lead, applied };
}

/**
 * Convert a qualified lead into a CRM company, carrying over its fields (name,
 * website→domain, and a notes summary), optionally seeding a contact from the
 * lead's person/email/phone. Marks the lead won + records convertedTo. CRM writes
 * are injected (crm.addCompany/addContact) to keep the modules decoupled.
 */
export function convertLead(board, project, id, { companyName, createContact = true } = {}, { now = new Date(), crm } = {}) {
  if (!crm || typeof crm.addCompany !== "function") throw new Error("convertLead requires crm.addCompany");
  const store = readStore(board, project);
  const lead = store.leads.find((l) => l.id === id);
  if (!lead) throw new Error(`lead ${id} not found`);
  if (lead.convertedTo) throw new Error(`lead ${id} already converted to company "${lead.convertedTo}"`);

  const name = (companyName && String(companyName).trim()) || lead.company || lead.name;
  const domain = deriveDomain(lead.website || lead.domain);
  const noteParts = [];
  if (lead.industry) noteParts.push(`Industry: ${lead.industry}`);
  if (lead.value != null) noteParts.push(`Pipeline value: ${lead.value}`);
  if (lead.city) noteParts.push(`City: ${lead.city}`);
  if (lead.source) noteParts.push(`Source: ${lead.source}`);
  if (lead.description) noteParts.push(lead.description);
  noteParts.push(`Converted from lead ${lead.id}.`);
  const company = crm.addCompany(board, project, { name, domain, notes: noteParts.join(" · ") }, { now });

  let contact = null;
  if (createContact && (lead.contactName || lead.name || lead.email || lead.phone) && typeof crm.addContact === "function") {
    const res = crm.addContact(board, project, company.id, {
      name: lead.contactName || lead.name,
      email: lead.email || null,
      phone: lead.phone || null,
    });
    contact = res.contact;
  }

  lead.status = "won";
  lead.convertedTo = company.id;
  lead.convertedAt = now.toISOString();
  lead.updatedAt = now.toISOString();
  writeStore(board, project, store);
  return { project, lead, company, contact };
}

export const INTERACTION_KINDS = ["call", "email", "meeting", "note", "visit", "other"];

/** Great-circle distance in km between two lat/lng points (haversine). */
export function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Define a circular geographic lead area (center + radius km). */
export function addLeadArea(board, project, { name, lat, lng, radiusKm } = {}, { now = new Date() } = {}) {
  if (!name || !String(name).trim()) throw new Error("area name is required");
  const coords = normalizeCoords(lat, lng);
  if (coords.lat == null) throw new Error("area needs lat/lng for its centre");
  const radius = Number(radiusKm);
  if (!Number.isFinite(radius) || radius <= 0) throw new Error("radiusKm must be a positive number");
  const store = readStore(board, project);
  const areas = Array.isArray(store.areas) ? store.areas : [];
  const seq = (store.areaSeq || 0) + 1;
  const area = { id: `A${seq}`, name: String(name).trim(), lat: coords.lat, lng: coords.lng, radiusKm: radius, createdAt: now.toISOString() };
  areas.push(area);
  store.areas = areas;
  store.areaSeq = seq;
  writeStore(board, project, store);
  return { project, area, count: areas.length };
}

/** List defined lead areas. */
export function listLeadAreas(board, project) {
  const store = readStore(board, project);
  const areas = Array.isArray(store.areas) ? store.areas : [];
  return { project, count: areas.length, areas };
}

/** Which defined areas contain a point (by centre distance <= radius). */
function areasForPoint(areas, lat, lng) {
  if (typeof lat !== "number" || typeof lng !== "number") return [];
  return areas.filter((a) => haversineKm(a.lat, a.lng, lat, lng) <= a.radiusKm).map((a) => a.id);
}

/** Append an interaction (touchpoint) to a lead's log. */
export function addInteraction(board, project, id, { kind, note, at } = {}, { now = new Date() } = {}) {
  const k = String(kind || "note").trim().toLowerCase();
  if (!INTERACTION_KINDS.includes(k)) throw new Error(`kind must be one of ${INTERACTION_KINDS.join(", ")}`);
  if (!note || !String(note).trim()) throw new Error("interaction note is required");
  const store = readStore(board, project);
  const lead = store.leads.find((l) => l.id === id);
  if (!lead) throw new Error(`lead ${id} not found`);
  const interactions = Array.isArray(lead.interactions) ? lead.interactions : [];
  const seq = (lead.interactionSeq || 0) + 1;
  const interaction = { id: `i${seq}`, kind: k, note: String(note).trim(), at: at ? String(at) : now.toISOString() };
  interactions.push(interaction);
  lead.interactions = interactions;
  lead.interactionSeq = seq;
  lead.updatedAt = now.toISOString();
  writeStore(board, project, store);
  return { project, lead: id, interaction, count: interactions.length };
}

/** Update a lead's location (coords and/or city). */
export function updateLeadLocation(board, project, id, { lat, lng, city } = {}, { now = new Date() } = {}) {
  const store = readStore(board, project);
  const lead = store.leads.find((l) => l.id === id);
  if (!lead) throw new Error(`lead ${id} not found`);
  if (lat != null || lng != null) {
    const coords = normalizeCoords(lat, lng);
    lead.lat = coords.lat;
    lead.lng = coords.lng;
  }
  if (city !== undefined) lead.city = city ? String(city) : null;
  lead.updatedAt = now.toISOString();
  writeStore(board, project, store);
  return { project, lead };
}

/**
 * Geographic + pipeline rollup for the leads map: mappable points (those with
 * coords, each tagged with the areas it falls in), counts + pipeline value by
 * status and by city, defined areas with per-area lead counts + value, and a
 * geocoded tally.
 */
export function leadsMap(board, project) {
  const store = readStore(board, project);
  const leads = store.leads;
  const areas = Array.isArray(store.areas) ? store.areas : [];
  const points = [];
  const byStatus = {};
  const byCity = {};
  const areaAgg = {};
  for (const a of areas) areaAgg[a.id] = { id: a.id, name: a.name, lat: a.lat, lng: a.lng, radiusKm: a.radiusKm, leads: 0, value: 0 };
  let totalValue = 0;
  let withCoords = 0;
  for (const l of leads) {
    byStatus[l.status] = (byStatus[l.status] || 0) + 1;
    if (l.city) byCity[l.city] = (byCity[l.city] || 0) + 1;
    const val = typeof l.value === "number" && Number.isFinite(l.value) ? l.value : 0;
    if (val) totalValue += val;
    if (typeof l.lat === "number" && typeof l.lng === "number") {
      withCoords += 1;
      const inAreas = areasForPoint(areas, l.lat, l.lng);
      for (const aid of inAreas) {
        areaAgg[aid].leads += 1;
        areaAgg[aid].value += val;
      }
      points.push({ id: l.id, name: l.name, company: l.company, city: l.city, lat: l.lat, lng: l.lng, status: l.status, value: l.value, areas: inAreas });
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
    areas: Object.values(areaAgg),
    points,
  };
}
