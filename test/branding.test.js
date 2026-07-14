import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setProjectConfig, getProjectConfig, brandContext, normalizeColor } from "../server/metadata.js";

// FBMCPF-117 — consistent branding kit

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbbrand-"));
  return { dir, board: { projectDir: () => dir } };
}

test("brand config roundtrips through set/getProjectConfig", () => {
  const { board } = tmpBoard();
  setProjectConfig(board, "P", { brandTitle: "Acme", brandPrimary: "#0af", brandAccent: "#f50", brandFont: "Inter, sans-serif" });
  const cfg = getProjectConfig(board, "P");
  assert.equal(cfg.brandTitle, "Acme");
  assert.equal(cfg.brandPrimary, "#0af");
  assert.equal(cfg.brandFont, "Inter, sans-serif");
});

test("brandContext builds colors, cssVars, instruction, hasBrand", () => {
  const { board } = tmpBoard();
  assert.equal(brandContext(board, "P").hasBrand, false);
  setProjectConfig(board, "P", {
    brandTitle: "Acme", brandSubtitle: "we build", brandWords: ["fast", "yours"],
    brandVoice: "confident", brandPrimary: "#0af", brandAccent: "#f50",
    brandFont: "Inter", brandLogo: "assets/logo.png",
  });
  const b = brandContext(board, "P");
  assert.equal(b.hasBrand, true);
  assert.equal(b.primary, "#0af");
  assert.equal(b.accent, "#f50");
  assert.match(b.cssVars, /--brand-primary:#0af/);
  assert.match(b.cssVars, /--brand-accent:#f50/);
  assert.match(b.instruction, /Brand colors/);
  assert.match(b.instruction, /Logo: assets\/logo\.png/);
  assert.deepEqual(b.words, ["fast", "yours"]);
});

// FBMCPF-118 — polish
test("normalizeColor cleans hex, passes rgb/names through", () => {
  assert.equal(normalizeColor("0af"), "#0af");
  assert.equal(normalizeColor("#00AAFF"), "#00aaff");
  assert.equal(normalizeColor("00aaff"), "#00aaff");
  assert.equal(normalizeColor("rgb(0, 170, 255)"), "rgb(0, 170, 255)");
  assert.equal(normalizeColor("rebeccapurple"), "rebeccapurple");
  assert.equal(normalizeColor(""), null);
  assert.equal(normalizeColor(null), null);
});

test("brandContext normalizes colors and builds a swatch", () => {
  const { board } = tmpBoard();
  setProjectConfig(board, "P", { brandPrimary: "0af", brandAccent: "#F50" });
  const b = brandContext(board, "P");
  assert.equal(b.primary, "#0af");
  assert.equal(b.accent, "#f50");
  assert.match(b.swatch, /background:#0af/);
  assert.match(b.swatch, /background:#f50/);
  assert.match(b.cssVars, /--brand-primary:#0af/);
});
