/**
 * FeatureBoard code file explorer (FBMCPF-82).
 *
 * Ports file-explorer / file-map / file-content / file-split: list and read files
 * under a project's codeLocation, and map the tree flagging oversized files as
 * split candidates (feeds work packets / the deep-clean flow). All functions take
 * the resolved root directory (codeLocation) so they're decoupled + testable; the
 * index.js tools resolve it from project config.
 *
 * Everything is sandboxed to the root: paths are resolved and verified to stay
 * within it (no `..` escape), and noisy build/vendor dirs are skipped.
 */

import fs from "node:fs";
import path from "node:path";

const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", "coverage",
  ".versions", ".cache", ".turbo", "out", "vendor", ".venv", "__pycache__",
]);

const SPLIT_LINES = 400;
const SPLIT_BYTES = 32 * 1024;

// FBMCPF-203: symbol-level map. Regex-based (no AST dependency) extraction of a
// file's top-level *exported* symbols, for the source languages we care about.
const SYMBOL_EXTS = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"]);
const MAX_SYMBOLS_PER_FILE = 100;

/**
 * Extract top-level exported symbols from JS/TS source via line-anchored regexes
 * (no AST): `export [default] [async] function X`, `export class X`, and
 * `export const|let|var X = ...` (marked "function" when the value is an arrow
 * or function expression, else "const"). Returns [{ name, kind, line }] capped
 * at maxSymbols. Pure — the caller decides which files to feed it.
 */
export function extractExportedSymbols(content, { maxSymbols = MAX_SYMBOLS_PER_FILE } = {}) {
  const out = [];
  const lines = String(content || "").split(/\r?\n/);
  const re = /^\s*export\s+(?:default\s+)?(?:async\s+)?(function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (!m) continue;
    const kw = m[1];
    let kind;
    if (kw === "class") kind = "class";
    else if (kw.startsWith("function")) kind = "function";
    else kind = /=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/.test(lines[i]) ? "function" : "const";
    out.push({ name: m[2], kind, line: i + 1 });
    if (out.length >= maxSymbols) break;
  }
  return out;
}

/** Resolve `rel` under `root`, throwing if it escapes the root. Returns abs path. */
export function resolveWithin(root, rel = "") {
  const base = path.resolve(root);
  const abs = path.resolve(base, rel || ".");
  const rp = path.relative(base, abs);
  if (rp === "" ) return base;
  if (rp.startsWith("..") || path.isAbsolute(rp)) throw new Error(`path escapes codeLocation: ${rel}`);
  return abs;
}

/** Heuristic: does a buffer look like binary (has NUL in its head)? */
export function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function statSafe(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

/**
 * List one directory level (or a subpath) under root: child dirs and files with
 * sizes. Bounded by `depth` (1 = just this level); ignores vendor/build dirs.
 */
export function listCodeTree(root, { subpath = "", depth = 1 } = {}) {
  const start = resolveWithin(root, subpath);
  const st = statSafe(start);
  if (!st) throw new Error(`not found: ${subpath || "."}`);
  if (!st.isDirectory()) throw new Error(`not a directory: ${subpath || "."}`);

  const walk = (abs, d) => {
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return [];
    }
    const out = [];
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.name.startsWith(".") && e.name !== ".featureboard.config.json") {
        // skip dotfiles except keep it simple — still show non-ignored ones
      }
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name)) continue;
        const node = { type: "dir", name: e.name, path: path.relative(path.resolve(root), path.join(abs, e.name)) };
        if (d > 1) node.children = walk(path.join(abs, e.name), d - 1);
        out.push(node);
      } else if (e.isFile()) {
        const fp = path.join(abs, e.name);
        const s = statSafe(fp);
        out.push({
          type: "file",
          name: e.name,
          path: path.relative(path.resolve(root), fp),
          sizeBytes: s ? s.size : null,
          ext: path.extname(e.name).toLowerCase() || null,
        });
      }
    }
    return out;
  };

  return { root: path.resolve(root), subpath: subpath || "", depth, entries: walk(start, depth) };
}

/**
 * Read a file under root as UTF-8 text (size-capped). Binary files are not
 * dumped — a flag + size is returned instead. Also returns a line count.
 */
export function readCodeFile(root, relPath, { maxBytes = 200 * 1024 } = {}) {
  if (!relPath) throw new Error("relPath is required");
  const abs = resolveWithin(root, relPath);
  const st = statSafe(abs);
  if (!st) throw new Error(`file not found: ${relPath}`);
  if (st.isDirectory()) throw new Error(`${relPath} is a directory (use list_code_files)`);
  const buf = fs.readFileSync(abs);
  if (looksBinary(buf)) {
    return { path: relPath, sizeBytes: st.size, binary: true, content: null, note: "binary file — content not shown" };
  }
  const truncated = buf.length > maxBytes;
  const slice = truncated ? buf.subarray(0, maxBytes) : buf;
  const content = slice.toString("utf8");
  const lines = content.length ? content.split("\n").length : 0;
  return { path: relPath, sizeBytes: st.size, lines, truncated, content };
}

/**
 * Recursively map the tree (bounded depth): total files, bytes, and per-language
 * counts, plus the files that exceed the split thresholds (lines or bytes) as
 * split candidates — worst first — to feed decompose/refactor work.
 */
export function codeFileMap(root, { maxDepth = 6, splitLines = SPLIT_LINES, splitBytes = SPLIT_BYTES, symbols = false, maxSymbolsPerFile = MAX_SYMBOLS_PER_FILE } = {}) {
  const base = path.resolve(root);
  const st = statSafe(base);
  if (!st || !st.isDirectory()) throw new Error(`codeLocation not found or not a directory: ${root}`);

  let fileCount = 0;
  let totalBytes = 0;
  const byExt = {};
  const candidates = [];
  const symbolMap = {}; // FBMCPF-203: rel path -> exported symbols (when symbols:true)

  const walk = (abs, d) => {
    if (d < 0) return;
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name)) continue;
        walk(path.join(abs, e.name), d - 1);
      } else if (e.isFile()) {
        const fp = path.join(abs, e.name);
        const s = statSafe(fp);
        if (!s) continue;
        fileCount += 1;
        totalBytes += s.size;
        const ext = path.extname(e.name).toLowerCase() || "(none)";
        byExt[ext] = (byExt[ext] || 0) + 1;
        // count lines cheaply for text-ish files under a sane cap; reuse the
        // same read for symbol extraction (FBMCPF-203) so we never read twice.
        let lines = null;
        let text = null;
        if (s.size <= 2 * 1024 * 1024) {
          try {
            const buf = fs.readFileSync(fp);
            if (!looksBinary(buf)) { text = buf.toString("utf8"); lines = text.split("\n").length; }
          } catch {
            /* ignore */
          }
        }
        if ((lines != null && lines >= splitLines) || s.size >= splitBytes) {
          candidates.push({ path: path.relative(base, fp), lines, sizeBytes: s.size });
        }
        if (symbols && text != null && SYMBOL_EXTS.has(path.extname(e.name).toLowerCase())) {
          const syms = extractExportedSymbols(text, { maxSymbols: maxSymbolsPerFile });
          if (syms.length) symbolMap[path.relative(base, fp)] = syms;
        }
      }
    }
  };
  walk(base, maxDepth);

  candidates.sort((a, b) => (b.lines || 0) - (a.lines || 0) || b.sizeBytes - a.sizeBytes);
  return {
    root: base,
    fileCount,
    totalBytes,
    byExt,
    splitThreshold: { lines: splitLines, bytes: splitBytes },
    splitCandidates: candidates,
    ...(symbols ? { symbols: symbolMap, symbolFileCount: Object.keys(symbolMap).length } : {}),
  };
}
