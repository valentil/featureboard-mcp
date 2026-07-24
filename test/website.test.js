import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  esc, defaultSite, renderSiteHtml, seoTags, normalizeSeo, setPageSeo, buildNav,
  listSiteTemplates, templateConfig, applySiteTemplate, listPages as _lp,
  getSite, setSite, editSection, setLoginGate,
  addPage, listPages, removePage, sanitizeSlug,
  renderSite, siteRoot, saveAsset, listAssets, sanitizeAssetFile,
  analyticsSnippet, setSiteAnalytics,
  SITE_DIR, SITE_HTML, SITE_CONFIG, ASSETS_DIR,
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

// FBMCPF-95 — per-page SEO metadata
test("renderSiteHtml emits description + OG/Twitter tags; falls back to tagline", () => {
  const html = renderSiteHtml({
    title: "Acme", tagline: "We build", theme: "light",
    seo: { description: "Custom desc", image: "assets/og.png", ogType: "article" },
  });
  assert.match(html, /<meta name="description" content="Custom desc">/);
  assert.match(html, /<meta property="og:title" content="Acme">/);
  assert.match(html, /<meta property="og:type" content="article">/);
  assert.match(html, /<meta property="og:image" content="assets\/og.png">/);
  assert.match(html, /twitter:card" content="summary_large_image"/);
  // no image -> summary card, description falls back to tagline
  const h2 = renderSiteHtml({ title: "T", tagline: "Tag" });
  assert.match(h2, /<meta name="description" content="Tag">/);
  assert.match(h2, /twitter:card" content="summary"/);
});

test("normalizeSeo keeps only known string fields", () => {
  assert.deepEqual(normalizeSeo({ description: "d", junk: 1, image: "i" }), { description: "d", image: "i" });
});

test("setPageSeo updates home + sub-page and renders into the file", () => {
  const { board, dir } = tmpBoard();
  setSite(board, "P", { title: "Home", sections: [] });
  addPage(board, "P", { slug: "about", title: "About" });
  const home = setPageSeo(board, "P", { description: "Home desc" });
  assert.equal(home.page, "index");
  assert.match(fs.readFileSync(path.join(dir, SITE_DIR, SITE_HTML), "utf8"), /content="Home desc"/);
  setPageSeo(board, "P", { slug: "about", description: "About desc", ogType: "article" });
  const aboutHtml = fs.readFileSync(path.join(dir, SITE_DIR, "about.html"), "utf8");
  assert.match(aboutHtml, /content="About desc"/);
  assert.match(aboutHtml, /og:type" content="article"/);
  assert.throws(() => setPageSeo(board, "P", { slug: "nope", description: "x" }), /not found/);
});

// FBMCPF-96 — shared nav across pages
test("buildNav lists home + pages and marks current", () => {
  const cfg = { title: "Home", pages: [{ slug: "about", title: "About" }, { slug: "pricing" }] };
  const nav = buildNav(cfg, "about");
  assert.deepEqual(nav.map((n) => n.href), ["index.html", "about.html", "pricing.html"]);
  assert.equal(nav.find((n) => n.slug === "about").current, true);
  assert.equal(nav.find((n) => n.slug === "index").current, false);
  assert.equal(nav[2].label, "pricing"); // slug fallback label
});

test("nav is rendered on home + every sub-page, current-marked", () => {
  const { board, dir } = tmpBoard();
  setSite(board, "P", { title: "Home", sections: [] });
  addPage(board, "P", { slug: "about", title: "About" });
  const home = fs.readFileSync(path.join(dir, SITE_DIR, SITE_HTML), "utf8");
  const about = fs.readFileSync(path.join(dir, SITE_DIR, "about.html"), "utf8");
  assert.match(home, /class="site-nav"/);
  assert.match(home, /href="about.html"/);
  assert.match(home, /href="index.html"[^>]*aria-current="page"/); // home marks index current
  assert.match(about, /href="about.html"[^>]*aria-current="page"/); // about marks itself current
});

test("single-page site renders no nav", () => {
  const html = renderSiteHtml({ title: "Solo", nav: buildNav({ title: "Solo" }, "index") });
  assert.doesNotMatch(html, /<nav/);
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

// FBMCPF-68 — multi-page
test("sanitizeSlug normalizes and rejects empty/index", () => {
  assert.equal(sanitizeSlug("About Us!"), "about-us");
  assert.throws(() => sanitizeSlug("  "), /letters or numbers/);
  assert.throws(() => sanitizeSlug("index"), /home page/);
});

test("addPage renders site/<slug>.html and records it; updates in place", () => {
  const { dir, board } = tmpBoard();
  setSite(board, "P", { title: "Home" });
  const r = addPage(board, "P", { slug: "about", title: "About", sections: [{ heading: "Hi", body: "yo" }] });
  assert.equal(r.slug, "about");
  assert.equal(r.path, "site/about.html");
  assert.ok(fs.existsSync(path.join(dir, SITE_DIR, "about.html")));
  assert.match(fs.readFileSync(path.join(dir, SITE_DIR, "about.html"), "utf8"), /About/);
  addPage(board, "P", { slug: "about", title: "About Us" });
  assert.equal(getSite(board, "P").pages.length, 1);
  assert.equal(getSite(board, "P").pages[0].title, "About Us");
});

test("listPages returns home + subpages; removePage deletes", () => {
  const { dir, board } = tmpBoard();
  setSite(board, "P", { title: "Home" });
  addPage(board, "P", { slug: "about" });
  addPage(board, "P", { slug: "pricing" });
  const l = listPages(board, "P");
  assert.equal(l.index.slug, "index");
  assert.equal(l.count, 3);
  assert.deepEqual(l.pages.map((p) => p.slug), ["about", "pricing"]);
  assert.equal(removePage(board, "P", "about").pages, 1);
  assert.ok(!fs.existsSync(path.join(dir, SITE_DIR, "about.html")));
  assert.throws(() => removePage(board, "P", "nope"), /not found/);
});

test("theme change re-renders sub-pages too", () => {
  const { dir, board } = tmpBoard();
  setSite(board, "P", { title: "Home", theme: "light" });
  addPage(board, "P", { slug: "about", sections: [{ heading: "A", body: "b" }] });
  setSite(board, "P", { theme: "dark" });
  assert.match(fs.readFileSync(path.join(dir, SITE_DIR, "about.html"), "utf8"), /data-theme="dark"/);
});

// FBMCPF-70 — deploy prerequisites
test("renderSite writes index.html; siteRoot points at site/", () => {
  const { dir, board } = tmpBoard();
  const r = renderSite(board, "P");
  assert.equal(r.htmlPath, "site/index.html");
  assert.ok(fs.existsSync(path.join(dir, SITE_DIR, SITE_HTML)));
  assert.equal(siteRoot(board, "P"), path.join(dir, SITE_DIR));
});

// FBMCPF-71 — assets
test("sanitizeAssetFile rejects traversal/dotfile/extensionless", () => {
  assert.equal(sanitizeAssetFile("logo.png"), "logo.png");
  assert.throws(() => sanitizeAssetFile("../x.png"), /invalid asset name/);
  assert.throws(() => sanitizeAssetFile(".hidden"), /invalid asset name/);
  assert.throws(() => sanitizeAssetFile("noext"), /extension/);
});

test("saveAsset writes base64 to site/assets and returns a ref; listAssets lists", () => {
  const { dir, board } = tmpBoard();
  const r = saveAsset(board, "P", { name: "logo.png", content: Buffer.from("PNGDATA").toString("base64") });
  assert.equal(r.ref, "assets/logo.png");
  assert.equal(r.relPath, "site/assets/logo.png");
  assert.equal(fs.readFileSync(path.join(dir, SITE_DIR, ASSETS_DIR, "logo.png"), "utf8"), "PNGDATA");
  saveAsset(board, "P", { name: "style.css", content: "body{}", encoding: "utf8" });
  const l = listAssets(board, "P");
  assert.equal(l.count, 2);
  assert.deepEqual(l.assets.map((a) => a.name).sort(), ["logo.png", "style.css"]);
});

// FBMCPF-72 — analytics
test("analyticsSnippet handles plausible/ga/custom/off + sanitizes id", () => {
  assert.match(analyticsSnippet({ provider: "plausible", id: "ex.com", enabled: true }), /data-domain="ex.com"/);
  assert.match(analyticsSnippet({ provider: "ga", id: "G-ABC", enabled: true }), /gtag\/js\?id=G-ABC/);
  assert.equal(analyticsSnippet({ snippet: "<script>x</script>", enabled: true }), "<script>x</script>");
  assert.equal(analyticsSnippet({ provider: "plausible", id: "x", enabled: false }), "");
  assert.match(analyticsSnippet({ provider: "ga", id: "G-<b>", enabled: true }), /id=G-b/);
});

test("set_site_analytics injects into rendered pages and toggles off", () => {
  const { dir, board } = tmpBoard();
  setSite(board, "P", { title: "Home" });
  addPage(board, "P", { slug: "about" });
  setSiteAnalytics(board, "P", { provider: "plausible", id: "ex.com" });
  assert.match(fs.readFileSync(path.join(dir, SITE_DIR, SITE_HTML), "utf8"), /plausible/);
  assert.match(fs.readFileSync(path.join(dir, SITE_DIR, "about.html"), "utf8"), /plausible/); // on sub-pages too
  setSiteAnalytics(board, "P", { enabled: false });
  assert.doesNotMatch(fs.readFileSync(path.join(dir, SITE_DIR, SITE_HTML), "utf8"), /plausible/);
});

// FBMCPF-97 — starter templates
test("listSiteTemplates + templateConfig build known templates and reject junk", () => {
  const ids = listSiteTemplates().templates.map((t) => t.id);
  assert.deepEqual(ids, ["landing", "docs", "blog", "featureboard"]);
  const docs = templateConfig("docs", { title: "My Docs" });
  assert.equal(docs.title, "My Docs");
  assert.equal(docs.pages.length, 3);
  assert.throws(() => templateConfig("nope"), /unknown template/);
});

test("applySiteTemplate seeds config + pages and renders files", () => {
  const { board, dir } = tmpBoard();
  const r = applySiteTemplate(board, "P", "docs", { title: "Docs" });
  assert.equal(r.template, "docs");
  assert.equal(r.pages, 3);
  assert.match(fs.readFileSync(path.join(dir, SITE_DIR, SITE_HTML), "utf8"), /Docs/);
  assert.ok(fs.existsSync(path.join(dir, SITE_DIR, "getting-started.html")));
  // nav (FBMCPF-96) links the seeded pages
  assert.match(fs.readFileSync(path.join(dir, SITE_DIR, "api.html"), "utf8"), /href="getting-started.html"/);
});

// FBMCPF-117 — brand colors/font in the site
test("renderSiteHtml applies brand colors/font and rejects unsafe values", () => {
  const good = renderSiteHtml({ title: "T", colors: { accent: "#123abc", primary: "#ffffff" }, font: "Inter, sans-serif" });
  assert.match(good, /--accent:#123abc/);
  assert.match(good, /--brand-primary:#ffffff/);
  assert.match(good, /--brand-font:Inter, sans-serif/);
  const bad = renderSiteHtml({ title: "T", colors: { accent: "red;} body{display:none" } });
  assert.match(bad, /--accent:#d97757/); // unsafe value fell back to default
});

test("setSite stores colors + font and renders them (incl. sub-pages)", () => {
  const { board, dir } = tmpBoard();
  setSite(board, "P", { title: "Brandy", colors: { accent: "#00aaff" }, font: "Georgia, serif" });
  addPage(board, "P", { slug: "about", title: "About" });
  const home = fs.readFileSync(path.join(dir, SITE_DIR, SITE_HTML), "utf8");
  const about = fs.readFileSync(path.join(dir, SITE_DIR, "about.html"), "utf8");
  assert.match(home, /--accent:#00aaff/);
  assert.match(home, /--brand-font:Georgia, serif/);
  assert.match(about, /--accent:#00aaff/); // sub-page inherits brand colors
});
