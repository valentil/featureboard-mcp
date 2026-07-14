/**
 * FeatureBoard test pages (FBMCPF-74).
 *
 * Ports the OpenClaw test-pages CRUD: standalone HTML test/demo pages kept under
 * <project>/test-pages/ that Claude can create, list, read, and remove (e.g. a
 * manual QA harness or a rendered fixture). Plain HTML files on disk — no config.
 *
 * Pure helper (sanitizePageName) is exported for tests.
 */

import fs from "node:fs";
import path from "node:path";

export const TESTPAGES_DIR = "test-pages";

/** Validate a test-page filename: plain basename, .html/.htm, no traversal. */
export function sanitizePageName(name) {
  if (typeof name !== "string" || !name.trim()) throw new Error("page name is required");
  let n = name.trim();
  if (n !== path.basename(n) || n.includes("/") || n.includes("\\") || n.startsWith(".")) {
    throw new Error(`invalid page name (use a plain filename): ${name}`);
  }
  if (!/\.html?$/i.test(n)) n += ".html"; // default to .html
  return n;
}

function atomicWrite(filePath, data) {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}
function pagesDir(board, project) {
  return path.join(board.projectDir(project), TESTPAGES_DIR);
}

/** Create/overwrite a test page. Returns its name + path + size. */
export function saveTestPage(board, project, { name, html } = {}) {
  const safe = sanitizePageName(name);
  if (typeof html !== "string" || !html) throw new Error("html content is required");
  const dir = pagesDir(board, project);
  fs.mkdirSync(dir, { recursive: true });
  atomicWrite(path.join(dir, safe), html);
  return { project, name: safe, path: `${TESTPAGES_DIR}/${safe}`, sizeBytes: Buffer.byteLength(html) };
}

/** List test pages (name, path, size), alphabetical. */
export function listTestPages(board, project) {
  const dir = pagesDir(board, project);
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => /\.html?$/i.test(f) && !f.startsWith("."));
  } catch {
    return { project, count: 0, pages: [] };
  }
  const pages = files.sort().map((f) => {
    let size = null;
    try { size = fs.statSync(path.join(dir, f)).size; } catch { /* ignore */ }
    return { name: f, path: `${TESTPAGES_DIR}/${f}`, sizeBytes: size };
  });
  return { project, count: pages.length, pages };
}

/** Read one test page's HTML. Throws if missing. */
export function getTestPage(board, project, name) {
  const safe = sanitizePageName(name);
  try {
    const html = fs.readFileSync(path.join(pagesDir(board, project), safe), "utf8");
    return { project, name: safe, path: `${TESTPAGES_DIR}/${safe}`, html };
  } catch {
    throw new Error(`test page '${safe}' not found`);
  }
}

/** Delete a test page. Throws if it isn't there. */
export function removeTestPage(board, project, name) {
  const safe = sanitizePageName(name);
  try {
    fs.unlinkSync(path.join(pagesDir(board, project), safe));
  } catch {
    throw new Error(`test page '${safe}' not found`);
  }
  return { project, removed: safe };
}
