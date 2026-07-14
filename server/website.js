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
    loginGate: { enabled: false, passcode: null, message: "This site is private." },
    updatedAt: null,
  };
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

/** Write config + re-render index.html. Returns config summary + html path. */
function persist(board, project, cfg, now) {
  cfg.updatedAt = now.toISOString();
  const dir = siteDir(board, project);
  fs.mkdirSync(dir, { recursive: true });
  atomicWrite(path.join(dir, SITE_CONFIG), JSON.stringify(cfg, null, 2) + "\n");
  const html = renderSiteHtml(cfg);
  atomicWrite(path.join(dir, SITE_HTML), html);
  return {
    project,
    title: cfg.title,
    sections: (cfg.sections || []).length,
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
