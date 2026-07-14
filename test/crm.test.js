import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  slugify, validateApproval,
  addCompany, listCompanies, getCompany, addContact,
  addInboxMessage, listInbox, reviewInboxMessage,
  linkTicket, unlinkTicket, companiesForTicket,
} from "../server/crm.js";

// FBMCPF-43 — CRM companies/contacts + inbox

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbcrm-"));
  return { dir, board: { projectDir: () => dir } };
}

test("slugify normalizes and rejects empty", () => {
  assert.equal(slugify("Acme, Inc."), "acme-inc");
  assert.equal(slugify("  Foo   Bar  "), "foo-bar");
  assert.throws(() => slugify("!!!"), /letters or numbers/);
});

test("validateApproval maps approve/reject and rejects junk", () => {
  assert.equal(validateApproval("approve"), "approved");
  assert.equal(validateApproval("Rejected"), "rejected");
  assert.throws(() => validateApproval("maybe"), /approve.*reject/);
});

test("addCompany de-duplicates slugs; listCompanies summarizes", () => {
  const { board } = tmpBoard();
  const a = addCompany(board, "P", { name: "Acme", domain: "acme.com" });
  assert.equal(a.id, "acme");
  const b = addCompany(board, "P", { name: "Acme" });
  assert.equal(b.id, "acme-2");
  const list = listCompanies(board, "P");
  assert.equal(list.count, 2);
  assert.equal(list.companies[0].name, "Acme");
  assert.equal(list.companies[0].contactCount, 0);
});

test("addContact appends monotonic contact ids and persists", () => {
  const { board } = tmpBoard();
  addCompany(board, "P", { name: "Acme" });
  const c1 = addContact(board, "P", "acme", { name: "Ada", email: "ada@acme.com", role: "CTO" });
  assert.equal(c1.contact.id, "c1");
  assert.equal(c1.contactCount, 1);
  const c2 = addContact(board, "P", "acme", { name: "Bo" });
  assert.equal(c2.contact.id, "c2");
  const full = getCompany(board, "P", "acme");
  assert.equal(full.contacts.length, 2);
  assert.equal(full.contacts[0].email, "ada@acme.com");
  assert.throws(() => addContact(board, "P", "nope", { name: "X" }), /not found/);
  assert.throws(() => getCompany(board, "P", "nope"), /not found/);
});

test("empty board: no companies, empty inbox", () => {
  const { board } = tmpBoard();
  assert.equal(listCompanies(board, "P").count, 0);
  assert.equal(listInbox(board, "P").count, 0);
});

test("inbox: add (pending), list filters, approve/reject flow", () => {
  const { board } = tmpBoard();
  const m1 = addInboxMessage(board, "P", { from: "a@x.com", subject: "Hi", body: "hello", company: "acme" });
  assert.equal(m1.item.id, "m1");
  assert.equal(m1.item.status, "pending");
  addInboxMessage(board, "P", { subject: "Second" });
  assert.equal(listInbox(board, "P").count, 2);
  assert.equal(listInbox(board, "P").items[0].subject, "Second"); // newest-first
  assert.equal(listInbox(board, "P", { company: "acme" }).count, 1);

  const rev = reviewInboxMessage(board, "P", "m1", "approve");
  assert.equal(rev.item.status, "approved");
  assert.ok(rev.item.reviewedAt);
  assert.equal(listInbox(board, "P", { status: "pending" }).count, 1);
  assert.equal(listInbox(board, "P", { status: "approved" }).count, 1);
  assert.throws(() => reviewInboxMessage(board, "P", "mX", "approve"), /not found/);
  assert.throws(() => addInboxMessage(board, "P", {}), /subject or body/);
});

// --- FBMCPF-47: CRM-linked tickets ---

test("linkTicket dedups and persists on company.tickets", () => {
  const { board } = tmpBoard();
  addCompany(board, "P", { name: "Acme" });
  let r = linkTicket(board, "P", "acme", "FBF-1");
  assert.deepEqual(r.tickets, ["FBF-1"]);
  linkTicket(board, "P", "acme", "FBF-1"); // dup ignored
  r = linkTicket(board, "P", "acme", "FBB-2");
  assert.deepEqual(r.tickets, ["FBF-1", "FBB-2"]);
  assert.deepEqual(getCompany(board, "P", "acme").tickets, ["FBF-1", "FBB-2"]);
  assert.throws(() => linkTicket(board, "P", "acme", "  "), /ticket id is required/);
  assert.throws(() => linkTicket(board, "P", "nope", "X"), /not found/);
});

test("unlinkTicket removes, throws if not linked", () => {
  const { board } = tmpBoard();
  addCompany(board, "P", { name: "Acme" });
  linkTicket(board, "P", "acme", "FBF-1");
  assert.deepEqual(unlinkTicket(board, "P", "acme", "FBF-1").tickets, []);
  assert.throws(() => unlinkTicket(board, "P", "acme", "FBF-9"), /not linked/);
});

test("companiesForTicket reverse-lookup across companies", () => {
  const { board } = tmpBoard();
  addCompany(board, "P", { name: "Acme" });
  addCompany(board, "P", { name: "Beta" });
  linkTicket(board, "P", "acme", "FBF-1");
  linkTicket(board, "P", "beta", "FBF-1");
  linkTicket(board, "P", "beta", "FBB-2");
  assert.equal(companiesForTicket(board, "P", "FBF-1").companies.length, 2);
  assert.deepEqual(companiesForTicket(board, "P", "FBB-2").companies.map((c) => c.id), ["beta"]);
  assert.equal(companiesForTicket(board, "P", "NONE").companies.length, 0);
});
