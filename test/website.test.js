import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  esc, defaultSite, renderSiteHtml,
  getSite, setSite, editSection, setLoginGate,
  SITE_DIR, SITE_HTML, SITE_CONFIG,
} from "../server/website.js";

// FBMCPF-50 (builder/editor) + FBMCPF-51 (login gate)

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbsite-"));
  return { dir, board: { projectDir: () => dir } };
}

test("esc + renderSiteHtml render title/tagline/sections and escape", () => {
  const html = renderSiteHtml({
    title: "Acme <X>", tagline: "We <build>", theme: "dark",
    sections: [{ heading: "About", body: "line1\nline2" }],
  });
  assert.match(html, /<title>Acme &lt;X&gt;<\/title>/);
  assert.match(html, /class="tagline">We &lt;build&gt;/);
  assert.match(html, /data-theme="dark"/);
  assert.match(html, /line1<br>line2/);
  assert.doesNotMatch(html, /prompt\(/); // no gate when disabled
});

test("defaultSite seeds title from project, gate disabled", () => {
  const d = defaultSite("MyProj");
  assert.equal(d.title, "MyProj");
  assert.equal(d.loginGate.enabled, false);
});

test("setSite writes config + index.html and validates theme", () => {
  const { dir, board } = tmpBoard();
  const r = setSite(board, "P", { title: "Site", tagline: "Hi", sections: [{ heading: "H", body: "B" }] });
  assert.equal(r.sections, 1);
  assert.equal(r.htmlPath, "site/index.html");
  assert.ok(fs.existsSync(path.join(dir, SITE_DIR, SITE_HTML)));
  assert.ok(fs.existsSync(path.join(dir, SITE_DIR, SITE_CONFIG)));
  assert.match(fs.readFileSync(path.join(dir, SITE_DIR, SITE_HTML), "utf8"), /Site/);
  assert.throws(() => setSite(board, "P", { theme: "neon" }), /theme must be/);
});

test("editSection patches by index and appends when out of range", () => {
  const { board } = tmpBoard();
  setSite(board, "P", { title: "S", sections: [{ heading: "A", body: "a" }] });
  editSection(board, "P", { index: 0, body: "a2" });
  assert.equal(getSite(board, "P").sections[0].body, "a2");
  editSection(board, "P", { heading: "B", body: "b" }); // append
  assert.equal(getSite(board, "P").sections.length, 2);
  assert.throws(() => editSection(board, "P", {}), /heading or body/);
});

// FBMCPF-51 — login gate
test("setLoginGate requires a passcode to enable and injects the gate script", () => {
  const { dir, board } = tmpBoard();
  setSite(board, "P", { title: "S" });
  assert.throws(() => setLoginGate(board, "P", { enabled: true }), /passcode is required/);
  const r = setLoginGate(board, "P", { enabled: true, passcode: "1234", message: "Members only" });
  assert.equal(r.loginGate, true);
  const html = fs.readFileSync(path.join(dir, SITE_DIR, SITE_HTML), "utf8");
  assert.match(html, /prompt\(/);
  assert.match(html, /"1234"/);
  assert.match(html, /Members only/);
  assert.match(html, /NOT real security/);
});

test("disabling the gate removes the script", () => {
  const { dir, board } = tmpBoard();
  setSite(board, "P", { title: "S" });
  setLoginGate(board, "P", { enabled: true, passcode: "x" });
  setLoginGate(board, "P", { enabled: false });
  const html = fs.readFileSync(path.join(dir, SITE_DIR, SITE_HTML), "utf8");
  assert.doesNotMatch(html, /prompt\(/);
});
