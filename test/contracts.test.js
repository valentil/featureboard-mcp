import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listTemplates, templateFields, renderContract, generateContract, TEMPLATES } from "../server/contracts.js";
import { addCompany } from "../server/crm.js";

// FBMCPF-46 — Standard contracts / templates

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbcontract-"));
  return { dir, board: { projectDir: () => dir } };
}

test("listTemplates exposes ids, titles, required fields", () => {
  const r = listTemplates();
  assert.equal(r.count, Object.keys(TEMPLATES).length);
  const ids = r.templates.map((t) => t.id);
  assert.ok(ids.includes("nda") && ids.includes("license"));
  assert.ok(r.templates.find((t) => t.id === "nda").required.includes("customer_name"));
});

test("templateFields lists all tokens; unknown template throws", () => {
  assert.ok(templateFields("nda").includes("governing_law"));
  assert.throws(() => templateFields("bogus"), /unknown template/);
});

test("renderContract fills provided vars and stamps a review notice", () => {
  const r = renderContract("nda", {
    customer_name: "Acme", provider: "FeatureBoard LLC", effective_date: "2026-07-13",
    term: "3 years", governing_law: "Delaware",
  });
  assert.match(r.markdown, /between FeatureBoard LLC \("Provider"\) and Acme/);
  assert.match(r.markdown, /review with counsel/);
  assert.equal(r.leftBlank.length, 0);
});

test("renderContract leaves optional tokens blank but records them", () => {
  const r = renderContract("nda", { customer_name: "Acme", provider: "FB", effective_date: "2026-07-13" });
  assert.match(r.markdown, /________/); // term/governing_law blanked
  assert.ok(r.leftBlank.includes("term"));
  assert.ok(r.leftBlank.includes("governing_law"));
});

test("renderContract throws when a required field is missing", () => {
  assert.throws(() => renderContract("nda", { provider: "FB", effective_date: "x" }), /missing required field\(s\).*customer_name/);
  assert.throws(() => renderContract("nope", {}), /unknown template/);
});

test("generateContract auto-fills customer_name from CRM and can save to media", () => {
  const { dir, board } = tmpBoard();
  addCompany(board, "P", { name: "Acme Corp" });
  const r = generateContract(
    board, "P",
    { template: "nda", company: "acme-corp", vars: { provider: "FeatureBoard LLC", effective_date: "2026-07-13" }, save: true },
    { now: new Date("2026-07-13T10:00:00Z") }
  );
  assert.match(r.markdown, /and Acme Corp \("Counterparty"\)/); // auto-filled from CRM
  assert.equal(r.saved, "media/contract-acme-corp-nda-2026-07-13.md");
  assert.ok(fs.existsSync(path.join(dir, "media", "contract-acme-corp-nda-2026-07-13.md")));
});
