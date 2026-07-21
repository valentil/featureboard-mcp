import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  setSite, renderSite, editSection, addPage,
  GENERATED_MARKER, SITE_HTML, SITE_CONFIG,
} from "../server/website.js";
import { setProjectConfig } from "../server/metadata.js";

// FBMCPB-34 — clobber guard: site tools must never overwrite a hand-built
// index.html (no generator marker) at websiteLocation. deploy_site once
// replaced a 188KB production homepage with a 1.5KB generated stub.

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbcg-"));
  return { dir, board: { projectDir: () => dir } };
}
function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const HAND_BUILT = "<!doctype html>\n<html><head><title>Shipped</title></head>" +
  `<body>${"<p>production homepage</p>".repeat(50)}</body></html>\n`;

// (a) hand-built index.html without the marker → renderSite refuses, bytes untouched.
test("renderSite refuses to overwrite a hand-built index.html and leaves it untouched", () => {
  const { board } = tmpBoard();
  const ext = tmpDir("fbcg-ext-");
  setProjectConfig(board, "P", { websiteLocation: ext });
  fs.writeFileSync(path.join(ext, SITE_HTML), HAND_BUILT);

  const res = renderSite(board, "P");
  assert.equal(res.skipped, true);
  assert.match(res.reason, /marker|generated/i);
  assert.equal(res.htmlPath, path.join(ext, SITE_HTML));
  assert.equal(res.existingBytes, Buffer.byteLength(HAND_BUILT));

  // The file's bytes are byte-for-byte untouched, and no config/sub-pages appeared.
  assert.equal(fs.readFileSync(path.join(ext, SITE_HTML), "utf8"), HAND_BUILT);
  assert.ok(!fs.existsSync(path.join(ext, SITE_CONFIG)), "no site.json written");

  // setSite/addPage go through the same guard: refusal, still untouched.
  const s = setSite(board, "P", { title: "Stub", sections: [] });
  assert.equal(s.skipped, true);
  const p = addPage(board, "P", { slug: "pricing", title: "Pricing" });
  assert.equal(p.skipped, true);
  assert.ok(!fs.existsSync(path.join(ext, "pricing.html")), "no sub-page written");
  assert.equal(fs.readFileSync(path.join(ext, SITE_HTML), "utf8"), HAND_BUILT);
});

// (b) fresh empty dir → first write is allowed and the output carries the marker.
test("fresh empty dir: renders fine and output contains the generator marker", () => {
  const { board } = tmpBoard();
  const ext = tmpDir("fbcg-fresh-");
  setProjectConfig(board, "P", { websiteLocation: ext });

  const res = setSite(board, "P", { title: "New Site", sections: [{ heading: "H", body: "B" }] });
  assert.ok(!res.skipped, "first write into an empty dir is allowed");
  assert.equal(res.title, "New Site");

  const html = fs.readFileSync(path.join(ext, SITE_HTML), "utf8");
  assert.ok(html.includes(GENERATED_MARKER), "generated output contains the marker");
  assert.ok(fs.existsSync(path.join(ext, SITE_CONFIG)));
});

// (c) re-render over its own generated output → allowed (marker present).
test("re-render over generated output is allowed (setSite/editSection/addPage/renderSite)", () => {
  const { board } = tmpBoard();
  const ext = tmpDir("fbcg-regen-");
  setProjectConfig(board, "P", { websiteLocation: ext });
  setSite(board, "P", { title: "Gen", sections: [{ heading: "A", body: "a" }] });

  const r1 = renderSite(board, "P");
  assert.ok(!r1.skipped, "renderSite over its own output passes the guard");

  const r2 = setSite(board, "P", { title: "Gen v2" });
  assert.ok(!r2.skipped);
  const r3 = editSection(board, "P", { index: 0, heading: "A2" });
  assert.ok(!r3.skipped);
  const r4 = addPage(board, "P", { slug: "docs", title: "Docs" });
  assert.ok(!r4.skipped);
  assert.equal(r4.pages, 1);
  assert.ok(fs.existsSync(path.join(ext, "docs.html")));

  const html = fs.readFileSync(path.join(ext, SITE_HTML), "utf8");
  assert.ok(html.includes("Gen v2"));
  assert.ok(html.includes(GENERATED_MARKER), "re-rendered output still carries the marker");
});

// (d) force:true bypasses the guard and overwrites a hand-built file.
test("renderSite force:true overwrites a hand-built index.html", () => {
  const { board } = tmpBoard();
  const ext = tmpDir("fbcg-force-");
  setProjectConfig(board, "P", { websiteLocation: ext });
  fs.writeFileSync(path.join(ext, SITE_HTML), HAND_BUILT);

  const res = renderSite(board, "P", { force: true });
  assert.ok(!res.skipped, "force bypasses the guard");
  assert.equal(res.htmlPath, "site/index.html");

  const html = fs.readFileSync(path.join(ext, SITE_HTML), "utf8");
  assert.notEqual(html, HAND_BUILT);
  assert.ok(html.includes(GENERATED_MARKER));
});

// Pad default location (no websiteLocation) still works end-to-end.
test("pad site (no websiteLocation): first render and re-render both pass", () => {
  const { board, dir } = tmpBoard();
  const r1 = setSite(board, "P", { title: "Pad", sections: [] });
  assert.ok(!r1.skipped);
  const r2 = renderSite(board, "P");
  assert.ok(!r2.skipped);
  const html = fs.readFileSync(path.join(dir, "site", SITE_HTML), "utf8");
  assert.ok(html.includes(GENERATED_MARKER));
});
