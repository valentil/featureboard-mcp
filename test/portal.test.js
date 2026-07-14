import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { esc, renderPortalHtml, buildCustomerPortal } from "../server/portal.js";
import { addCompany, addContact } from "../server/crm.js";

// FBMCPF-45 — Customer portal

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbportal-"));
  return { dir, board: { projectDir: () => dir } };
}

test("esc escapes HTML metacharacters", () => {
  assert.equal(esc(`<b>&"x`), "&lt;b&gt;&amp;&quot;x");
});

test("renderPortalHtml includes name, contacts, ticket rows; escapes", () => {
  const html = renderPortalHtml(
    { name: "Acme <Corp>", contacts: [{ name: "Ada", role: "CTO", email: "ada@acme.com" }] },
    [
      { ticketNumber: "FBF-1", type: "feature", title: "Login", status: "In Progress" },
      { ticketNumber: "FBB-2", type: "bug", title: "Crash", status: "Done" },
    ]
  );
  assert.match(html, /Acme &lt;Corp&gt; — Customer Portal/);
  assert.match(html, /Ada — CTO/);
  assert.match(html, /FBF-1/);
  assert.match(html, /2 linked items · 1 open/);
  assert.match(html, /s-in-progress/);
});

test("renderPortalHtml handles empty contacts + tickets", () => {
  const html = renderPortalHtml({ name: "Solo" }, []);
  assert.match(html, /No contacts on file/);
  assert.match(html, /No linked features or bugs yet/);
  assert.match(html, /0 linked items · 0 open/);
});

test("buildCustomerPortal resolves company.tickets via resolver", () => {
  const { dir, board } = tmpBoard();
  addCompany(board, "P", { name: "Acme" });
  addContact(board, "P", "acme", { name: "Ada" });
  // simulate FBMCPF-47 linkage by writing company.tickets directly
  const cp = path.join(dir, "crm", "companies", "acme.json");
  const c = JSON.parse(fs.readFileSync(cp, "utf8"));
  c.tickets = ["FBF-1", "FBB-2", "GHOST-9"];
  fs.writeFileSync(cp, JSON.stringify(c));

  const tasks = {
    "FBF-1": { ticketNumber: "FBF-1", type: "feature", title: "Login", status: "Todo" },
    "FBB-2": { ticketNumber: "FBB-2", type: "bug", title: "Crash", status: "Done" },
  };
  const r = buildCustomerPortal(board, "P", "acme", (id) => tasks[id] || null);
  assert.equal(r.company, "acme");
  assert.equal(r.ticketCount, 2); // GHOST-9 unresolved → dropped
  assert.equal(r.openCount, 1);
  assert.match(r.html, /Login/);
  assert.match(r.html, /Ada/);
});

test("buildCustomerPortal throws for unknown company", () => {
  const { board } = tmpBoard();
  assert.throws(() => buildCustomerPortal(board, "P", "nope", () => null), /not found/);
});
