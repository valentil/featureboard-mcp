/**
 * FeatureBoard CRM store (FBMCPF-43).
 *
 * The original OpenClaw app kept a CRM under the board folder: a companies/ dir of
 * per-company JSON (each with contacts/employees + notes) plus a crm_inbox with an
 * approvals workflow. Ported AI-natively, the store lives under each board:
 *
 *   <project>/crm/
 *     companies/<slug>.json   { id, slug, name, domain, notes, contacts:[...], createdAt }
 *     inbox.json              { seq, items:[ { id, from, subject, body, company,
 *                               status:"pending|approved|rejected", createdAt } ] }
 *
 * Companies are one-file-each (easy hand-editing + git diffs); the inbox is a single
 * JSON with a monotonic id sequence and a pending→approved/rejected review flow.
 * Pure helpers (slugify, validateApproval) are exported for tests.
 */

import fs from "node:fs";
import path from "node:path";

export const CRM_DIR = "crm";
export const COMPANIES_SUBDIR = "companies";
export const INBOX_FILE = "inbox.json";

/** Filesystem-safe slug from a company name. */
export function slugify(name) {
  const s = String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!s) throw new Error("company name must contain letters or numbers");
  return s;
}

/** Normalize an approval decision to a status, or throw. */
export function validateApproval(decision) {
  const d = String(decision || "").trim().toLowerCase();
  const map = { approve: "approved", approved: "approved", reject: "rejected", rejected: "rejected" };
  if (!map[d]) throw new Error(`decision must be "approve" or "reject" (got "${decision}")`);
  return map[d];
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
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
function writeJson(filePath, obj) {
  atomicWrite(filePath, JSON.stringify(obj, null, 2) + "\n");
}

function companiesDir(board, project) {
  return path.join(board.projectDir(project), CRM_DIR, COMPANIES_SUBDIR);
}
function companyPath(board, project, id) {
  return path.join(companiesDir(board, project), `${id}.json`);
}
function inboxPath(board, project) {
  return path.join(board.projectDir(project), CRM_DIR, INBOX_FILE);
}

// --- Companies + contacts ---------------------------------------------------

/** Create a company record. Slug is derived from the name and de-duplicated. */
export function addCompany(board, project, { name, domain, notes } = {}, { now = new Date() } = {}) {
  if (!name || !String(name).trim()) throw new Error("company name is required");
  const dir = companiesDir(board, project);
  ensureDir(dir);
  let id = slugify(name);
  let n = 1;
  while (fs.existsSync(path.join(dir, `${id}.json`))) {
    n += 1;
    id = `${slugify(name)}-${n}`;
  }
  const company = {
    id,
    slug: id,
    name: String(name).trim(),
    domain: domain ? String(domain) : null,
    notes: notes ? String(notes) : null,
    contacts: [],
    contactSeq: 0,
    createdAt: now.toISOString(),
  };
  writeJson(companyPath(board, project, id), company);
  return company;
}

/** List companies (summaries), alphabetical by name. */
export function listCompanies(board, project, { product } = {}) {
  const dir = companiesDir(board, project);
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return { project, count: 0, companies: [] };
  }
  const want = product ? String(product).trim() : null;
  const companies = [];
  for (const f of files) {
    const c = readJsonSafe(path.join(dir, f));
    if (!c) continue;
    const products = Array.isArray(c.products) ? c.products : [];
    if (want && !products.includes(want)) continue;
    companies.push({
      id: c.id,
      name: c.name,
      domain: c.domain || null,
      contactCount: Array.isArray(c.contacts) ? c.contacts.length : 0,
      products,
    });
  }
  companies.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { project, count: companies.length, companies };
}

/** Replace the set of products a company uses/owns (de-duplicated, trimmed). */
export function setCompanyProducts(board, project, companyId, products = []) {
  if (!Array.isArray(products)) throw new Error("products must be an array of strings");
  const c = getCompany(board, project, companyId);
  const clean = [...new Set(products.map((x) => String(x).trim()).filter(Boolean))];
  c.products = clean;
  writeJson(companyPath(board, project, companyId), c);
  return { company: c.id, products: clean };
}

/** Full company record (with contacts). Throws if not found. */
export function getCompany(board, project, id) {
  const c = readJsonSafe(companyPath(board, project, id));
  if (!c) throw new Error(`company "${id}" not found`);
  return c;
}

/** Add a contact to a company. Contact ids are monotonic within the company. */
export function addContact(board, project, companyId, { name, email, role, phone } = {}) {
  if (!name || !String(name).trim()) throw new Error("contact name is required");
  const c = getCompany(board, project, companyId);
  const seq = (c.contactSeq || 0) + 1;
  const contact = {
    id: `c${seq}`,
    name: String(name).trim(),
    email: email ? String(email) : null,
    role: role ? String(role) : null,
    phone: phone ? String(phone) : null,
  };
  c.contacts = Array.isArray(c.contacts) ? c.contacts : [];
  c.contacts.push(contact);
  c.contactSeq = seq;
  writeJson(companyPath(board, project, companyId), c);
  return { company: c.id, contact, contactCount: c.contacts.length };
}

/** Update a contact on a company (only provided fields change). Throws if not found. */
export function updateContact(board, project, companyId, contactId, patch = {}) {
  const c = getCompany(board, project, companyId);
  const contact = (Array.isArray(c.contacts) ? c.contacts : []).find((x) => x.id === contactId);
  if (!contact) throw new Error(`contact ${contactId} not found on ${companyId}`);
  if (patch.name != null) {
    if (!String(patch.name).trim()) throw new Error("contact name cannot be empty");
    contact.name = String(patch.name).trim();
  }
  if (patch.email != null) contact.email = patch.email ? String(patch.email) : null;
  if (patch.role != null) contact.role = patch.role ? String(patch.role) : null;
  if (patch.phone != null) contact.phone = patch.phone ? String(patch.phone) : null;
  writeJson(companyPath(board, project, companyId), c);
  return { company: c.id, contact };
}

/** Remove a contact from a company. Throws if not found. */
export function removeContact(board, project, companyId, contactId) {
  const c = getCompany(board, project, companyId);
  const list = Array.isArray(c.contacts) ? c.contacts : [];
  const next = list.filter((x) => x.id !== contactId);
  if (next.length === list.length) throw new Error(`contact ${contactId} not found on ${companyId}`);
  c.contacts = next;
  writeJson(companyPath(board, project, companyId), c);
  return { company: c.id, removed: contactId, contactCount: next.length };
}

// --- CRM inbox + approvals --------------------------------------------------

function readInbox(board, project) {
  const data = readJsonSafe(inboxPath(board, project));
  if (!data) return { seq: 0, items: [] };
  return { seq: data.seq || 0, items: Array.isArray(data.items) ? data.items : [] };
}
function writeInbox(board, project, store) {
  ensureDir(path.join(board.projectDir(project), CRM_DIR));
  writeJson(inboxPath(board, project), store);
}

/** Inbound submission categories for the CRM inbox. */
export const INTAKE_TYPES = ["support", "sales", "contact", "feedback", "other"];

/** Normalize an intake type, defaulting to "contact". */
export function validateIntakeType(type) {
  const s = String(type || "contact").trim().toLowerCase();
  if (!INTAKE_TYPES.includes(s)) throw new Error(`type must be one of ${INTAKE_TYPES.join(", ")} (got "${type}")`);
  return s;
}

/** Add an inbox message (starts pending review). Optional type/email/name capture inbound-submission details. */
export function addInboxMessage(board, project, { from, subject, body, company, type, email, name } = {}, { now = new Date() } = {}) {
  if (!subject && !body) throw new Error("inbox message needs a subject or body");
  const store = readInbox(board, project);
  const seq = store.seq + 1;
  const item = {
    id: `m${seq}`,
    type: type ? validateIntakeType(type) : null,
    from: from ? String(from) : null,
    name: name ? String(name) : null,
    email: email ? String(email) : null,
    subject: subject ? String(subject) : null,
    body: body ? String(body) : null,
    company: company ? String(company) : null,
    status: "pending",
    createdAt: now.toISOString(),
  };
  store.items.push(item);
  store.seq = seq;
  writeInbox(board, project, store);
  return { project, item, count: store.items.length };
}

/**
 * Capture an inbound support/contact submission (support-info / crm-submit) into
 * the CRM inbox, pending review. Requires a message; synthesizes a subject when
 * none is given, and records the requester (name/email) + category.
 */
export function submitIntake(board, project, { type, name, email, company, subject, message } = {}, { now = new Date() } = {}) {
  const t = validateIntakeType(type);
  if (!message || !String(message).trim()) throw new Error("submission message is required");
  const who = name || email || "someone";
  const subj = subject && String(subject).trim() ? subject : `[${t}] submission from ${who}`;
  return addInboxMessage(board, project, { type: t, from: email || name || null, name, email, subject: subj, body: message, company }, { now });
}

/** List inbox items (newest-first), optionally filtered by status, company, and/or type. */
export function listInbox(board, project, { status, company, type } = {}) {
  const store = readInbox(board, project);
  const t = type ? validateIntakeType(type) : null;
  const items = store.items
    .filter((m) => (status ? m.status === status : true))
    .filter((m) => (company ? m.company === company : true))
    .filter((m) => (t ? m.type === t : true))
    .slice()
    .reverse();
  return { project, count: items.length, items };
}

/** Approve or reject an inbox item. Records the decision + timestamp. */
export function reviewInboxMessage(board, project, id, decision, { now = new Date() } = {}) {
  const status = validateApproval(decision);
  const store = readInbox(board, project);
  const item = store.items.find((m) => m.id === id);
  if (!item) throw new Error(`inbox message ${id} not found`);
  item.status = status;
  item.reviewedAt = now.toISOString();
  writeInbox(board, project, store);
  return { project, item };
}

// --- CRM-linked tickets (FBMCPF-47) -----------------------------------------

/** Link a board ticket to a company (stored on company.tickets, de-duplicated). */
export function linkTicket(board, project, companyId, ticket) {
  const t = String(ticket || "").trim();
  if (!t) throw new Error("ticket id is required");
  const c = getCompany(board, project, companyId);
  c.tickets = Array.isArray(c.tickets) ? c.tickets : [];
  if (!c.tickets.includes(t)) c.tickets.push(t);
  writeJson(companyPath(board, project, companyId), c);
  return { project, company: c.id, tickets: c.tickets };
}

/** Remove a ticket link from a company. Throws if it wasn't linked. */
export function unlinkTicket(board, project, companyId, ticket) {
  const t = String(ticket || "").trim();
  const c = getCompany(board, project, companyId);
  const current = Array.isArray(c.tickets) ? c.tickets : [];
  if (!current.includes(t)) throw new Error(`ticket ${t} is not linked to ${companyId}`);
  c.tickets = current.filter((x) => x !== t);
  writeJson(companyPath(board, project, companyId), c);
  return { project, company: c.id, tickets: c.tickets };
}

// --- Per-company contracts & licenses (FBMCPF-77) ---------------------------

const AGREEMENT_KINDS = ["contract", "license"];

/** Normalize an agreement kind, or throw. */
export function validateAgreementKind(kind) {
  const s = String(kind || "").trim().toLowerCase();
  if (!AGREEMENT_KINDS.includes(s)) throw new Error(`kind must be "contract" or "license" (got "${kind}")`);
  return s;
}

/** Add a contract or license to a company (stored on company.agreements). */
export function addAgreement(board, project, companyId, fields = {}, { now = new Date() } = {}) {
  const kind = validateAgreementKind(fields.kind);
  const c = getCompany(board, project, companyId);
  c.agreements = Array.isArray(c.agreements) ? c.agreements : [];
  const seq = (c.agreementSeq || 0) + 1;
  const a = {
    id: `A${seq}`,
    kind,
    status: fields.status ? String(fields.status) : kind === "license" ? "active" : "draft",
    createdAt: now.toISOString(),
  };
  if (fields.template) a.template = String(fields.template);
  if (fields.title) a.title = String(fields.title);
  if (fields.value != null && fields.value !== "") a.value = Number(fields.value);
  if (fields.seats != null && fields.seats !== "") a.seats = Number(fields.seats);
  if (fields.term) a.term = String(fields.term);
  if (fields.expiresAt) a.expiresAt = String(fields.expiresAt);
  if (fields.notes) a.notes = String(fields.notes);
  c.agreements.push(a);
  c.agreementSeq = seq;
  writeJson(companyPath(board, project, companyId), c);
  return { project, company: c.id, agreement: a, count: c.agreements.length };
}

/** Update/extend an agreement (status, expiry, seats). Throws if not found. */
export function updateAgreement(board, project, companyId, id, patch = {}) {
  const c = getCompany(board, project, companyId);
  const a = (Array.isArray(c.agreements) ? c.agreements : []).find((x) => x.id === id);
  if (!a) throw new Error(`agreement ${id} not found on ${companyId}`);
  if (patch.status != null) a.status = String(patch.status);
  if (patch.expiresAt != null) a.expiresAt = String(patch.expiresAt);
  if (patch.seats != null && patch.seats !== "") a.seats = Number(patch.seats);
  if (patch.term != null) a.term = String(patch.term);
  if (patch.value != null && patch.value !== "") a.value = Number(patch.value);
  writeJson(companyPath(board, project, companyId), c);
  return { project, company: c.id, agreement: a };
}

/** Remove an agreement from a company. Throws if not found. */
export function removeAgreement(board, project, companyId, id) {
  const c = getCompany(board, project, companyId);
  const list = Array.isArray(c.agreements) ? c.agreements : [];
  const next = list.filter((x) => x.id !== id);
  if (next.length === list.length) throw new Error(`agreement ${id} not found on ${companyId}`);
  c.agreements = next;
  writeJson(companyPath(board, project, companyId), c);
  return { project, company: c.id, removed: id, count: next.length };
}

/** Reverse lookup: which companies a ticket is linked to (surfaces the relationship). */
export function companiesForTicket(board, project, ticket) {
  const t = String(ticket || "").trim();
  const dir = companiesDir(board, project);
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return { project, ticket: t, companies: [] };
  }
  const companies = [];
  for (const f of files) {
    const c = readJsonSafe(path.join(dir, f));
    if (c && Array.isArray(c.tickets) && c.tickets.includes(t)) {
      companies.push({ id: c.id, name: c.name });
    }
  }
  return { project, ticket: t, companies };
}
