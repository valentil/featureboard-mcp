/**
 * FeatureBoard website / splash builder (FBMCPF-50) + login gate (FBMCPF-51).
 *
 * Ports the OpenClaw website.js + webLiveEditor + loginCore: build and edit a
 * project splash/marketing site, rendered to static HTML on disk:
 *
 *   <project>/site/
 *     site.json     config: { title, tagline, theme, sections:[{heading,body}], loginGate }
 *     index.html    rendered splash page (regenerated on every edit)
 *
 * setSite writes the whole config; editSection is the "live editor" (patch one
 * section and re-render). setLoginGate toggles an optional client-side passcode
 * gate (FBMCPF-51) — a soft gate for casual gating, NOT real authentication
 * (the passcode ships in the page); real auth needs a hosting layer.
 *
 * renderSiteHtml + defaultSite are pure and exported for tests.
 */

import fs from "node:fs";
import path from "node:path";
import { getProjectConfig } from "./metadata.js";

export const SITE_DIR = "site";
export const SITE_CONFIG = "site.json";
export const SITE_HTML = "index.html";
export const ASSETS_DIR = "assets";

/** Minimal HTML escape. */
export function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Allow only hex / rgb() / hsl() / simple-name colors; else fall back. */
export function safeColor(c, fallback) {
  const v = String(c == null ? "" : c).trim();
  return /^#[0-9a-fA-F]{3,8}$|^(rgb|hsl)a?\([0-9.,%\s/]+\)$|^[a-zA-Z]{3,20}$/.test(v) ? v : fallback;
}
/** Allow a CSS font-family list (letters, spaces, commas, quotes, hyphens); else fall back. */
export function safeFont(f, fallback) {
  const v = String(f == null ? "" : f).trim();
  return v && /^[-\w\s,'"]+$/.test(v) ? v : fallback;
}

/** Default site config. */
export function defaultSite(project) {
  return {
    title: project ? String(project) : "My Project",
    tagline: "",
    theme: "light",
    sections: [],
    pages: [],
    loginGate: { enabled: false, passcode: null, message: "This site is private." },
    updatedAt: null,
  };
}

/** Build a sub-page's render config, inheriting theme + login gate from the site. */
function pageConfig(cfg, page) {
  return {
    title: page.title || cfg.title,
    tagline: page.tagline || "",
    theme: cfg.theme,
    sections: Array.isArray(page.sections) ? page.sections : [],
    loginGate: cfg.loginGate,
    analytics: cfg.analytics,
    seo: { ...(cfg.seo || {}), ...(page.seo || {}) },
    colors: cfg.colors,
    font: cfg.font,
  };
}

/**
 * Build the analytics <script> to inject into the site head (pure). Supports
 * plausible + GA(4) by id, or a raw custom snippet. Empty string when unset/off.
 */
export function analyticsSnippet(a) {
  if (!a || a.enabled === false) return "";
  const provider = String(a.provider || (a.snippet ? "custom" : "")).toLowerCase();
  const safeId = a.id ? String(a.id).replace(/[^A-Za-z0-9._-]/g, "") : "";
  if (provider === "plausible" && safeId) {
    return `<script defer data-domain="${safeId}" src="https://plausible.io/js/script.js"></script>`;
  }
  if ((provider === "ga" || provider === "ga4" || provider === "google") && safeId) {
    return (
      `<script async src="https://www.googletagmanager.com/gtag/js?id=${safeId}"></script>\n` +
      `<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}` +
      `gtag('js',new Date());gtag('config','${safeId}');</script>`
    );
  }
  if (a.snippet) return String(a.snippet);
  return "";
}

/** Known SEO fields; everything else on a seo object is ignored. */
export function normalizeSeo(o = {}) {
  const out = {};
  for (const k of ["description", "image", "ogTitle", "ogDescription", "ogType"]) {
    if (o[k] != null) out[k] = String(o[k]);
  }
  return out;
}

/** Per-page SEO <head> tags: description + Open Graph + Twitter card (pure). */
export function seoTags(config = {}) {
  const seo = config.seo && typeof config.seo === "object" ? config.seo : {};
  const title = config.title || "Untitled";
  const desc = seo.description || config.tagline || "";
  const ogTitle = seo.ogTitle || title;
  const ogDesc = seo.ogDescription || desc;
  const ogType = seo.ogType || "website";
  const img = seo.image || null;
  const tags = [];
  if (desc) tags.push(`<meta name="description" content="${esc(desc)}">`);
  tags.push(`<meta property="og:title" content="${esc(ogTitle)}">`);
  if (ogDesc) tags.push(`<meta property="og:description" content="${esc(ogDesc)}">`);
  tags.push(`<meta property="og:type" content="${esc(ogType)}">`);
  tags.push(`<meta name="twitter:card" content="${img ? "summary_large_image" : "summary"}">`);
  if (img) {
    tags.push(`<meta property="og:image" content="${esc(img)}">`);
    tags.push(`<meta name="twitter:image" content="${esc(img)}">`);
  }
  return tags.join("\n");
}

/** Shared nav model (FBMCPF-96): home + every sub-page, marking the current one. */
export function buildNav(cfg = {}, currentSlug) {
  const pages = Array.isArray(cfg.pages) ? cfg.pages : [];
  const items = [{ href: "index.html", label: cfg.title || "Home", slug: "index" }];
  for (const p of pages) {
    if (!p || !p.slug) continue;
    items.push({ href: `${p.slug}.html`, label: p.title || p.slug, slug: p.slug });
  }
  return items.map((it) => ({ ...it, current: it.slug === currentSlug }));
}

/** Render the shared nav (empty for a single-page site). */
function navHtml(nav) {
  if (!Array.isArray(nav) || nav.length <= 1) return "";
  const links = nav
    .map((n) => `<a href="${esc(n.href)}"${n.current ? ' aria-current="page" class="current"' : ""}>${esc(n.label)}</a>`)
    .join("");
  return `<nav class="site-nav">${links}</nav>`;
}

/** Render the splash page HTML from a site config (pure, self-contained). */
export function renderSiteHtml(config = {}) {
  const title = esc(config.title || "Untitled");
  const tagline = config.tagline ? `<p class="tagline">${esc(config.tagline)}</p>` : "";
  const dark = config.theme === "dark";
  const accentColor = safeColor(config.colors && config.colors.accent, "#d97757");
  const primaryColor = safeColor(config.colors && config.colors.primary, accentColor);
  const bodyFont = safeFont(config.font, "system-ui,-apple-system,Segoe UI,Roboto,sans-serif");
  const sections = (Array.isArray(config.sections) ? config.sections : [])
    .map((s) => `<section><h2>${esc(s.heading)}</h2><div class="body">${esc(s.body).replace(/\n/g, "<br>")}</div></section>`)
    .join("\n");
  const gate = config.loginGate && config.loginGate.enabled;
  const gateScript = gate
    ? `<!-- Soft client-side gate (FBMCPF-51): NOT real security — passcode is present in this page. -->
<script>
(function(){
  var PASS=${JSON.stringify(String(config.loginGate.passcode || ""))};
  var MSG=${JSON.stringify(String(config.loginGate.message || "This site is private."))};
  function ok(){document.documentElement.style.filter="";document.body.dataset.gated="";}
  function ask(){
    var v=window.prompt(MSG);
    if(v===PASS){ok();}else if(v!==null){alert("Incorrect passcode.");ask();}
  }
  document.documentElement.style.filter="blur(6px)";document.body.dataset.gated="1";
  window.addEventListener("DOMContentLoaded",ask);
})();
</script>`
    : "";
  return `<!doctype html>
<html lang="en" data-theme="${dark ? "dark" : "light"}"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
${seoTags(config)}
${analyticsSnippet(config.analytics)}
<style>
  :root{--bg:#faf9f5;--fg:#262624;--muted:#6b6862;--accent:${accentColor};--brand-primary:${primaryColor};--brand-font:${bodyFont}}
  html[data-theme="dark"]{--bg:#1f1e1c;--fg:#f2f0e9;--muted:#a8a49a}
  *{box-sizing:border-box}
  body{margin:0;font-family:var(--brand-font);background:var(--bg);color:var(--fg)}
  header{padding:5rem 1.5rem 3rem;text-align:center}
  h1{font-size:2.6rem;margin:0}
  .tagline{color:var(--muted);font-size:1.2rem;margin-top:.6rem}
  main{max-width:760px;margin:0 auto;padding:0 1.5rem 4rem}
  section{padding:1.4rem 0;border-top:1px solid rgba(120,120,120,.18)}
  h2{color:var(--accent);margin:0 0 .4rem}
  .body{line-height:1.6}
  footer{text-align:center;color:var(--muted);padding:2rem;font-size:.85rem}
  .site-nav{display:flex;flex-wrap:wrap;gap:1rem;justify-content:center;padding:1rem 1.5rem;border-bottom:1px solid rgba(120,120,120,.18)}
  .site-nav a{color:var(--muted);text-decoration:none;font-size:.95rem}
  .site-nav a.current,.site-nav a:hover{color:var(--accent)}
</style></head>
<body>
  ${navHtml(config.nav)}
  <header><h1>${title}</h1>${tagline}</header>
  <main>${sections}</main>
  <footer>Built with FeatureBoard</footer>
  ${gateScript}
</body></html>`;
}

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}
function atomicWrite(filePath, data) {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}
function siteDir(board, project) {
  // FBMCPF-249: a project's shipped website can live outside the pad. When
  // websiteLocation is configured (non-empty), site tools operate on that
  // absolute path; otherwise fall back to the pad's <project>/site/ folder.
  try {
    const cfg = getProjectConfig(board, project);
    const loc = cfg && cfg.websiteLocation ? String(cfg.websiteLocation).trim() : "";
    if (loc) return path.resolve(loc);
  } catch { /* fall through to the default pad location */ }
  return path.join(board.projectDir(project), SITE_DIR);
}

/** Read the site config (defaults if none yet). */
export function getSite(board, project) {
  const cfg = readJsonSafe(path.join(siteDir(board, project), SITE_CONFIG));
  return cfg || defaultSite(project);
}

/** Absolute path to the project's rendered site folder (the deployable unit). */
export function siteRoot(board, project) {
  return siteDir(board, project);
}

/** Validate an asset filename: plain basename with an extension, no traversal. */
export function sanitizeAssetFile(name) {
  if (typeof name !== "string" || !name.trim()) throw new Error("asset name is required");
  const n = name.trim();
  if (n !== path.basename(n) || n.includes("/") || n.includes("\\") || n.startsWith(".")) {
    throw new Error(`invalid asset name (use a plain filename with an extension): ${name}`);
  }
  if (!path.extname(n)) throw new Error("asset name needs a file extension, e.g. logo.png");
  return n;
}

/** Save an image/asset under site/assets/ (base64 by default). Reference it as assets/<name>. */
export function saveAsset(board, project, { name, content, encoding = "base64" } = {}) {
  const safe = sanitizeAssetFile(name);
  if (typeof content !== "string") throw new Error("content must be a string (base64, or utf8 text)");
  if (encoding !== "base64" && encoding !== "utf8") throw new Error("encoding must be 'base64' or 'utf8'");
  const dir = path.join(siteDir(board, project), ASSETS_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const buf = encoding === "base64" ? Buffer.from(content, "base64") : Buffer.from(content, "utf8");
  atomicWrite(path.join(dir, safe), buf);
  return { project, name: safe, relPath: `${SITE_DIR}/${ASSETS_DIR}/${safe}`, ref: `${ASSETS_DIR}/${safe}`, sizeBytes: buf.length };
}

/** List assets under site/assets/. */
export function listAssets(board, project) {
  const dir = path.join(siteDir(board, project), ASSETS_DIR);
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return { project, count: 0, assets: [] };
  }
  const assets = files
    .filter((f) => !f.startsWith("."))
    .map((f) => {
      let size = null;
      try { size = fs.statSync(path.join(dir, f)).size; } catch { /* ignore */ }
      return { name: f, relPath: `${SITE_DIR}/${ASSETS_DIR}/${f}`, ref: `${ASSETS_DIR}/${f}`, sizeBytes: size };
    });
  return { project, count: assets.length, assets };
}

/** Re-render the whole site (home + all pages) from the current config. */
export function renderSite(board, project, { now = new Date() } = {}) {
  return persist(board, project, getSite(board, project), now);
}

/** Write config + re-render index.html. Returns config summary + html path. */
function persist(board, project, cfg, now) {
  cfg.updatedAt = now.toISOString();
  const dir = siteDir(board, project);
  fs.mkdirSync(dir, { recursive: true });
  atomicWrite(path.join(dir, SITE_CONFIG), JSON.stringify(cfg, null, 2) + "\n");
  const html = renderSiteHtml({ ...cfg, nav: buildNav(cfg, "index") });
  atomicWrite(path.join(dir, SITE_HTML), html);
  // Re-render every sub-page so theme / login-gate changes propagate.
  const pages = Array.isArray(cfg.pages) ? cfg.pages : [];
  for (const pg of pages) {
    if (!pg || !pg.slug) continue;
    if (pg.raw) continue; // raw pages (e.g. published media) keep their own HTML
    atomicWrite(path.join(dir, `${pg.slug}.html`), renderSiteHtml({ ...pageConfig(cfg, pg), nav: buildNav(cfg, pg.slug) }));
  }
  return {
    project,
    title: cfg.title,
    sections: (cfg.sections || []).length,
    pages: pages.length,
    loginGate: !!(cfg.loginGate && cfg.loginGate.enabled),
    htmlPath: `${SITE_DIR}/${SITE_HTML}`,
    bytes: Buffer.byteLength(html),
  };
}

/** Set/merge the whole site config (build the site). */
export function setSite(board, project, patch = {}, { now = new Date() } = {}) {
  const cfg = getSite(board, project);
  if (patch.title != null) cfg.title = String(patch.title);
  if (patch.tagline != null) cfg.tagline = String(patch.tagline);
  if (patch.theme != null) {
    if (patch.theme !== "light" && patch.theme !== "dark") throw new Error("theme must be 'light' or 'dark'");
    cfg.theme = patch.theme;
  }
  if (patch.sections != null) {
    if (!Array.isArray(patch.sections)) throw new Error("sections must be an array of { heading, body }");
    cfg.sections = patch.sections.map((s) => ({ heading: String(s.heading || ""), body: String(s.body || "") }));
  }
  if (patch.seo != null) cfg.seo = { ...(cfg.seo || {}), ...normalizeSeo(patch.seo) };
  if (patch.colors != null) {
    const c = patch.colors && typeof patch.colors === "object" ? patch.colors : {};
    cfg.colors = {
      ...(cfg.colors || {}),
      ...(c.primary != null ? { primary: String(c.primary) } : {}),
      ...(c.accent != null ? { accent: String(c.accent) } : {}),
    };
  }
  if (patch.font != null) cfg.font = String(patch.font);
  return persist(board, project, cfg, now);
}

/**
 * Live editor: patch one section by index (or append when index is omitted/out of
 * range) and re-render. Returns the persisted summary.
 */
export function editSection(board, project, { index, heading, body } = {}, { now = new Date() } = {}) {
  const cfg = getSite(board, project);
  cfg.sections = Array.isArray(cfg.sections) ? cfg.sections : [];
  if (index == null || index < 0 || index >= cfg.sections.length) {
    if (!heading && !body) throw new Error("new section needs a heading or body");
    cfg.sections.push({ heading: String(heading || ""), body: String(body || "") });
  } else {
    if (heading != null) cfg.sections[index].heading = String(heading);
    if (body != null) cfg.sections[index].body = String(body);
  }
  return persist(board, project, cfg, now);
}

/** Filesystem-safe page slug (not "index" — that's the home page, via set_site). */
export function sanitizeSlug(slug) {
  const s = String(slug || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!s) throw new Error("page slug must contain letters or numbers");
  if (s === "index") throw new Error("'index' is the home page — edit it with set_site");
  return s;
}

/**
 * Add or update a sub-page (rendered to site/<slug>.html). Multi-page support
 * (FBMCPF-68). The home page stays managed by set_site.
 */
export function addPage(board, project, { slug, title, sections, seo } = {}, { now = new Date() } = {}) {
  const safe = sanitizeSlug(slug);
  const cfg = getSite(board, project);
  cfg.pages = Array.isArray(cfg.pages) ? cfg.pages : [];
  const secs = Array.isArray(sections) ? sections.map((s) => ({ heading: String(s.heading || ""), body: String(s.body || "") })) : [];
  const existing = cfg.pages.find((p) => p.slug === safe);
  if (existing) {
    if (title != null) existing.title = String(title);
    if (sections != null) existing.sections = secs;
    if (seo != null) existing.seo = { ...(existing.seo || {}), ...normalizeSeo(seo) };
  } else {
    cfg.pages.push({ slug: safe, title: title ? String(title) : safe, sections: secs, seo: normalizeSeo(seo || {}) });
  }
  persist(board, project, cfg, now);
  return { project, slug: safe, path: `${SITE_DIR}/${safe}.html`, pages: cfg.pages.length };
}

/**
 * Add a raw-HTML page (its file is written verbatim and preserved on re-render),
 * used to publish media reports/images as site pages (FBMCPF-73).
 */
export function addRawPage(board, project, { slug, title, html } = {}, { now = new Date() } = {}) {
  const safe = sanitizeSlug(slug);
  if (typeof html !== "string" || !html) throw new Error("html content is required");
  const cfg = getSite(board, project);
  cfg.pages = Array.isArray(cfg.pages) ? cfg.pages : [];
  const dir = siteDir(board, project);
  fs.mkdirSync(dir, { recursive: true });
  atomicWrite(path.join(dir, `${safe}.html`), html);
  const existing = cfg.pages.find((p) => p.slug === safe);
  if (existing) {
    if (title != null) existing.title = String(title);
    existing.raw = true;
  } else {
    cfg.pages.push({ slug: safe, title: title ? String(title) : safe, raw: true });
  }
  persist(board, project, cfg, now); // records the page; skips re-rendering this raw file
  return { project, slug: safe, path: `${SITE_DIR}/${safe}.html`, raw: true };
}

/** List the site's pages (home + sub-pages) with their files. */
export function listPages(board, project) {
  const cfg = getSite(board, project);
  const pages = Array.isArray(cfg.pages) ? cfg.pages : [];
  return {
    project,
    index: { slug: "index", title: cfg.title, path: `${SITE_DIR}/${SITE_HTML}`, home: true },
    pages: pages.map((p) => ({ slug: p.slug, title: p.title || p.slug, path: `${SITE_DIR}/${p.slug}.html`, sections: (p.sections || []).length })),
    count: pages.length + 1,
  };
}

/** Remove a sub-page and its rendered file. Throws if the slug isn't found. */
export function removePage(board, project, slug, { now = new Date() } = {}) {
  const safe = sanitizeSlug(slug);
  const cfg = getSite(board, project);
  const pages = Array.isArray(cfg.pages) ? cfg.pages : [];
  const next = pages.filter((p) => p.slug !== safe);
  if (next.length === pages.length) throw new Error(`page '${safe}' not found`);
  cfg.pages = next;
  persist(board, project, cfg, now);
  try { fs.unlinkSync(path.join(siteDir(board, project), `${safe}.html`)); } catch { /* ignore */ }
  return { project, removed: safe, pages: next.length };
}

/**
 * Set SEO metadata (description, image, ogTitle, ogDescription, ogType) for the
 * home page (slug omitted or "index") or a sub-page, and re-render. Merges over
 * any existing SEO for that page.
 */
export function setPageSeo(board, project, { slug, ...fields } = {}, { now = new Date() } = {}) {
  const cfg = getSite(board, project);
  const seo = normalizeSeo(fields);
  if (slug == null || slug === "" || slug === "index") {
    cfg.seo = { ...(cfg.seo || {}), ...seo };
    persist(board, project, cfg, now);
    return { project, page: "index", seo: cfg.seo };
  }
  const safe = sanitizeSlug(slug);
  const page = (Array.isArray(cfg.pages) ? cfg.pages : []).find((x) => x.slug === safe);
  if (!page) throw new Error(`page '${safe}' not found`);
  page.seo = { ...(page.seo || {}), ...seo };
  persist(board, project, cfg, now);
  return { project, page: safe, seo: page.seo };
}

// --- Starter templates (FBMCPF-97) ------------------------------------------

export const SITE_TEMPLATES = [
  { id: "landing", name: "Landing page", description: "Marketing splash: hero, features, pricing, and a contact section." },
  { id: "docs", name: "Documentation", description: "Docs site: an overview home plus Getting Started, Guides, and API pages." },
  { id: "blog", name: "Blog", description: "Blog home plus a couple of starter posts as pages." },
];

/** List the available starter templates. */
export function listSiteTemplates() {
  return { count: SITE_TEMPLATES.length, templates: SITE_TEMPLATES };
}

/** Build a starter site config (title/tagline/theme/sections/pages) for a template id. */
export function templateConfig(id, { title } = {}) {
  const t = String(id || "").trim().toLowerCase();
  const name = title ? String(title) : null;
  if (t === "landing") {
    return {
      title: name || "Your Product",
      tagline: "The one-liner that sells it.",
      theme: "light",
      sections: [
        { heading: "What it does", body: "A short paragraph on the core value you deliver." },
        { heading: "Features", body: "- Fast\n- Simple\n- Yours to own" },
        { heading: "Pricing", body: "Free to start. Paid plans when you need them." },
        { heading: "Get in touch", body: "Tell people how to reach you." },
      ],
      pages: [],
    };
  }
  if (t === "docs") {
    return {
      title: name || "Docs",
      tagline: "Everything you need to get started.",
      theme: "light",
      sections: [{ heading: "Overview", body: "What this project is and where to begin." }],
      pages: [
        { slug: "getting-started", title: "Getting Started", sections: [{ heading: "Install", body: "How to install." }, { heading: "Quickstart", body: "Your first steps." }] },
        { slug: "guides", title: "Guides", sections: [{ heading: "Guides", body: "Task-based how-tos." }] },
        { slug: "api", title: "API", sections: [{ heading: "Reference", body: "API reference." }] },
      ],
    };
  }
  if (t === "blog") {
    return {
      title: name || "Blog",
      tagline: "Notes, updates, and ideas.",
      theme: "light",
      sections: [{ heading: "Latest", body: "Recent posts below." }],
      pages: [
        { slug: "hello-world", title: "Hello, world", sections: [{ heading: "Hello, world", body: "The first post." }] },
        { slug: "second-post", title: "Second post", sections: [{ heading: "Second post", body: "Another post." }] },
      ],
    };
  }
  throw new Error(`unknown template "${id}" (use one of: ${SITE_TEMPLATES.map((x) => x.id).join(", ")})`);
}

/** Seed the project site from a starter template (replaces title/tagline/theme/sections/pages) and render. */
export function applySiteTemplate(board, project, id, { title } = {}, { now = new Date() } = {}) {
  const tpl = templateConfig(id, { title });
  const cfg = getSite(board, project);
  cfg.title = tpl.title;
  cfg.tagline = tpl.tagline;
  cfg.theme = tpl.theme;
  cfg.sections = tpl.sections;
  cfg.pages = (Array.isArray(tpl.pages) ? tpl.pages : []).map((p) => ({
    slug: sanitizeSlug(p.slug),
    title: p.title || p.slug,
    sections: Array.isArray(p.sections) ? p.sections : [],
  }));
  const summary = persist(board, project, cfg, now);
  return { ...summary, template: t_id(id) };
}
function t_id(id) { return String(id || "").trim().toLowerCase(); }

/** Toggle/configure the soft login gate (FBMCPF-51) and re-render. */
export function setLoginGate(board, project, { enabled, passcode, message } = {}, { now = new Date() } = {}) {
  const cfg = getSite(board, project);
  const gate = cfg.loginGate && typeof cfg.loginGate === "object" ? cfg.loginGate : {};
  if (enabled != null) gate.enabled = !!enabled;
  if (passcode !== undefined) gate.passcode = passcode == null ? null : String(passcode);
  if (message != null) gate.message = String(message);
  if (gate.enabled && !gate.passcode) throw new Error("a passcode is required to enable the login gate");
  cfg.loginGate = gate;
  const summary = persist(board, project, cfg, now);
  return { ...summary, loginGate: gate.enabled };
}

/**
 * Configure site analytics (FBMCPF-72): plausible/GA by id, or a raw custom
 * snippet. Injected into every page's head on re-render. Defaults to enabled when
 * first set.
 */
export function setSiteAnalytics(board, project, { provider, id, snippet, enabled } = {}, { now = new Date() } = {}) {
  const cfg = getSite(board, project);
  const a = cfg.analytics && typeof cfg.analytics === "object" ? cfg.analytics : {};
  if (provider != null) a.provider = String(provider);
  if (id != null) a.id = String(id);
  if (snippet != null) a.snippet = String(snippet);
  a.enabled = enabled != null ? !!enabled : a.enabled !== false;
  cfg.analytics = a;
  const summary = persist(board, project, cfg, now);
  return { ...summary, analytics: { provider: a.provider || null, id: a.id || null, active: !!analyticsSnippet(a) } };
}
