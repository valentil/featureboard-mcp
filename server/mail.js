/**
 * FeatureBoard mail center (FBMCPF-48).
 *
 * Ports the OpenClaw mailCenter + mailHistory: compose and track project emails.
 * There is no SMTP connector in the MCP, so this is compose + record only — Claude
 * drafts, the user (or a future mail connector) actually sends; mark_email_sent
 * just records that it went out. Store:
 *
 *   <project>/mail.json  { seq, messages:[ { id, to, cc, subject, body, company,
 *                          status:"draft|sent", createdAt, sentAt } ] }
 *
 * Pure helpers (validateRecipients, buildMessage) are exported for tests.
 */

import fs from "node:fs";
import path from "node:path";

export const MAIL_FILE = "mail.json";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Normalize a recipients value (string or array) to a validated address list. */
export function validateRecipients(to) {
  const list = Array.isArray(to) ? to : to == null ? [] : [to];
  const out = [];
  for (const raw of list) {
    const addr = String(raw).trim();
    if (!addr) continue;
    if (!EMAIL_RE.test(addr)) throw new Error(`invalid email address: "${addr}"`);
    out.push(addr);
  }
  if (!out.length) throw new Error("at least one recipient (to) is required");
  return out;
}

/** Build an email message record (pure). */
export function buildMessage(seq, { to, cc, subject, body, company } = {}, now = new Date()) {
  const recipients = validateRecipients(to);
  if (!subject && !body) throw new Error("email needs a subject or body");
  const ccList = cc == null ? [] : (Array.isArray(cc) ? cc : [cc]).map((s) => String(s).trim()).filter(Boolean);
  return {
    id: `E${seq}`,
    to: recipients,
    cc: ccList,
    subject: subject ? String(subject) : "",
    body: body ? String(body) : "",
    company: company ? String(company) : null,
    status: "draft",
    createdAt: now.toISOString(),
    sentAt: null,
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

function mailPath(board, project) {
  return path.join(board.projectDir(project), MAIL_FILE);
}
function readStore(board, project) {
  const data = readJsonSafe(mailPath(board, project));
  if (!data) return { seq: 0, messages: [] };
  return { seq: data.seq || 0, messages: Array.isArray(data.messages) ? data.messages : [] };
}
function writeStore(board, project, store) {
  atomicWrite(mailPath(board, project), JSON.stringify(store, null, 2) + "\n");
}

/** Save an email draft (does not send). */
export function draftEmail(board, project, fields = {}, { now = new Date() } = {}) {
  const store = readStore(board, project);
  const seq = store.seq + 1;
  const msg = buildMessage(seq, fields, now);
  store.messages.push(msg);
  store.seq = seq;
  writeStore(board, project, store);
  return { project, message: msg, count: store.messages.length };
}

/** List mail (newest-first), optionally filtered by status (draft/sent) and/or company. */
export function listMail(board, project, { status, company } = {}) {
  const store = readStore(board, project);
  const messages = store.messages
    .filter((m) => (status ? m.status === status : true))
    .filter((m) => (company ? m.company === company : true))
    .slice()
    .reverse();
  return { project, count: messages.length, messages };
}

/** Full message by id. Throws if not found. */
export function getEmail(board, project, id) {
  const store = readStore(board, project);
  const msg = store.messages.find((m) => m.id === id);
  if (!msg) throw new Error(`email ${id} not found`);
  return msg;
}

/**
 * Record that a draft was sent (moves it to history). Does NOT actually send —
 * there is no mail connector; this just stamps sentAt/status for tracking.
 */
export function markSent(board, project, id, { now = new Date() } = {}) {
  const store = readStore(board, project);
  const msg = store.messages.find((m) => m.id === id);
  if (!msg) throw new Error(`email ${id} not found`);
  if (msg.status === "sent") throw new Error(`email ${id} is already marked sent`);
  msg.status = "sent";
  msg.sentAt = now.toISOString();
  writeStore(board, project, store);
  return { project, message: msg };
}
