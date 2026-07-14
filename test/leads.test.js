import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  validateLeadStatus, normalizeCoords, buildLead,
  addLead, listLeads, setLeadStatus, leadsMap, LEADS_FILE,
} from "../server/leads.js";

// FBMCPF-44 — Leads management + leads map

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbleads-"));
  return { dir, board: { projectDir: () => dir } };
}

test("validateLeadStatus accepts pipeline stages, rejects junk", () => {
  assert.equal(validateLeadStatus("New"), "new");
  assert.equal(validateLeadStatus("won"), "won");
  assert.throws(() => validateLeadStatus("pending"), /status must be one of/);
});

test("normalizeCoords validates ranges and pairing", () => {
  assert.deepEqual(normalizeCoords(null, null), { lat: null, lng: null });
  assert.deepEqual(normalizeCoords(38.9, -77.0), { lat: 38.9, lng: -77.0 });
  assert.throws(() => normalizeCoords(200, 0), /lat must be between/);
  assert.throws(() => normalizeCoords(0, 999), /lng must be between/);
  assert.throws(() => normalizeCoords("x", 0), /must both be numbers/);
});

test("buildLead defaults status new, coerces value, requires name", () => {
  const l = buildLead(1, { name: "Acme deal", value: "5000", status: "contacted" });
  assert.equal(l.id, "L1");
  assert.equal(l.status, "contacted");
  assert.equal(l.value, 5000);
  assert.throws(() => buildLead(2, { name: "" }), /name is required/);
});

test("addLead + listLeads: newest-first, filter by status/company", () => {
  const { board } = tmpBoard();
  addLead(board, "P", { name: "A", company: "acme", status: "new" });
  addLead(board, "P", { name: "B", company: "beta", status: "qualified" });
  addLead(board, "P", { name: "C", company: "acme", status: "qualified" });
  assert.equal(listLeads(board, "P").count, 3);
  assert.equal(listLeads(board, "P").leads[0].name, "C"); // newest-first
  assert.equal(listLeads(board, "P", { status: "qualified" }).count, 2);
  assert.equal(listLeads(board, "P", { company: "acme" }).count, 2);
});

test("setLeadStatus updates + stamps; throws on missing", () => {
  const { board } = tmpBoard();
  const a = addLead(board, "P", { name: "A" });
  const r = setLeadStatus(board, "P", a.lead.id, "won");
  assert.equal(r.lead.status, "won");
  assert.ok(r.lead.updatedAt);
  assert.throws(() => setLeadStatus(board, "P", "LX", "won"), /not found/);
  assert.throws(() => setLeadStatus(board, "P", a.lead.id, "nope"), /status must be one of/);
});

test("leadsMap aggregates points, byStatus/byCity, pipeline value", () => {
  const { board } = tmpBoard();
  addLead(board, "P", { name: "A", city: "DC", lat: 38.9, lng: -77.0, status: "new", value: 1000 });
  addLead(board, "P", { name: "B", city: "DC", status: "qualified", value: 2000 }); // no coords
  addLead(board, "P", { name: "C", city: "NYC", lat: 40.7, lng: -74.0, status: "won", value: 500 });
  const m = leadsMap(board, "P");
  assert.equal(m.total, 3);
  assert.equal(m.geocoded, 2);
  assert.equal(m.ungeocoded, 1);
  assert.equal(m.totalValue, 3500);
  assert.deepEqual(m.byStatus, { new: 1, qualified: 1, won: 1 });
  assert.deepEqual(m.byCity, { DC: 2, NYC: 1 });
  assert.equal(m.points.length, 2);
  assert.equal(m.points[0].lat, 38.9);
});

test("store lives at crm/leads.json", () => {
  const { dir, board } = tmpBoard();
  addLead(board, "P", { name: "A" });
  assert.ok(fs.existsSync(path.join(dir, LEADS_FILE)));
});
