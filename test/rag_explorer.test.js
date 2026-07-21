// get_rag_explorer — the shipped RAG explorer artifact (visual front door to the
// FBMCPF-263/264 research RAG). Mirrors test/board_tools_parity.test.js: the
// artifact's mcp_tools allowlist is derived from its own call() sites, so this
// pins (a) the artifact file ships, (b) extraction finds exactly the tools the
// UI calls, and (c) every one of them is a real registered tool name.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const htmlPath = path.join(root, "artifact", "rag-explorer.html");

// Same extraction the server uses (see extractBoardToolNames in server/index.js;
// re-implemented here because importing index.js connects a stdio transport).
function extractToolNames(html) {
  const names = new Set();
  const callRe = /\bcall\(/g;
  let m;
  while ((m = callRe.exec(html))) {
    const start = callRe.lastIndex;
    let depth = 1, i = start, firstArgEnd = -1;
    while (i < html.length && depth > 0) {
      const c = html[i];
      if (c === "(") depth++;
      else if (c === ")") { depth--; if (depth === 0) break; }
      else if (c === "," && depth === 1 && firstArgEnd === -1) firstArgEnd = i;
      i++;
    }
    const firstArg = html.slice(start, firstArgEnd === -1 ? i : firstArgEnd).trim();
    const lit = firstArg.match(/^\s*["'`]([a-zA-Z_][a-zA-Z0-9_]*)["'`]\s*$/);
    if (lit) names.add(lit[1]);
  }
  return [...names].sort();
}

test("artifact/rag-explorer.html ships and is a full document", () => {
  const html = fs.readFileSync(htmlPath, "utf8");
  assert.ok(html.includes("<!doctype html>"));
  assert.ok(html.includes("cowork-artifact-meta"));
  assert.ok(html.length > 10000, "explorer html suspiciously small");
});

test("explorer call() sites extract to exactly the tools the UI needs", () => {
  const html = fs.readFileSync(htmlPath, "utf8");
  assert.deepEqual(extractToolNames(html), [
    "add_kb_doc",
    "get_kb_doc",
    "list_kb_docs",
    "list_projects",
    "rag_search",
    "search_kb",
  ]);
});

test("every extracted tool is registered in the server source", () => {
  const html = fs.readFileSync(htmlPath, "utf8");
  const registered = new Set();
  const registerDir = path.join(root, "server", "register");
  for (const f of fs.readdirSync(registerDir)) {
    const src = fs.readFileSync(path.join(registerDir, f), "utf8");
    for (const m of src.matchAll(/registerTool\(\s*\n?\s*["']([a-z_]+)["']/g)) registered.add(m[1]);
  }
  for (const name of extractToolNames(html)) {
    assert.ok(registered.has(name), `explorer calls unregistered tool: ${name}`);
  }
});

test("get_rag_explorer is registered and in CORE_TOOLS", () => {
  const boardSrc = fs.readFileSync(path.join(root, "server", "register", "board.js"), "utf8");
  assert.ok(boardSrc.includes('"get_rag_explorer"'));
  const indexSrc = fs.readFileSync(path.join(root, "server", "index.js"), "utf8");
  assert.ok(indexSrc.includes('"get_rag_explorer"'), "get_rag_explorer missing from CORE_TOOLS");
  assert.ok(indexSrc.includes("rag-explorer.html"), "RAG_EXPLORER_HTML_PATH missing");
});
