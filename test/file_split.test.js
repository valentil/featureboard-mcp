import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clusterSymbols, suggestFileSplit } from "../server/explorer.js";

// FBMCPF-221 — suggest_file_split.

const SRC = `export function readState(a) {}
export function readConfig(a) {}
export function writeState(a) {}
export function writeConfig(a) {}
export const parseThing = (x) => x;
export class Widget {}
`;

test("clusterSymbols groups by name prefix and folds singletons into misc", () => {
  const clusters = clusterSymbols([
    { name: "readState" }, { name: "readConfig" },
    { name: "writeState" }, { name: "writeConfig" },
    { name: "parseThing" }, { name: "Widget" },
  ]);
  const keys = clusters.map((c) => c.key);
  assert.ok(keys.includes("read") && keys.includes("write") && keys.includes("misc"));
});

test("suggestFileSplit proposes barrel-preserving targets with a prompt", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbsplit-"));
  fs.writeFileSync(path.join(dir, "big.js"), SRC);
  const r = suggestFileSplit(dir, "big.js");
  assert.equal(r.keepOriginalAsBarrel, true);
  assert.equal(r.symbolCount, 6);
  const readTarget = r.targets.find((t) => t.file === "big.read.js");
  assert.deepEqual(readTarget.symbols, ["readState", "readConfig"]);
  assert.match(r.prompt, /re-export barrel/);
  assert.match(r.prompt, /Do NOT change any public symbol names/);
});

test("no exported symbols → warning, not a bogus plan", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbsplit2-"));
  fs.writeFileSync(path.join(dir, "plain.js"), "const x = 1;\nconsole.log(x);\n");
  const r = suggestFileSplit(dir, "plain.js");
  assert.match(r.warning, /no exported symbols/);
});
