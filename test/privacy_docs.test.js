// FBMCPB-14 — PRIVACY.md must disclose every tool that can reach outside the
// machine. This test is the regression guard: it parses server/index.js the
// same way scripts/gen-docs.mjs does (split on registerTool boundaries, read
// the annotations block) to find every tool carrying `openWorldHint: true`,
// then asserts docs/compliance/PRIVACY.md's Exceptions section names each one.
// If a future tool is registered with openWorldHint:true and nobody updates
// the privacy doc, this test fails instead of the gap shipping silently.
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
const privacyDoc = fs.readFileSync(path.join(root, "docs", "compliance", "PRIVACY.md"), "utf8");

/** Every tool name registered with `openWorldHint: true` in server/index.js. */
function findOpenWorldTools(src) {
  const chunks = src.split(/server\.registerTool\(/).slice(1);
  const names = [];
  for (const c of chunks) {
    const name = (c.match(/^\s*"([^"]+)"/) || [])[1];
    if (!name) continue;
    const annotations = (c.match(/annotations:\s*\{([^}]*)\}/) || [])[1] || "";
    if (/openWorldHint:\s*true/.test(annotations)) names.push(name);
  }
  return names;
}

test("findOpenWorldTools sanity: parses a non-empty set of tools from server/index.js", () => {
  const names = findOpenWorldTools(serverSrc);
  assert.ok(names.length > 0, "expected at least one openWorldHint:true tool — parser may be broken");
});

test("findOpenWorldTools finds the known egress-capable tools (canary for parser drift)", () => {
  const names = findOpenWorldTools(serverSrc);
  for (const known of ["notify_slack", "deploy_site", "commit_feature", "get_site_traffic"]) {
    assert.ok(names.includes(known), `expected known egress tool "${known}" to be detected`);
  }
});

test("every openWorldHint:true tool is named in PRIVACY.md's Exceptions section", () => {
  const names = findOpenWorldTools(serverSrc);
  const missing = names.filter((name) => !privacyDoc.includes("`" + name + "`"));
  assert.deepEqual(
    missing,
    [],
    `PRIVACY.md is missing disclosure for: ${missing.join(", ")} — every openWorldHint:true ` +
      `tool must be named in the Exceptions section (see docs/compliance/PRIVACY.md).`
  );
});

test("PRIVACY.md's Exceptions section exists and covers more than a single item", () => {
  assert.match(privacyDoc, /## Exceptions/);
  const section = privacyDoc.split("## Exceptions")[1].split(/\n## /)[0];
  // Regression guard for FBMCPB-14: the old doc only disclosed the registration
  // POST exception. A healthy inventory names at least Slack, git push, and the
  // analytics proxy alongside registration/license-request.
  for (const name of ["notify_slack", "deploy_site", "commit_feature", "get_site_traffic", "register_email"]) {
    assert.ok(section.includes("`" + name + "`"), `Exceptions section should mention \`${name}\``);
  }
});
