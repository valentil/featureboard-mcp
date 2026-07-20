// FBMCPB-19 — the board UI artifact (artifact/board.html) calls back into this
// server via a `call(tool, args)` wrapper that resolves to
// window.cowork.callMcpTool("mcp__FeatureBoard__" + tool, args). get_board used
// to tell the calling agent to hand-pick "this server's tools" for the
// artifact's mcp_tools allowlist from memory, which drifted from what
// board.html actually calls (get_test_runs and get_scratchpad went missing,
// breaking those panels with "not in this artifact's mcp_tools allowlist").
//
// The fix (server/index.js, extractBoardToolNames) makes get_board derive the
// mcp_tools allowlist directly from board.html's own call() sites at request
// time, so the two can't drift apart for any literal tool name. This test is
// the regression guard for that: it re-implements the identical extraction
// algorithm (index.js can't be imported directly — main() connects a stdio
// transport as a side effect of module load) and asserts:
//   1. every call() site in board.html resolves to a literal tool name (no
//      dynamic/unresolvable call sites silently falling through the cracks)
//   2. every extracted name is an actual tool registered in server/index.js
//   3. the specific tools this ticket was filed over are present
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const boardHtml = fs.readFileSync(path.join(root, "artifact", "board.html"), "utf8");
// FBMCPF-224: registerTool/registerPrompt calls were split out of index.js
// into server/register/*.js. Concatenate index.js with each register module
// IN IMPORT ORDER (= registration order) so the same split-on-register
// parsing sees every tool/prompt and preserves the original ordering.
const serverSrc = (() => {
  const indexSrc = fs.readFileSync(path.join(root, "server", "index.js"), "utf8");
  const parts = [indexSrc];
  const re = /from\s+["\']\.\/register\/([^"\']+)["\']/g;
  let m;
  while ((m = re.exec(indexSrc))) {
    parts.push(fs.readFileSync(path.join(root, "server", "register", m[1]), "utf8"));
  }
  return parts.join("\n");
})();

/**
 * Mirrors extractBoardToolNames() in server/index.js. Keep the two in sync —
 * see the comment there for why this can't just import the real function.
 * Returns { names: string[], unresolved: number } where `unresolved` counts
 * call() sites whose tool-name argument isn't a literal string (or a ternary
 * of two literal strings), i.e. sites this parser (and therefore get_board's
 * live allowlist) can't see into.
 */
function extractBoardToolNames(html) {
  const names = new Set();
  let unresolved = 0;
  const callRe = /\bcall\(/g;
  let m;
  while ((m = callRe.exec(html))) {
    const start = callRe.lastIndex;
    let depth = 1;
    let i = start;
    let firstArgEnd = -1;
    while (i < html.length && depth > 0) {
      const c = html[i];
      if (c === "(") depth++;
      else if (c === ")") {
        depth--;
        if (depth === 0) break;
      } else if (c === "," && depth === 1 && firstArgEnd === -1) {
        firstArgEnd = i;
      }
      i++;
    }
    const firstArg = html.slice(start, firstArgEnd === -1 ? i : firstArgEnd).trim();
    if (!firstArg) continue;
    // skip the wrapper's own definition: `async function call(tool, args = {})`
    if (/^tool\s*$/.test(firstArg)) continue;

    const qmark = firstArg.indexOf("?");
    let branches;
    if (qmark === -1) {
      branches = [firstArg];
    } else {
      const rest = firstArg.slice(qmark + 1);
      const colon = rest.indexOf(":");
      branches = colon === -1 ? [rest] : [rest.slice(0, colon), rest.slice(colon + 1)];
    }
    let resolvedAny = false;
    for (const branch of branches) {
      const lit = branch.match(/^\s*["'`]([a-zA-Z_][a-zA-Z0-9_]*)["'`]\s*$/);
      if (lit) {
        names.add(lit[1]);
        resolvedAny = true;
      }
    }
    if (!resolvedAny) unresolved++;
  }
  return { names: [...names].sort(), unresolved };
}

/** Every tool name registered via server.registerTool(...) in server/index.js. */
function findRegisteredTools(src) {
  const chunks = src.split(/server\.registerTool\(/).slice(1);
  const names = [];
  for (const c of chunks) {
    const name = (c.match(/^\s*"([^"]+)"/) || [])[1];
    if (name) names.push(name);
  }
  return names;
}

/** The CORE_TOOLS allowlist (FEATUREBOARD_TOOLS=core gate) parsed from server/index.js. */
function findCoreTools(src) {
  const start = src.indexOf("const CORE_TOOLS = new Set([");
  const end = src.indexOf("]);", start);
  if (start === -1 || end === -1) return new Set();
  const block = src.slice(start, end);
  return new Set([...block.matchAll(/"([a-zA-Z_][a-zA-Z0-9_]*)"/g)].map((m) => m[1]));
}

test("extractBoardToolNames sanity: parses a non-empty set of tool names from board.html", () => {
  const { names } = extractBoardToolNames(boardHtml);
  assert.ok(names.length > 0, "expected at least one call()'d tool name — parser may be broken");
});

test("every call() site in board.html resolves to a literal tool name (no unresolvable/dynamic call sites)", () => {
  const { unresolved } = extractBoardToolNames(boardHtml);
  assert.equal(
    unresolved,
    0,
    "found a call(...) site in board.html whose tool name isn't a plain string literal (or a " +
      "cond ? \"a\" : \"b\" ternary of literals) — get_board's live mcp_tools allowlist is derived " +
      "by statically parsing call() sites, so a dynamic tool-name expression here would silently " +
      "be missing from the allowlist. Use a literal or two-branch ternary, or update the extractor."
  );
});

test("board.html calls the known previously-missing tools (canary for the FBMCPB-19 bug)", () => {
  const { names } = extractBoardToolNames(boardHtml);
  for (const known of ["get_test_runs", "get_scratchpad", "append_scratchpad", "get_work_log", "get_health", "get_metrics"]) {
    assert.ok(names.includes(known), `expected board.html to call "${known}"`);
  }
});

test("every tool board.html calls is actually registered in server/index.js", () => {
  const { names } = extractBoardToolNames(boardHtml);
  const registered = new Set(findRegisteredTools(serverSrc));
  const missing = names.filter((name) => !registered.has(name));
  assert.deepEqual(
    missing,
    [],
    `board.html calls tool(s) that aren't registered in server/index.js: ${missing.join(", ")} — ` +
      "either the UI has a typo/stale name, or the server tool was renamed/removed without updating board.html."
  );
});

test("get_board's advertised mcp_tools allowlist (server/index.js) is built from board.html's own call() sites, not a hand-maintained list", () => {
  // Guards against reverting to a hardcoded/manually-synced allowlist that can
  // silently drift from board.html again (the original FBMCPB-19 root cause).
  assert.match(
    serverSrc,
    /function extractBoardToolNames\(html\)/,
    "expected server/index.js to derive get_board's mcp_tools allowlist from board.html at request time " +
      "(extractBoardToolNames) rather than from a static, hand-maintained tool list"
  );
});


test("every tool board.html calls is in CORE_TOOLS (so the board UI works in FEATUREBOARD_TOOLS=core mode) — FBMCPF-206", () => {
  const { names } = extractBoardToolNames(boardHtml);
  const core = findCoreTools(serverSrc);
  const missing = names.filter((name) => !core.has(name));
  assert.deepEqual(
    missing,
    [],
    `board.html calls tool(s) absent from CORE_TOOLS: ${missing.join(", ")} — in an Essential-tools-only ` +
      "install (FEATUREBOARD_TOOLS=core) those tools aren't registered, so the board UI panels that call " +
      "them break even though the derived allowlist advertises them. Add them to CORE_TOOLS in server/index.js."
  );
});
