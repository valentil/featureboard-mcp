// ctx USAGE parity — the mirror of ctx_parity.test.js. That test catches names
// destructured from ctx but not provided; this one catches the opposite and
// equally silent failure: a register/*.js module *calls* a ctx-provided helper
// it never pulled into scope (never destructured from ctx, imported, or locally
// declared) — a ReferenceError that only fires when the tool is invoked in
// production. This is exactly FBMCPB-47: get_regressions called computeRegressions
// (a ctx binding) without testing.js destructuring it, so the board's Testing
// panel showed "computeRegressions is not defined". Static analysis, no boot.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const indexSrc = fs.readFileSync(path.join(root, "server", "index.js"), "utf8");
const registerDir = path.join(root, "server", "register");

function ctxProvidedNames() {
  const m = indexSrc.match(/const ctx = \{([\s\S]*?)\n\};/);
  assert.ok(m, "could not locate `const ctx = {...};` in server/index.js");
  return new Set(
    m[1].split(",").map((s) => s.trim()).filter(Boolean)
      .map((s) => s.split(":")[0].trim())
      .filter((s) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s))
  );
}

// Names brought into a module's scope by any means other than "ctx-provided":
//  - destructured from ctx           const { a, b } = ctx;
//  - any other object destructure    const { c } = foo;
//  - default / named / namespace imports
//  - top-level function/const/let/var declarations
function inScopeNames(src) {
  const names = new Set();
  for (const m of src.matchAll(/const\s*\{([\s\S]*?)\}\s*=\s*[A-Za-z_$][\w$.]*\s*;/g))
    for (const raw of m[1].split(",")) { const n = raw.trim().split(":").pop().trim(); if (/^[A-Za-z_$][\w$]*$/.test(n)) names.add(n); }
  for (const m of src.matchAll(/import\s+\{([\s\S]*?)\}\s+from/g))
    for (const raw of m[1].split(",")) { const n = raw.trim().split(/\s+as\s+/).pop().trim(); if (/^[A-Za-z_$][\w$]*$/.test(n)) names.add(n); }
  for (const m of src.matchAll(/import\s+([A-Za-z_$][\w$]*)\s*(?:,|from)/g)) names.add(m[1]);
  for (const m of src.matchAll(/import\s+\*\s+as\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/\b(?:function\*?\s+|const\s+|let\s+|var\s+)([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  return names;
}

// Function-call identifiers, excluding member access (`board.listTasks(`) but
// KEEPING spread calls (`...computeRegressions(`) — the spread's leading dots
// must not be mistaken for property access, which was FBMCPB-47's exact shape.
function calledNames(src) {
  const out = new Set();
  const re = /([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    const i = m.index;
    if (src[i - 1] === "." && src[i - 2] !== ".") continue; // obj.name( / ?.name(
    out.add(m[1]);
  }
  return out;
}

test("no register/*.js calls a ctx-provided helper it never brought into scope", () => {
  const provided = ctxProvidedNames();
  const offenders = [];
  for (const f of fs.readdirSync(registerDir).filter((f) => f.endsWith(".js"))) {
    const src = fs.readFileSync(path.join(registerDir, f), "utf8");
    const inScope = inScopeNames(src);
    for (const name of calledNames(src)) {
      if (provided.has(name) && !inScope.has(name)) offenders.push(`${f}: ${name}()`);
    }
  }
  assert.deepEqual(offenders, [], `register modules call ctx helpers they never destructured/imported:\n  ${offenders.join("\n  ")}`);
});
