import { test } from "node:test";
import assert from "node:assert/strict";
import {
  planServerJsonSync, tagFor, versionedAssetUrl, ensureGhRelease, publishRegistry, verifyLatest,
} from "../scripts/release-publish.mjs";

// FBMCPF-325 — release/publish tail.

test("tagFor matches release.mjs tag style (minor keeps vX.Y, patch full)", () => {
  assert.equal(tagFor("0.7.0"), "v0.7");
  assert.equal(tagFor("0.7.1"), "v0.7.1");
  assert.equal(tagFor("1.0.0"), "v1.0");
});

test("planServerJsonSync repoints identifier off the dead downloads host and pins the sha", () => {
  const cur = {
    version: "0.7.0",
    packages: [{ registryType: "mcpb", identifier: "https://featureboard.ai/downloads/featureboard.plugin", fileSha256: "old" }],
  };
  const { next, changed } = planServerJsonSync(cur, { version: "0.7.1", pluginSha: "abc123" });
  assert.equal(next.version, "0.7.1");
  assert.equal(next.packages[0].identifier, versionedAssetUrl("0.7.1", "featureboard.plugin"));
  assert.match(next.packages[0].identifier, /releases\/download\/v0\.7\.1\/featureboard\.plugin$/);
  assert.equal(next.packages[0].fileSha256, "abc123");
  assert.equal(changed.length, 3);
  // idempotent: planning again changes nothing
  const again = planServerJsonSync(next, { version: "0.7.1", pluginSha: "abc123" });
  assert.equal(again.changed.length, 0);
});

test("ensureGhRelease is idempotent: existing release short-circuits", () => {
  const exec = (cmd, args) => (args[0] === "release" && args[1] === "view" ? { status: 0, stdout: "{}" } : { status: 1 });
  const r = ensureGhRelease({ tag: "v0.7.1", assets: [], exec });
  assert.equal(r.did, false);
  assert.match(r.reason, /already exists/);
});

test("ensureGhRelease refuses with no built assets", () => {
  const exec = () => ({ status: 1, stderr: "not found" });
  const r = ensureGhRelease({ tag: "v9.9", assets: ["/nope/a", "/nope/b"], exec });
  assert.equal(r.did, false);
  assert.match(r.error, /no built assets/);
});

test("publishRegistry reports a missing CLI instead of throwing", () => {
  const exec = () => ({ error: Object.assign(new Error("nope"), { code: "ENOENT" }) });
  const r = publishRegistry({ exec });
  assert.equal(r.did, false);
  assert.match(r.error, /mcp-publisher CLI not installed/);
});

test("verifyLatest passes on matching tag and fails on mismatch", async () => {
  const mk = (tag) => async () => ({ ok: true, json: async () => ({ tag_name: tag }) });
  assert.equal((await verifyLatest({ version: "0.7.1", fetchImpl: mk("v0.7.1") })).ok, true);
  const bad = await verifyLatest({ version: "0.7.1", fetchImpl: mk("v0.7") });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /expected v0\.7\.1/);
});
