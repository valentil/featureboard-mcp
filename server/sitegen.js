/**
 * FeatureBoard one-shot site scaffolding (FBMCPF-94).
 *
 * The original OpenClaw "website/create" flow generated a whole site from a single
 * prompt instead of building it field-by-field. Ported AI-natively: the generate_site
 * prompt has Claude produce the full spec (title, tagline, theme, sections, initial
 * pages), and this scaffolder persists it in one shot by composing the existing
 * website store — set_site for the home page, then add_page for each sub-page — so
 * scaffolding stays byte-compatible with hand-built sites and re-renders the same way.
 *
 * normalizeSpec is pure and exported for tests; scaffoldSite performs the writes via
 * website.js.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setSite, addPage, getSite, siteRoot } from "./website.js";

/**
 * FBMCPF-249: walk up from a directory to the nearest ancestor (inclusive) that
 * contains a `.git` entry. Returns that directory, or null if none is found.
 */
function findGitRootUp(startDir) {
  let dir;
  try {
    dir = path.resolve(String(startDir));
  } catch {
    return null;
  }
  for (let i = 0; i < 64; i++) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * FBMCPF-249 "start one": give a scaffolded site its own git repo. If the dir is
 * already inside a repo, leaves it alone. Otherwise `git init` + a first commit
 * "site: scaffold" (falling back to a machine identity via -c flags when the
 * user's git identity is unset). Tolerant: any git failure returns a warning
 * rather than throwing, so scaffolding never fails because of git.
 */
function initGitRepo(dir) {
  const existing = findGitRootUp(dir);
  if (existing) return { path: existing, initialized: false, note: "already inside a git repo" };
  try {
    fs.mkdirSync(dir, { recursive: true });
    let r = spawnSync("git", ["init"], { cwd: dir, encoding: "utf8" });
    if (r.status !== 0) {
      return { path: dir, initialized: false, warning: `git init failed: ${(r.stderr || "git not available").trim()}` };
    }
    spawnSync("git", ["add", "-A"], { cwd: dir, encoding: "utf8" });
    const idArgs = [];
    const who = spawnSync("git", ["config", "user.name"], { cwd: dir, encoding: "utf8" });
    if (!(who.stdout || "").trim()) {
      idArgs.push("-c", "user.name=FeatureBoard", "-c", "user.email=featureboard@localhost");
    }
    r = spawnSync("git", [...idArgs, "commit", "-m", "site: scaffold"], { cwd: dir, encoding: "utf8" });
    if (r.status !== 0) {
      return { path: dir, initialized: true, committed: false, warning: `git init ok but first commit failed: ${(r.stderr || "").trim()}` };
    }
    return { path: dir, initialized: true, committed: true };
  } catch (e) {
    return { path: dir, initialized: false, warning: `git init error: ${e && e.message ? e.message : String(e)}` };
  }
}

/**
 * Validate + normalize a raw site spec into { home, pages } (pure). Throws on a
 * missing title or malformed sections/pages so a bad scaffold fails fast.
 */
export function normalizeSpec(spec = {}) {
  if (!spec || typeof spec !== "object") throw new Error("site spec must be an object");
  const title = String(spec.title || "").trim();
  if (!title) throw new Error("site scaffold needs a title");
  const theme = spec.theme == null ? undefined : spec.theme;
  if (theme != null && theme !== "light" && theme !== "dark") throw new Error("theme must be 'light' or 'dark'");
  const sections = Array.isArray(spec.sections)
    ? spec.sections.map((s) => ({ heading: String((s && s.heading) || ""), body: String((s && s.body) || "") }))
    : [];
  const rawPages = Array.isArray(spec.pages) ? spec.pages : [];
  const pages = rawPages.map((p, i) => {
    if (!p || typeof p !== "object") throw new Error(`page ${i} must be an object with a slug`);
    if (!p.slug || !String(p.slug).trim()) throw new Error(`page ${i} needs a slug`);
    return {
      slug: String(p.slug).trim(),
      title: p.title ? String(p.title) : String(p.slug).trim(),
      sections: Array.isArray(p.sections)
        ? p.sections.map((s) => ({ heading: String((s && s.heading) || ""), body: String((s && s.body) || "") }))
        : [],
    };
  });
  const home = { title, tagline: spec.tagline != null ? String(spec.tagline) : "", sections };
  if (theme != null) home.theme = theme;
  return { home, pages };
}

/**
 * Scaffold a whole site from one spec: persist the home page (set_site) then create
 * each initial sub-page (add_page). Returns the home summary plus the created pages.
 * `now` is injectable for deterministic tests.
 */
export function scaffoldSite(board, project, spec = {}, { now = new Date(), initGit = false } = {}) {
  const { home, pages } = normalizeSpec(spec);
  const homeSummary = setSite(board, project, home, { now });
  const created = [];
  for (const pg of pages) {
    created.push(addPage(board, project, pg, { now }));
  }
  const site = getSite(board, project);
  const result = {
    project,
    title: home.title,
    theme: site.theme,
    sections: homeSummary.sections,
    pagesCreated: created.length,
    pages: created.map((c) => ({ slug: c.slug, path: c.path })),
    htmlPath: homeSummary.htmlPath,
  };
  // FBMCPF-249: optionally give the shipped site its own per-project repo.
  if (initGit) result.git = initGitRepo(siteRoot(board, project));
  return result;
}
