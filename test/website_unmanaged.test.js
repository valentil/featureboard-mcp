import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getSite, setSite, unmanagedSite,
  GENERATED_MARKER, SITE_HTML, SITE_CONFIG,
} from "../server/website.js";
import { setProjectConfig } from "../server/metadata.js";

// FBMCPB-64 — the READ side of the pad-vs-shipped duality.
//
// The clobber guard (FBMCPB-34) stops site tools overwriting a hand-built
// index.html. But get_site still reported that same directory as an empty
// site, because it reads the site.json sidecar and silently falls back to
// defaultSite() when the sidecar is absent. That false reading is what
// authored FBMCPF-282 — a ticket to "build a landing page" for featureboard.ai
// while a 193KB homepage was already shipping there.
//
// These tests pin the signal, not the config: getSite stays byte-compatible,
// and unmanagedSite() is what tells callers the directory is not empty.

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbum-"));
  return { dir, board: { projectDir: () => dir } };
}
function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const HAND_BUILT = "<!doctype html>\n<html><head><title>Shipped</title></head>" +
  `<body>${"<p>production homepage</p>".repeat(50)}</body></html>\n`;

// (a) The exact FBMCPF-282 shape: real site at websiteLocation, no sidecar.
test("unmanagedSite flags a hand-built site that getSite reports as empty", () => {
  const { board } = tmpBoard();
  const ext = tmpDir("fbum-ext-");
  setProjectConfig(board, "P", { websiteLocation: ext });
  fs.writeFileSync(path.join(ext, SITE_HTML), HAND_BUILT);
  fs.writeFileSync(path.join(ext, "pricing.html"), "<html>pricing</html>");
  fs.writeFileSync(path.join(ext, "install.html"), "<html>install</html>");

  // getSite is unchanged — it still reports the empty sidecar default.
  const cfg = getSite(board, "P");
  assert.equal(cfg.tagline, "");
  assert.equal(cfg.sections.length, 0);

  // ...but the directory is demonstrably not empty, and we now say so.
  const un = unmanagedSite(board, "P");
  assert.ok(un, "expected an unmanaged block");
  assert.equal(un.unmanaged, true);
  assert.equal(un.siteDir, ext);
  assert.equal(un.indexBytes, Buffer.byteLength(HAND_BUILT));
  assert.equal(un.htmlFileCount, 3);
  assert.deepEqual(un.htmlFiles, ["index.html", "install.html", "pricing.html"]);
  // The warning has to name the trap, or it will not stop the next agent.
  assert.match(un.warning, /sidecar/i);
  assert.match(un.warning, /not "no website"|no website/i);
  assert.match(un.warning, /force:true/);
});

// (b) A renderer-owned site is accurately described by getSite — stay quiet.
test("unmanagedSite returns null for a site FeatureBoard generated", () => {
  const { board } = tmpBoard();
  const ext = tmpDir("fbum-own-");
  setProjectConfig(board, "P", { websiteLocation: ext });

  const res = setSite(board, "P", { title: "Ours", tagline: "built here", sections: [{ heading: "H", body: "B" }] });
  assert.ok(!res.skipped, "setSite should write into an empty dir");
  assert.ok(fs.readFileSync(path.join(ext, SITE_HTML), "utf8").includes(GENERATED_MARKER));

  assert.equal(unmanagedSite(board, "P"), null);
});

// (c) Genuinely nothing built yet — also quiet, so the flag stays meaningful.
test("unmanagedSite returns null when there is no index.html at all", () => {
  const { board } = tmpBoard();
  const ext = tmpDir("fbum-empty-");
  setProjectConfig(board, "P", { websiteLocation: ext });

  assert.equal(unmanagedSite(board, "P"), null);
  assert.ok(!fs.existsSync(path.join(ext, SITE_CONFIG)));
});

// (d) Default pad location (no websiteLocation) gets the same protection.
test("unmanagedSite covers the pad site location too", () => {
  const { dir, board } = tmpBoard();
  const padSite = path.join(dir, "site");
  fs.mkdirSync(padSite, { recursive: true });
  fs.writeFileSync(path.join(padSite, SITE_HTML), HAND_BUILT);

  const un = unmanagedSite(board, "P");
  assert.ok(un, "pad-located hand-built site should flag too");
  assert.equal(un.siteDir, padSite);
});

// (e) A stale/empty sidecar sitting next to a real site is the worst case:
//     getSite returns a config that looks authoritative. Still flagged.
test("unmanagedSite flags even when a site.json sidecar exists but the html is not ours", () => {
  const { board } = tmpBoard();
  const ext = tmpDir("fbum-stale-");
  setProjectConfig(board, "P", { websiteLocation: ext });
  fs.writeFileSync(path.join(ext, SITE_HTML), HAND_BUILT);
  fs.writeFileSync(
    path.join(ext, SITE_CONFIG),
    JSON.stringify({ title: "Stale", tagline: "", theme: "light", sections: [], pages: [] }, null, 2)
  );

  const cfg = getSite(board, "P");
  assert.equal(cfg.title, "Stale"); // sidecar wins, and looks real
  assert.equal(cfg.sections.length, 0);

  const un = unmanagedSite(board, "P");
  assert.ok(un, "a sidecar must not suppress the warning — the html is still not ours");
  assert.equal(un.indexBytes, Buffer.byteLength(HAND_BUILT));
});
