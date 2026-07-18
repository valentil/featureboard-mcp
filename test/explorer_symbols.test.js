import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractExportedSymbols, codeFileMap } from "../server/explorer.js";

// FBMCPF-203 — symbol-level code map.

test("extractExportedSymbols recognizes exported functions, classes, and consts", () => {
  const src = [
    "export function alpha() {}",
    "export async function beta() {}",
    "export class Gamma {}",
    "export const delta = 42;",
    "export const epsilon = (x) => x + 1;",
    "export const zeta = async () => {};",
    "export let eta = function () {};",
    "const notExported = 1;",
    "function alsoNot() {}",
  ].join("\n");
  const syms = extractExportedSymbols(src);
  assert.deepEqual(syms.map((s) => `${s.kind}:${s.name}`), [
    "function:alpha",
    "function:beta",
    "class:Gamma",
    "const:delta",
    "function:epsilon",
    "function:zeta",
    "function:eta",
  ]);
  assert.equal(syms[0].line, 1);
  assert.equal(syms[2].line, 3);
});

test("extractExportedSymbols caps output at maxSymbols", () => {
  const src = Array.from({ length: 10 }, (_, i) => `export const c${i} = ${i};`).join("\n");
  assert.equal(extractExportedSymbols(src, { maxSymbols: 3 }).length, 3);
});

function fixtureDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-symbols-"));
  fs.writeFileSync(path.join(dir, "a.js"), "export function foo() {}\nexport class Bar {}\n");
  fs.writeFileSync(path.join(dir, "b.ts"), "export const baz = () => 1;\n");
  fs.writeFileSync(path.join(dir, "readme.md"), "# not code\nexport function ignore() {}\n");
  fs.mkdirSync(path.join(dir, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(dir, "node_modules", "pkg", "index.js"), "export function vendor() {}\n");
  return dir;
}

test("codeFileMap symbols:true maps JS/TS exports, skips non-code and vendor dirs", () => {
  const dir = fixtureDir();
  const map = codeFileMap(dir, { symbols: true });
  assert.ok(map.symbols["a.js"], "a.js has symbols");
  assert.deepEqual(map.symbols["a.js"].map((s) => s.name), ["foo", "Bar"]);
  assert.ok(map.symbols["b.ts"], "b.ts has symbols");
  assert.ok(!("readme.md" in map.symbols), "markdown is not scanned for symbols");
  assert.ok(!Object.keys(map.symbols).some((p) => p.includes("node_modules")), "vendor dir skipped");
  assert.equal(map.symbolFileCount, 2);
});

test("codeFileMap omits the symbols block by default", () => {
  const dir = fixtureDir();
  const map = codeFileMap(dir);
  assert.ok(!("symbols" in map), "symbols only present when requested");
});
