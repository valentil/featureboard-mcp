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

/** Render the splash page HTML from a site config (pure, self-contained). */
export function renderSiteHtml(config = {}) {
  const title = esc(config.title || "Untitled");
  const tagline = config.tagline ? `<p class="tagline">${esc(config.tagline)}</p>` : "";
  const dark = config.theme === "dark";
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
${analyticsSnippet(config.analytics)}
<style>
  :root{--bg:#faf9f5;--fg:#262624;--muted:#6b6862;--accent:#d97757}
  html[data-theme="dark"]{--bg:#1f1e1c;--fg:#f2f0e9;--muted:#a8a49a}
  *{box-sizing:border-box}
  body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--fg)}
  header{padding:5rem 1.5rem 3rem;text-align:center}
  h1{font-size:2.6rem;margin:0}
  .tagline{color:var(--muted);font-size:1.2rem;margin-top:.6rem}
  main{max-width:760px;margin:0 auto;padding:0 1.5rem 4rem}
  section{padding:1.4rem 0;border-top:1px solid rgba(120,120,120,.18)}
  h2{color:var(--accent);margin:0 0 .4rem}
  .body{line-height:1.6}
  footer{text-align:center;color:var(--muted);padding:2rem;font-size:.85rem}
</style></head>
<body>
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
  const html = renderSiteHtml(cfg);
  atomicWrite(path.join(dir, SITE_HTML), html);
  // Re-render every sub-page so theme / login-gate changes propagate.
  const pages = Array.isArray(cfg.pages) ? cfg.pages : [];
  for (const pg of pages) {
    if (!pg || !pg.slug) continue;
    if (pg.raw) continue; // raw pages (e.g. published media) keep their own HTML
    atomicWrite(path.join(dir, `${pg.slug}.html`), renderSiteHtml(pageConfig(cfg, pg)));
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
export function addPage(board, project, { slug, title, sections } = {}, { now = new Date() } = {}) {
  const safe = sanitizeSlug(slug);
  const cfg = getSite(board, project);
  cfg.pages = Array.isArray(cfg.pages) ? cfg.pages : [];
  const secs = Array.isArray(sections) ? sections.map((s) => ({ heading: String(s.heading || ""), body: String(s.body || "") })) : [];
  const existing = cfg.pages.find((p) => p.slug === safe);
  if (existing) {
    if (title != null) existing.title = String(title);
    if (sections != null) existing.sections = secs;
  } else {
    cfg.pages.push({ slug: safe, title: title ? String(title) : safe, sections: secs });
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
