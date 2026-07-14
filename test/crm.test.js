import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  slugify, validateApproval,
  addCompany, listCompanies, getCompany, setCompanyProducts, addContact, updateContact, removeContact,
  addInboxMessage, listInbox, reviewInboxMessage,
  linkTicket, unlinkTicket, companiesForTicket,
  validateAgreementKind, addAgreement, updateAgreement, removeAgreement,
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

// FBMCPF-100 — contact update & removal
test("updateContact edits provided fields, clears with empty string, guards", () => {
  const { board } = tmpBoard();
  addCompany(board, "P", { name: "Acme" });
  addContact(board, "P", "acme", { name: "Ada", email: "ada@acme.com", role: "CTO", phone: "555" });
  const u = updateContact(board, "P", "acme", "c1", { role: "CEO", email: "" });
  assert.equal(u.contact.role, "CEO");
  assert.equal(u.contact.email, null);        // empty string clears
  assert.equal(u.contact.name, "Ada");         // untouched
  assert.equal(getCompany(board, "P", "acme").contacts[0].role, "CEO"); // persisted
  assert.throws(() => updateContact(board, "P", "acme", "c1", { name: "  " }), /cannot be empty/);
  assert.throws(() => updateContact(board, "P", "acme", "c9", { name: "X" }), /not found/);
});

test("removeContact deletes by id and guards", () => {
  const { board } = tmpBoard();
  addCompany(board, "P", { name: "Acme" });
  addContact(board, "P", "acme", { name: "Ada" });
  addContact(board, "P", "acme", { name: "Bo" });
  const r = removeContact(board, "P", "acme", "c1");
  assert.equal(r.removed, "c1");
  assert.equal(r.contactCount, 1);
  assert.deepEqual(getCompany(board, "P", "acme").contacts.map((c) => c.name), ["Bo"]);
  assert.throws(() => removeContact(board, "P", "acme", "c1"), /not found/);
});

// FBMCPF-98 — company product associations
test("setCompanyProducts dedups/trims, surfaces on record, filters listCompanies", () => {
  const { board } = tmpBoard();
  addCompany(board, "P", { name: "Acme" });
  addCompany(board, "P", { name: "Beta" });
  const r = setCompanyProducts(board, "P", "acme", [" Board ", "Board", "CRM", ""]);
  assert.deepEqual(r.products, ["Board", "CRM"]);
  assert.deepEqual(getCompany(board, "P", "acme").products, ["Board", "CRM"]);
  assert.deepEqual(listCompanies(board, "P").companies.find((c) => c.id === "acme").products, ["Board", "CRM"]);
  assert.deepEqual(listCompanies(board, "P", { product: "CRM" }).companies.map((c) => c.id), ["acme"]);
  assert.equal(listCompanies(board, "P", { product: "Nope" }).count, 0);
  assert.throws(() => setCompanyProducts(board, "P", "acme", "notarray"), /array/);
  assert.throws(() => setCompanyProducts(board, "P", "nope", ["X"]), /not found/);
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

// --- FBMCPF-77: contracts & licenses ---

test("addAgreement stores contract/license with monotonic ids + defaults", () => {
  const { board } = tmpBoard();
  addCompany(board, "P", { name: "Acme" });
  const c1 = addAgreement(board, "P", "acme", { kind: "contract", template: "msa", value: 5000 });
  assert.equal(c1.agreement.id, "A1");
  assert.equal(c1.agreement.status, "draft");
  const c2 = addAgreement(board, "P", "acme", { kind: "license", seats: 10, expiresAt: "2027-01-01" });
  assert.equal(c2.agreement.id, "A2");
  assert.equal(c2.agreement.status, "active");
  assert.equal(getCompany(board, "P", "acme").agreements.length, 2);
  assert.throws(() => addAgreement(board, "P", "acme", { kind: "nda" }), /contract.*license/);
  assert.throws(() => validateAgreementKind("x"), /contract.*license/);
});

test("updateAgreement extends/changes; removeAgreement deletes; guards", () => {
  const { board } = tmpBoard();
  addCompany(board, "P", { name: "Acme" });
  addAgreement(board, "P", "acme", { kind: "license", seats: 5, expiresAt: "2026-12-31" });
  const u = updateAgreement(board, "P", "acme", "A1", { expiresAt: "2027-12-31", status: "renewed", seats: 20 });
  assert.equal(u.agreement.expiresAt, "2027-12-31");
  assert.equal(u.agreement.status, "renewed");
  assert.equal(u.agreement.seats, 20);
  assert.throws(() => updateAgreement(board, "P", "acme", "A9", { status: "x" }), /not found/);
  assert.equal(removeAgreement(board, "P", "acme", "A1").count, 0);
  assert.throws(() => removeAgreement(board, "P", "acme", "A1"), /not found/);
});
