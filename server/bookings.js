/**
 * FeatureBoard bookings / scheduling against CRM contacts (FBMCPF-84).
 *
 * The original OpenClaw app let you book and cancel calls/demos with a company's
 * contacts. Ported AI-natively, bookings live alongside the CRM under the board:
 *
 *   <project>/crm/bookings.json   { seq, items:[ { id, company, contactId,
 *     contactName, type, at, durationMins, subject, notes, status, createdAt } ] }
 *
 * A single JSON with a monotonic id sequence (like the CRM inbox). Each booking is
 * tied to a CRM company (validated via crm.getCompany) and optionally a specific
 * contact within it, so scheduling reuses the same records the rest of the CRM does.
 * status is "scheduled" | "cancelled". Pure helpers (validateBookingType, parseWhen,
 * resolveContact) are exported for tests.
 */

import fs from "node:fs";
import path from "node:path";
import { getCompany, CRM_DIR } from "./crm.js";

export const BOOKINGS_FILE = "bookings.json";

/** Kinds of booking the scheduler understands. */
export const BOOKING_TYPES = ["call", "demo", "meeting", "onboarding", "other"];

/** Normalize a booking type, defaulting to "call". */
export function validateBookingType(type) {
  const s = String(type == null || type === "" ? "call" : type).trim().toLowerCase();
  if (!BOOKING_TYPES.includes(s)) throw new Error(`type must be one of ${BOOKING_TYPES.join(", ")} (got "${type}")`);
  return s;
}

/** Parse a when/at value into an ISO string, or throw. Accepts ISO / Date-parseable. */
export function parseWhen(at) {
  if (at == null || String(at).trim() === "") throw new Error("a booking time (at) is required");
  const d = at instanceof Date ? at : new Date(String(at));
  if (isNaN(d.getTime())) throw new Error(`could not parse booking time: "${at}" (use an ISO timestamp, e.g. 2026-07-20T15:00:00Z)`);
  return d.toISOString();
}

/**
 * Resolve a contact reference (id like "c1", or a name) against a company's
 * contacts. Returns { contactId, contactName } or nulls when no ref was given.
 * Throws when a ref is given but doesn't match any contact.
 */
export function resolveContact(company, ref) {
  if (ref == null || String(ref).trim() === "") return { contactId: null, contactName: null };
  const contacts = Array.isArray(company.contacts) ? company.contacts : [];
  const r = String(ref).trim();
  const byId = contacts.find((c) => c.id === r);
  if (byId) return { contactId: byId.id, contactName: byId.name };
  const byName = contacts.find((c) => c.name && c.name.toLowerCase() === r.toLowerCase());
  if (byName) return { contactId: byName.id, contactName: byName.name };
  throw new Error(`no contact "${ref}" on company "${company.id}" (add one with add_contact, or omit contact)`);
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
function bookingsPath(board, project) {
  return path.join(board.projectDir(project), CRM_DIR, BOOKINGS_FILE);
}
function readBookings(board, project) {
  const data = readJsonSafe(bookingsPath(board, project));
  if (!data) return { seq: 0, items: [] };
  return { seq: data.seq || 0, items: Array.isArray(data.items) ? data.items : [] };
}
function writeBookings(board, project, store) {
  fs.mkdirSync(path.join(board.projectDir(project), CRM_DIR), { recursive: true });
  atomicWrite(bookingsPath(board, project), JSON.stringify(store, null, 2) + "\n");
}

/**
 * Book a call/demo/meeting with a CRM company (and optionally a specific contact).
 * Validates the company exists and the contact (if given) belongs to it.
 */
export function book(board, project, { company, contact, type, at, durationMins, subject, notes } = {}, { now = new Date() } = {}) {
  if (!company || !String(company).trim()) throw new Error("company id is required (see list_companies)");
  const co = getCompany(board, project, String(company).trim()); // throws if missing
  const { contactId, contactName } = resolveContact(co, contact);
  const bType = validateBookingType(type);
  const iso = parseWhen(at);
  let dur = 30;
  if (durationMins != null && durationMins !== "") {
    dur = Number(durationMins);
    if (!Number.isFinite(dur) || dur <= 0) throw new Error("durationMins must be a positive number");
  }
  const store = readBookings(board, project);
  const seq = store.seq + 1;
  const item = {
    id: `b${seq}`,
    company: co.id,
    contactId,
    contactName,
    type: bType,
    at: iso,
    durationMins: dur,
    subject: subject ? String(subject) : null,
    notes: notes ? String(notes) : null,
    status: "scheduled",
    createdAt: now.toISOString(),
  };
  store.items.push(item);
  store.seq = seq;
  writeBookings(board, project, store);
  return { project, booking: item, count: store.items.length };
}

/** Cancel a booking by id (idempotent-ish: re-cancelling is a no-op with a note). */
export function cancelBooking(board, project, id, { reason } = {}, { now = new Date() } = {}) {
  const store = readBookings(board, project);
  const item = store.items.find((b) => b.id === id);
  if (!item) throw new Error(`booking ${id} not found`);
  if (item.status === "cancelled") {
    return { project, booking: item, alreadyCancelled: true };
  }
  item.status = "cancelled";
  item.cancelledAt = now.toISOString();
  if (reason) item.cancelReason = String(reason);
  writeBookings(board, project, store);
  return { project, booking: item };
}

/**
 * List bookings, newest-created first by default. Filter by company, status, or
 * upcoming:true (scheduled and in the future, sorted soonest-first).
 */
export function listBookings(board, project, { company, status, upcoming } = {}, { now = new Date() } = {}) {
  const store = readBookings(board, project);
  let items = store.items.slice();
  if (company) items = items.filter((b) => b.company === String(company).trim());
  if (status) items = items.filter((b) => b.status === status);
  if (upcoming) {
    const t = now.getTime();
    items = items
      .filter((b) => b.status === "scheduled" && new Date(b.at).getTime() >= t)
      .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  } else {
    items = items.reverse();
  }
  return { project, count: items.length, items };
}
