import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  validateBookingType, parseWhen, resolveContact,
  book, cancelBooking, listBookings, BOOKINGS_FILE,
} from "../server/bookings.js";
import { addCompany, addContact, CRM_DIR } from "../server/crm.js";

// FBMCPF-84 — booking / scheduling against CRM contacts

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbbook-"));
  return { dir, board: { projectDir: () => dir } };
}

test("validateBookingType normalizes + defaults to call", () => {
  assert.equal(validateBookingType(), "call");
  assert.equal(validateBookingType("Demo"), "demo");
  assert.throws(() => validateBookingType("wedding"), /type must be one of/);
});

test("parseWhen accepts ISO / Date, rejects junk + empty", () => {
  assert.equal(parseWhen("2026-07-20T15:00:00Z"), "2026-07-20T15:00:00.000Z");
  assert.equal(parseWhen(new Date("2026-01-01T00:00:00Z")), "2026-01-01T00:00:00.000Z");
  assert.throws(() => parseWhen("not a date"), /could not parse/);
  assert.throws(() => parseWhen(""), /required/);
});

test("resolveContact matches by id or name, else throws", () => {
  const company = { id: "acme", contacts: [{ id: "c1", name: "Jane Doe" }] };
  assert.deepEqual(resolveContact(company, "c1"), { contactId: "c1", contactName: "Jane Doe" });
  assert.deepEqual(resolveContact(company, "jane doe"), { contactId: "c1", contactName: "Jane Doe" });
  assert.deepEqual(resolveContact(company, null), { contactId: null, contactName: null });
  assert.throws(() => resolveContact(company, "Bob"), /no contact/);
});

test("book validates company, stores a scheduled booking with a contact", () => {
  const { dir, board } = tmpBoard();
  addCompany(board, "P", { name: "Acme" });
  addContact(board, "P", "acme", { name: "Jane Doe", email: "jane@acme.com" });
  const r = book(board, "P", { company: "acme", contact: "Jane Doe", type: "demo", at: "2026-08-01T17:00:00Z", durationMins: 45, subject: "Product demo" });
  assert.equal(r.booking.id, "b1");
  assert.equal(r.booking.company, "acme");
  assert.equal(r.booking.contactId, "c1");
  assert.equal(r.booking.contactName, "Jane Doe");
  assert.equal(r.booking.type, "demo");
  assert.equal(r.booking.at, "2026-08-01T17:00:00.000Z");
  assert.equal(r.booking.durationMins, 45);
  assert.equal(r.booking.status, "scheduled");
  assert.ok(fs.existsSync(path.join(dir, CRM_DIR, BOOKINGS_FILE)));
});

test("book defaults type=call, duration=30, no contact", () => {
  const { board } = tmpBoard();
  addCompany(board, "P", { name: "Acme" });
  const r = book(board, "P", { company: "acme", at: "2026-08-02T10:00:00Z" });
  assert.equal(r.booking.type, "call");
  assert.equal(r.booking.durationMins, 30);
  assert.equal(r.booking.contactId, null);
});

test("book rejects unknown company + bad duration", () => {
  const { board } = tmpBoard();
  assert.throws(() => book(board, "P", { company: "ghost", at: "2026-08-02T10:00:00Z" }), /not found/);
  addCompany(board, "P", { name: "Acme" });
  assert.throws(() => book(board, "P", { company: "acme", at: "2026-08-02T10:00:00Z", durationMins: -5 }), /positive number/);
});

test("cancelBooking flips status and is idempotent", () => {
  const { board } = tmpBoard();
  addCompany(board, "P", { name: "Acme" });
  book(board, "P", { company: "acme", at: "2026-08-02T10:00:00Z" });
  const c = cancelBooking(board, "P", "b1", { reason: "prospect rescheduled" });
  assert.equal(c.booking.status, "cancelled");
  assert.equal(c.booking.cancelReason, "prospect rescheduled");
  const again = cancelBooking(board, "P", "b1");
  assert.equal(again.alreadyCancelled, true);
  assert.throws(() => cancelBooking(board, "P", "b9"), /not found/);
});

test("listBookings filters by company/status and upcoming-sorts", () => {
  const { board } = tmpBoard();
  addCompany(board, "P", { name: "Acme" });
  addCompany(board, "P", { name: "Globex" });
  const now = new Date("2026-07-14T00:00:00Z");
  book(board, "P", { company: "acme", at: "2026-08-10T10:00:00Z" }, { now });
  book(board, "P", { company: "acme", at: "2026-07-20T10:00:00Z" }, { now });
  book(board, "P", { company: "globex", at: "2026-06-01T10:00:00Z" }, { now }); // past
  book(board, "P", { company: "acme", at: "2026-09-01T10:00:00Z" }, { now });
  cancelBooking(board, "P", "b4", {}, { now });

  assert.equal(listBookings(board, "P").count, 4);
  assert.equal(listBookings(board, "P", { company: "acme" }).count, 3);
  assert.equal(listBookings(board, "P", { status: "cancelled" }).count, 1);

  const upcoming = listBookings(board, "P", { upcoming: true }, { now });
  // b1 (Aug10) and b2 (Jul20) are scheduled+future; b3 is past, b4 cancelled
  assert.deepEqual(upcoming.items.map((b) => b.id), ["b2", "b1"]); // soonest first
});
