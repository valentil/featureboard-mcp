// FBMCPB-17 — manifest.json's prompts array must stay in sync with the prompts
// actually registered in server/index.js. It drifted once (listed 2 of 16), so
// gen-docs.mjs now auto-generates it and this test is the regression guard: it
// parses server/index.js the same way scripts/gen-docs.mjs does (split on
// registerPrompt boundaries, read name + argsSchema keys) and asserts the
// manifest lists exactly those prompts with matching arguments. If a prompt is
// added or renamed and `npm run docs` isn't re-run, this fails instead of the
// manifest shipping stale.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

/** Every prompt registered via server.registerPrompt, with its argsSchema keys. */
function findRegisteredPrompts(src) {
  const chunks = src.split(/server\.registerPrompt\(/).slice(1);
  const prompts = [];
  for (const c of chunks) {
    const name = (c.match(/^\s*"([^"]+)"/) || [])[1];
    if (!name) continue;
    // argsSchema objects only nest parens, never braces, so non-greedy to the
    // first closing brace captures the whole block (same as gen-docs.mjs).
    const argsBlock = (c.match(/argsSchema:\s*\{([\s\S]*?)\}/) || [])[1] || "";
    const args = [...argsBlock.matchAll(/(\w+)\s*:\s*z\b/g)].map((m) => m[1]);
    prompts.push({ name, args });
  }
  return prompts;
}

test("parser sanity: finds a healthy number of registered prompts (canary for parser drift)", () => {
  const prompts = findRegisteredPrompts(serverSrc);
  assert.ok(prompts.length >= 10, `expected >=10 prompts, parsed ${prompts.length} — parser may be broken`);
  const names = prompts.map((p) => p.name);
  for (const known of ["project_from_chat", "process_next", "daily_plan", "plan_goal", "refine", "run_tests"]) {
    assert.ok(names.includes(known), `expected known prompt "${known}" to be detected`);
  }
});

test("manifest.json prompts array lists exactly the registered prompts", () => {
  const registered = findRegisteredPrompts(serverSrc).map((p) => p.name);
  const listed = (manifest.prompts || []).map((p) => p.name);
  assert.deepEqual(
    [...listed].sort(),
    [...registered].sort(),
    "manifest.json prompts out of sync with server.registerPrompt calls — run `npm run docs`"
  );
});

test("each manifest prompt entry carries matching arguments plus a description and text", () => {
  const registered = new Map(findRegisteredPrompts(serverSrc).map((p) => [p.name, p.args]));
  for (const entry of manifest.prompts || []) {
    const args = registered.get(entry.name);
    assert.ok(args, `manifest prompt "${entry.name}" is not registered in server/index.js`);
    assert.deepEqual(
      [...(entry.arguments || [])].sort(),
      [...args].sort(),
      `arguments mismatch for prompt "${entry.name}" — run \`npm run docs\``
    );
    assert.ok(entry.description && entry.description.length > 0, `empty description for "${entry.name}"`);
    assert.ok(entry.text && entry.text.length > 0, `empty text for "${entry.name}"`);
  }
});
