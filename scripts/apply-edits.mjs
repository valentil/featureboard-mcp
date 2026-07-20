#!/usr/bin/env node
/**
 * apply-edits.mjs — sandbox-safe exact-match patcher (FBMCPF-239).
 *
 * Replaces fragile python heredoc patching with a small, dependency-free
 * Node script that applies exact-string edits to one or more files.
 *
 * Usage:
 *   node scripts/apply-edits.mjs payload.json
 *   cat payload.json | node scripts/apply-edits.mjs
 *
 * Payload shape (single file):
 *   {
 *     "file": "relative/path.js",
 *     "edits": [
 *       { "old": "...", "new": "...", "all": false }
 *     ]
 *   }
 *
 * Or an array of such objects to patch multiple files in one run:
 *   [ { "file": "...", "edits": [...] }, { "file": "...", "edits": [...] } ]
 *
 * Semantics:
 *  - For each edit, unless all===true, `old` must occur EXACTLY once in the
 *    file's current (in-memory) content. 0 or >1 occurrences aborts the
 *    entire run (across all files in the payload) with a non-zero exit and
 *    a clear message naming the file and edit index. Nothing is written.
 *  - If all===true, every occurrence of `old` is replaced. 0 occurrences
 *    aborts the run the same way.
 *  - All edits for a file are validated and applied to an in-memory copy
 *    before anything is written to disk. The file is written atomically
 *    (tmp file + rename) only once every edit in its payload entry has
 *    validated.
 *  - After writing, if the target file ends in .js or .mjs, `node --check`
 *    is run against it. On failure the original content is restored and
 *    the process exits non-zero with the syntax error.
 *  - On success, prints one line per file: `patched <file>: <n> edits`.
 */

import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

function fail(message) {
  console.error(message);
  process.exit(1);
}

function readPayloadText() {
  const argPath = process.argv[2];
  if (argPath) {
    if (!existsSync(argPath)) {
      fail(`apply-edits: payload file not found: ${argPath}`);
    }
    return readFileSync(argPath, "utf8");
  }
  try {
    return readFileSync(0, "utf8");
  } catch (err) {
    fail(`apply-edits: no payload file given and failed to read stdin: ${err.message}`);
  }
}

function countOccurrences(haystack, needle) {
  if (needle === "") return 0;
  let count = 0;
  let idx = 0;
  while (true) {
    const found = haystack.indexOf(needle, idx);
    if (found === -1) break;
    count++;
    idx = found + needle.length;
  }
  return count;
}

function replaceAllOccurrences(haystack, needle, replacement) {
  return haystack.split(needle).join(replacement);
}

function replaceOnce(haystack, needle, replacement) {
  const idx = haystack.indexOf(needle);
  if (idx === -1) return haystack;
  return haystack.slice(0, idx) + replacement + haystack.slice(idx + needle.length);
}

function parsePayload(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    fail(`apply-edits: invalid JSON payload: ${err.message}`);
  }
  const entries = Array.isArray(data) ? data : [data];
  if (entries.length === 0) {
    fail("apply-edits: payload contained no file entries");
  }
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      fail("apply-edits: each payload entry must be an object");
    }
    if (typeof entry.file !== "string" || entry.file.length === 0) {
      fail("apply-edits: each payload entry must have a non-empty string 'file'");
    }
    if (!Array.isArray(entry.edits) || entry.edits.length === 0) {
      fail(`apply-edits: entry for '${entry.file}' must have a non-empty 'edits' array`);
    }
    entry.edits.forEach((edit, i) => {
      if (!edit || typeof edit !== "object") {
        fail(`apply-edits: ${entry.file} edit[${i}] must be an object`);
      }
      if (typeof edit.old !== "string") {
        fail(`apply-edits: ${entry.file} edit[${i}] missing string 'old'`);
      }
      if (typeof edit.new !== "string") {
        fail(`apply-edits: ${entry.file} edit[${i}] missing string 'new'`);
      }
    });
  }
  return entries;
}

function planFile(entry, baseDir) {
  const filePath = path.resolve(baseDir, entry.file);
  if (!existsSync(filePath)) {
    fail(`apply-edits: file not found: ${entry.file}`);
  }
  const original = readFileSync(filePath, "utf8");
  let content = original;

  entry.edits.forEach((edit, i) => {
    const useAll = edit.all === true;
    const occurrences = countOccurrences(content, edit.old);
    if (useAll) {
      if (occurrences === 0) {
        fail(
          `apply-edits: ${entry.file} edit[${i}]: 'old' text not found (all:true expects >=1 occurrence). Aborting — no files were changed.`
        );
      }
      content = replaceAllOccurrences(content, edit.old, edit.new);
    } else {
      if (occurrences === 0) {
        fail(
          `apply-edits: ${entry.file} edit[${i}]: 'old' text not found (expected exactly 1 occurrence, found 0). Aborting — no files were changed.`
        );
      }
      if (occurrences > 1) {
        fail(
          `apply-edits: ${entry.file} edit[${i}]: 'old' text is ambiguous (expected exactly 1 occurrence, found ${occurrences}). Aborting — no files were changed.`
        );
      }
      content = replaceOnce(content, edit.old, edit.new);
    }
  });

  return { filePath, relFile: entry.file, original, content, editCount: entry.edits.length };
}

function writeAtomic(filePath, content) {
  const tmpPath = `${filePath}.apply-edits-${process.pid}-${Date.now()}.tmp`;
  writeFileSync(tmpPath, content, "utf8");
  renameSync(tmpPath, filePath);
}

function checkSyntax(filePath) {
  const result = spawnSync(process.execPath, ["--check", filePath], { encoding: "utf8" });
  if (result.status !== 0) {
    return { ok: false, message: (result.stderr || result.stdout || "unknown node --check error").trim() };
  }
  return { ok: true };
}

function main() {
  const text = readPayloadText();
  const entries = parsePayload(text);
  const baseDir = process.cwd();

  // Validate + apply all edits for every file in-memory first. If any file
  // fails, the whole run aborts and nothing on disk has been touched yet.
  const plans = entries.map((entry) => planFile(entry, baseDir));

  for (const plan of plans) {
    writeAtomic(plan.filePath, plan.content);

    const ext = path.extname(plan.filePath).toLowerCase();
    if (ext === ".js" || ext === ".mjs") {
      const result = checkSyntax(plan.filePath);
      if (!result.ok) {
        // Roll back this file to its original content.
        writeAtomic(plan.filePath, plan.original);
        fail(`apply-edits: ${plan.relFile}: syntax check failed after edit, rolled back.\n${result.message}`);
      }
    }

    console.log(`patched ${plan.relFile}: ${plan.editCount} edits`);
  }
}

main();
