import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  sanitizePageName, saveTestPage, listTestPages, getTestPage, removeTestPage, TESTPAGES_DIR,
} from "../server/testpages.js";

// FBMCPF-74 — test pages CRUD

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbtp-"));
  return { dir, board: { projectDir: () => dir } };
}

test("sanitizePageName defaults .html and rejects traversal/dotfile", () => {
  assert.equal(sanitizePageName("qa"), "qa.html");
  assert.equal(sanitizePageName("form.htm"), "form.htm");
  assert.throws(() => sanitizePageName("../x.html"), /invalid page name/);
  assert.throws(() => sanitizePageName(".hidden"), /invalid page name/);
  assert.throws(() => sanitizePageName(""), /required/);
});

test("save/list/get/remove round-trip", () => {
  const { dir, board } = tmpBoard();
  const r = saveTestPage(board, "P", { name: "login-qa", html: "<h1>Login QA</h1>" });
  assert.equal(r.name, "login-qa.html");
  assert.equal(r.path, "test-pages/login-qa.html");
  assert.ok(fs.existsSync(path.join(dir, TESTPAGES_DIR, "login-qa.html")));

  saveTestPage(board, "P", { name: "checkout.html", html: "<h1>Checkout</h1>" });
  const l = listTestPages(board, "P");
  assert.equal(l.count, 2);
  assert.deepEqual(l.pages.map((p) => p.name), ["checkout.html", "login-qa.html"]);

  assert.match(getTestPage(board, "P", "login-qa").html, /Login QA/);
  assert.equal(removeTestPage(board, "P", "checkout.html").removed, "checkout.html");
  assert.equal(listTestPages(board, "P").count, 1);
});

test("empty board + missing page guards", () => {
  const { board } = tmpBoard();
  assert.equal(listTestPages(board, "P").count, 0);
  assert.throws(() => getTestPage(board, "P", "nope"), /not found/);
  assert.throws(() => removeTestPage(board, "P", "nope"), /not found/);
  assert.throws(() => saveTestPage(board, "P", { name: "x" }), /html content is required/);
});
