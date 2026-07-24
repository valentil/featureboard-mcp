import { test } from "node:test";
import assert from "node:assert/strict";
import { templateConfig, listSiteTemplates, renderSiteHtml, SITE_TEMPLATES } from "../server/website.js";

// FBMCPF-310 — canonical FeatureBoard brand template for site tools.

test("featureboard template is listed", () => {
  assert.ok(SITE_TEMPLATES.some((t) => t.id === "featureboard"));
  assert.equal(listSiteTemplates().count, SITE_TEMPLATES.length);
});

test("templateConfig('featureboard') carries the canonical brand tokens", () => {
  const cfg = templateConfig("featureboard");
  assert.equal(cfg.theme, "dark");
  assert.equal(cfg.colors.accent, "#00d5ff");
  assert.equal(cfg.colors.primary, "#00d5ff");
  assert.match(cfg.font, /DM Sans/);
  assert.ok(cfg.sections.length >= 2);
  const named = templateConfig("featureboard", { title: "SlopRadar" });
  assert.equal(named.title, "SlopRadar");
});

test("renderSiteHtml emits the brand tokens for the featureboard template", () => {
  const html = renderSiteHtml(templateConfig("featureboard"));
  assert.ok(html.includes('data-theme="dark"'));
  assert.ok(html.includes("--accent:#00d5ff"));
  assert.ok(html.includes("DM Sans"));
});

test("existing templates unchanged", () => {
  for (const id of ["landing", "docs", "blog"]) {
    const cfg = templateConfig(id);
    assert.ok(cfg.title && Array.isArray(cfg.sections), `${id} still valid`);
    assert.equal(cfg.colors, undefined, `${id} keeps no forced colors`);
  }
});
