import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  slugifyName, normalizeKeywords, validatePackaging,
  suggestPackaging, savePackagingConfig, getPackagingConfig, PACKAGING_FILE,
} from "../server/packaging.js";
import { setProjectConfig, addProduct } from "../server/metadata.js";

// FBMCPF-85 — AI-assisted packaging config

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbpack-"));
  return { dir, board: { projectDir: () => dir } };
}

test("slugifyName produces mcpb-safe names", () => {
  assert.equal(slugifyName("My Cool App!"), "my-cool-app");
  assert.equal(slugifyName("  --Foo__Bar--  "), "foo-bar");
});

test("normalizeKeywords lowercases, trims, de-dupes", () => {
  assert.deepEqual(normalizeKeywords(["MCP", "board", "board", " Tasks "]), ["mcp", "board", "tasks"]);
  assert.deepEqual(normalizeKeywords(null), []);
});

test("validatePackaging: errors on missing/invalid name + description", () => {
  const r = validatePackaging({});
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /name is required/.test(e)));
  assert.ok(r.errors.some((e) => /description is required/.test(e)));

  const bad = validatePackaging({ name: "Bad Name", description: "short" });
  assert.ok(bad.errors.some((e) => /lowercase alphanumeric/.test(e)));
  assert.ok(bad.errors.some((e) => /too short/.test(e)));
});

test("validatePackaging: ok with warnings when polish missing", () => {
  const r = validatePackaging({ name: "my-app", description: "A perfectly fine description." });
  assert.equal(r.ok, true);
  assert.equal(r.errors.length, 0);
  assert.ok(r.warnings.some((w) => /no keywords/.test(w)));
  assert.ok(r.warnings.some((w) => /displayName/.test(w)));
});

test("suggestPackaging seeds from project config + products", () => {
  const { board } = tmpBoard();
  setProjectConfig(board, "Widget Co", { description: "A widget board for teams." });
  addProduct(board, "Widget Co", "Widgets");
  addProduct(board, "Widget Co", "Gadgets");
  const { draft, validation } = suggestPackaging(board, "Widget Co");
  assert.equal(draft.name, "widget-co");
  assert.equal(draft.description, "A widget board for teams.");
  assert.deepEqual(draft.keywords, ["widgets", "gadgets"]);
  assert.equal(validation.ok, true); // has name + description
});

test("savePackagingConfig persists, normalizes, validates, round-trips", () => {
  const { dir, board } = tmpBoard();
  const r = savePackagingConfig(board, "P", {
    name: "My App",
    displayName: "My App",
    description: "A genuinely useful thing for people.",
    keywords: ["MCP", "mcp", "tasks"],
    version: "1.2.0",
  });
  assert.equal(r.config.name, "my-app"); // slugified
  assert.deepEqual(r.config.keywords, ["mcp", "tasks"]); // de-duped/lowercased
  assert.equal(r.validation.ok, true);
  assert.ok(fs.existsSync(path.join(dir, PACKAGING_FILE)));
  assert.equal(getPackagingConfig(board, "P").version, "1.2.0"); // round-trips
});

test("savePackagingConfig throws on hard-invalid metadata", () => {
  const { board } = tmpBoard();
  assert.throws(() => savePackagingConfig(board, "P", { name: "ok-name", description: "no" }), /invalid|too short/);
  assert.throws(() => savePackagingConfig(board, "P", { name: "x", description: "long enough desc", keywords: "not-an-array" }), /keywords must be an array/);
});
