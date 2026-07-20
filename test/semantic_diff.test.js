import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getTicketDiff } from "../server/git.js";
import {
  buildSemanticView,
  parseUnifiedDiff,
  isFormattingOnlyHunk,
  classifyFile,
  SEMANTIC_DISCLAIMER,
} from "../server/semanticdiff.js";
import { setProjectConfig } from "../server/metadata.js";

// FBMCPF-220 — semantic diff view on get_ticket_diff (semantic:true):
// formatting-only hunks stripped, files ordered core → tests → docs/config,
// mechanical renames flagged, deterministic review prompt with disclaimer.

// --- classifyFile ----------------------------------------------------------

test("classifyFile: core vs tests vs docs/config", () => {
  assert.equal(classifyFile("server/git.js"), "core");
  assert.equal(classifyFile("src/lib/parser.ts"), "core");
  assert.equal(classifyFile("test/git.test.js"), "tests");
  assert.equal(classifyFile("src/app.spec.ts"), "tests");
  assert.equal(classifyFile("packages/x/__tests__/y.js"), "tests");
  assert.equal(classifyFile("README.md"), "docs/config");
  assert.equal(classifyFile("docs/guide/intro.md"), "docs/config");
  assert.equal(classifyFile("package.json"), "docs/config");
  assert.equal(classifyFile(".gitignore"), "docs/config");
  assert.equal(classifyFile(".github/workflows/ci.yml"), "docs/config");
});

// --- isFormattingOnlyHunk --------------------------------------------------

test("isFormattingOnlyHunk: whitespace-only changes are noise, real changes are not", () => {
  const ws = { header: "@@", removed: ["const x=1;"], added: ["const x = 1;"] };
  assert.equal(isFormattingOnlyHunk(ws), true);

  const blank = { header: "@@", removed: [], added: ["", "  "] };
  assert.equal(isFormattingOnlyHunk(blank), true);

  const real = { header: "@@", removed: ["const x = 1;"], added: ["const x = 2;"] };
  assert.equal(isFormattingOnlyHunk(real), false);

  const addition = { header: "@@", removed: [], added: ["doWork();"] };
  assert.equal(isFormattingOnlyHunk(addition), false);

  const empty = { header: "@@", removed: [], added: [] };
  assert.equal(isFormattingOnlyHunk(empty), false);
});

// --- parseUnifiedDiff ------------------------------------------------------

const SYNTHETIC_DIFF = `diff --git a/server/app.js b/server/app.js
index 111..222 100644
--- a/server/app.js
+++ b/server/app.js
@@ -1,3 +1,4 @@
 context
-const x=1;
+const x = 1;
@@ -10,2 +11,3 @@
 context
+doWork();
diff --git a/README.md b/README.md
index 333..444 100644
--- a/README.md
+++ b/README.md
@@ -1 +1,2 @@
 # Title
+More docs
diff --git a/test/app.test.js b/test/app.test.js
index 555..666 100644
--- a/test/app.test.js
+++ b/test/app.test.js
@@ -1 +1,2 @@
 old test
+more test
diff --git a/old.js b/new.js
similarity index 100%
rename from old.js
rename to new.js
`;

test("parseUnifiedDiff: files, hunks, renames, similarity", () => {
  const files = parseUnifiedDiff(SYNTHETIC_DIFF);
  assert.equal(files.length, 4);
  assert.equal(files[0].path, "server/app.js");
  assert.equal(files[0].hunks.length, 2);
  assert.deepEqual(files[0].hunks[1].added, ["doWork();"]);
  const rename = files[3];
  assert.equal(rename.renameFrom, "old.js");
  assert.equal(rename.renameTo, "new.js");
  assert.equal(rename.path, "new.js");
  assert.equal(rename.similarity, 100);
  assert.equal(rename.hunks.length, 0);
});

// --- buildSemanticView -----------------------------------------------------

test("buildSemanticView: strips noise, orders core → tests → docs/config, flags renames", () => {
  const view = buildSemanticView([{ shortHash: "abcd1234", diff: SYNTHETIC_DIFF, diffTruncated: false }]);

  assert.deepEqual(view.order, ["core", "tests", "docs/config"]);
  assert.deepEqual(view.files.map((f) => f.category), ["core", "core", "tests", "docs/config"]);
  assert.deepEqual(view.files.map((f) => f.path), ["server/app.js", "new.js", "test/app.test.js", "README.md"]);

  const app = view.files[0];
  assert.equal(app.strippedHunks, 1); // const x=1 → const x = 1
  assert.equal(app.keptHunks, 1); // doWork()
  assert.equal(app.additions, 1);
  assert.deepEqual(app.commits, ["abcd1234"]);

  const renamed = view.files[1];
  assert.ok(renamed.rename);
  assert.equal(renamed.rename.mechanical, true);
  assert.equal(renamed.rename.from, "old.js");

  assert.equal(view.totals.strippedHunks, 1);
  assert.equal(view.totals.mechanicalRenames, 1);
  assert.equal(view.totals.byCategory.core, 2);
  assert.equal(view.partial, false);

  // prompt is deterministic, ordered, and carries the disclaimer
  assert.match(view.reviewPrompt, /core code first, then tests, then docs\/config/);
  assert.match(view.reviewPrompt, /mechanical rename from old\.js/);
  assert.match(view.reviewPrompt, /verify against the raw diff/);
  assert.equal(view.disclaimer, SEMANTIC_DISCLAIMER);
  const idxCore = view.reviewPrompt.indexOf("server/app.js");
  const idxTest = view.reviewPrompt.indexOf("test/app.test.js");
  const idxDocs = view.reviewPrompt.indexOf("README.md");
  assert.ok(idxCore < idxTest && idxTest < idxDocs);
});

test("buildSemanticView: truncated diffs mark the view partial", () => {
  const view = buildSemanticView([{ shortHash: "aaaa1111", diff: "diff --git a/x.js b/x.js\n@@ -1 +1 @@\n-a\n+b\n… [diff truncated]", diffTruncated: true }]);
  assert.equal(view.partial, true);
  assert.match(view.reviewPrompt, /truncated/);
});

test("buildSemanticView: empty input yields an empty but well-formed view", () => {
  const view = buildSemanticView([]);
  assert.equal(view.totals.filesChanged, 0);
  assert.deepEqual(view.files, []);
  assert.match(view.reviewPrompt, /verify against the raw diff/);
});

// --- integration through getTicketDiff (real git repo) ---------------------

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

function setup() {
  const boardDir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-semboard-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "fb-semrepo-"));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "t@t.dev"]);
  git(repo, ["config", "user.name", "Tester"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  const board = { projectDir: () => boardDir };
  setProjectConfig(board, "Proj", { codeLocation: repo });
  return { board, repo };
}

function commit(repo, file, content, message) {
  fs.writeFileSync(path.join(repo, file), content);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", message]);
}

test("get_ticket_diff semantic:true: end-to-end over real commits", () => {
  const { board, repo } = setup();
  commit(repo, "core.js", "function f(){return 1;}\n", "FBMCPF-220: add core");
  commit(repo, "core.js", "function f() { return 1; }\n", "FBMCPF-220: reformat only");
  commit(repo, "core.test.js", "assert(f()===1);\n", "FBMCPF-220: add test");
  commit(repo, "NOTES.md", "notes\n", "FBMCPF-220: docs");

  const res = getTicketDiff(board, "Proj", "FBMCPF-220", { semantic: true });
  assert.equal(res.count, 4);
  assert.ok(res.semantic, "semantic view attached");
  const cats = res.semantic.files.map((f) => [f.path, f.category]);
  assert.deepEqual(cats, [["core.js", "core"], ["core.test.js", "tests"], ["NOTES.md", "docs/config"]]);
  assert.ok(res.semantic.totals.strippedHunks >= 1, "reformat-only hunk stripped");
  assert.match(res.semantic.reviewPrompt, /verify against the raw diff/);
});

test("get_ticket_diff without semantic: no semantic key (back-compat)", () => {
  const { board, repo } = setup();
  commit(repo, "a.js", "x\n", "FBMCPF-220: change");
  const res = getTicketDiff(board, "Proj", "FBMCPF-220");
  assert.equal(res.semantic, undefined);
});

test("get_ticket_diff semantic:true: mechanical rename flagged", () => {
  const { board, repo } = setup();
  commit(repo, "before.js", "const stable = 'content that stays identical';\n".repeat(10), "FBMCPF-220: add file");
  git(repo, ["mv", "before.js", "after.js"]);
  git(repo, ["commit", "-q", "-m", "FBMCPF-220: rename file"]);

  const res = getTicketDiff(board, "Proj", "FBMCPF-220", { semantic: true });
  const renamed = res.semantic.files.find((f) => f.rename);
  assert.ok(renamed, "rename entry present");
  assert.equal(renamed.rename.mechanical, true);
  assert.equal(renamed.rename.from, "before.js");
  assert.equal(res.semantic.totals.mechanicalRenames, 1);
});
