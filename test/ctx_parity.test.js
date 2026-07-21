// ctx parity — every binding a register/*.js module destructures from `ctx`
// must actually be provided by server/index.js's ctx object. This class of bug
// ships silently: registration succeeds, the tool exists, and the missing
// binding only explodes at CALL time in production ("ragSearchHybrid is not a
// function", 2026-07-21). Static analysis, no server boot (importing index.js
// would connect a stdio transport).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const indexSrc = fs.readFileSync(path.join(root, "server", "index.js"), "utf8");
const registerDir = path.join(root, "server", "register");

/** Names provided by index.js's `const ctx = { a, b, c }` shorthand object. */
function ctxProvidedNames() {
  const m = indexSrc.match(/const ctx = \{([\s\S]*?)\n\};/);
  assert.ok(m, "could not locate `const ctx = {...};` in server/index.js");
  return new Set(
    m[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      // tolerate future `key: value` entries — the exposed name is the key
      .map((s) => s.split(":")[0].trim())
      .filter((s) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s))
  );
}

/** Names a register module pulls out of ctx via `const { ... } = ctx;` */
function destructuredNames(src) {
  const out = [];
  for (const m of src.matchAll(/const \{([\s\S]*?)\}\s*=\s*ctx;/g)) {
    for (const raw of m[1].split(",")) {
      const name = raw.trim().split(":")[0].trim();
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) out.push(name);
    }
  }
  return out;
}

test("every ctx binding destructured by register/*.js is provided by index.js", () => {
  const provided = ctxProvidedNames();
  assert.ok(provided.size > 100, `ctx parse looks wrong (only ${provided.size} names)`);
  const missing = [];
  for (const f of fs.readdirSync(registerDir).filter((f) => f.endsWith(".js"))) {
    const src = fs.readFileSync(path.join(registerDir, f), "utf8");
    for (const name of destructuredNames(src)) {
      if (!provided.has(name)) missing.push(`${f}: ${name}`);
    }
  }
  assert.deepEqual(missing, [], `register modules destructure ctx names index.js never provides:\n  ${missing.join("\n  ")}`);
});

test("no register module destructures ctx twice with conflicting shapes (sanity)", () => {
  for (const f of fs.readdirSync(registerDir).filter((f) => f.endsWith(".js"))) {
    const src = fs.readFileSync(path.join(registerDir, f), "utf8");
    const names = destructuredNames(src);
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    assert.deepEqual(dupes, [], `${f} destructures duplicates: ${dupes.join(", ")}`);
  }
});
