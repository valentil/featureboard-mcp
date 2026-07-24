// FBMCPF-260 — version-update check against featureboard.ai.
//
// checkUpdates is explicitly-invoked only (see server/register/licensing.js's
// check_updates tool + docs/compliance/PRIVACY.md); this file tests the pure
// compareVersions matrix and checkUpdates itself with an injected fetchImpl,
// mirroring test/registration.test.js's stubFetch style so no real network
// access is exercised.
import { test } from "node:test";
import assert from "node:assert/strict";
import { compareVersions, checkUpdates, resolveCurrentVersion } from "../server/updates.js";

// A fetch stub factory: records calls and returns a chosen response (or throws).
function stubFetch({ ok = true, status = 200, json = null, jsonThrows = false, throwErr = null } = {}) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, opts });
    if (throwErr) throw throwErr;
    return {
      ok,
      status,
      json: async () => {
        if (jsonThrows) throw new Error("Unexpected token in JSON");
        return json;
      },
    };
  };
  impl.calls = calls;
  return impl;
}

/* ---------- compareVersions ---------- */

test("compareVersions: equal versions", () => {
  assert.equal(compareVersions("0.6.2", "0.6.2"), 0);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
});

test("compareVersions: newer patch", () => {
  assert.equal(compareVersions("0.6.2", "0.6.3"), -1);
  assert.equal(compareVersions("0.6.3", "0.6.2"), 1);
});

test("compareVersions: newer minor", () => {
  assert.equal(compareVersions("0.6.2", "0.7.0"), -1);
  assert.equal(compareVersions("0.7.0", "0.6.2"), 1);
});

test("compareVersions: newer major", () => {
  assert.equal(compareVersions("0.9.9", "1.0.0"), -1);
  assert.equal(compareVersions("1.0.0", "0.9.9"), 1);
});

test("compareVersions: older version", () => {
  assert.equal(compareVersions("0.6.2", "0.6.1"), 1);
  assert.equal(compareVersions("0.6.1", "0.6.2"), -1);
});

test("compareVersions: unequal segment lengths compare sanely", () => {
  // "0.6.2" vs "0.7" — 0.7 is newer even though it has fewer segments.
  assert.equal(compareVersions("0.6.2", "0.7"), -1);
  assert.equal(compareVersions("0.7", "0.6.2"), 1);
  // Trailing zero segments are equal.
  assert.equal(compareVersions("0.7", "0.7.0"), 0);
  assert.equal(compareVersions("0.7.0", "0.7"), 0);
  assert.equal(compareVersions("1", "1.0.0"), 0);
});

test("compareVersions: missing/malformed input falls back to 0 segments", () => {
  assert.equal(compareVersions(undefined, "0.0.1"), -1);
  assert.equal(compareVersions("0.0.0", null), 0);
});

/* ---------- resolveCurrentVersion ---------- */

test("resolveCurrentVersion reads this package's own version and never throws", () => {
  const v = resolveCurrentVersion();
  assert.equal(typeof v, "string");
  assert.match(v, /^\d+\.\d+(\.\d+)?/);
});

/* ---------- checkUpdates ---------- */

test("checkUpdates: update available", async () => {
  const impl = stubFetch({
    json: {
      name: "featureboard",
      version: "0.7.0",
      releasedAt: "2026-07-19T00:00:00.000Z",
      artifacts: {
        plugin: "https://featureboard.ai/downloads/featureboard.plugin",
        mcpZip: "https://featureboard.ai/downloads/featureboard-mcp.zip",
      },
      notes: "Adds check_updates.",
    },
  });
  const r = await checkUpdates({ fetchImpl: impl, currentVersion: "0.6.2" });
  assert.equal(r.checked, true);
  assert.equal(r.current, "0.6.2");
  assert.equal(r.latest, "0.7.0");
  assert.equal(r.updateAvailable, true);
  assert.equal(r.releasedAt, "2026-07-19T00:00:00.000Z");
  assert.equal(r.notes, "Adds check_updates.");
  assert.equal(r.downloads.plugin, "https://featureboard.ai/downloads/featureboard.plugin");
  assert.equal(r.downloads.mcpZip, "https://featureboard.ai/downloads/featureboard-mcp.zip");
  assert.match(r.recommendation, /Update available: v0\.7\.0/);
  assert.match(r.recommendation, /you run v0\.6\.2/);
  assert.match(r.recommendation, /featureboard\.plugin/);
  assert.match(r.recommendation, /featureboard-mcp\.zip/);

  assert.equal(impl.calls.length, 1);
  const call = impl.calls[0];
  assert.equal(call.url, "https://api.github.com/repos/valentil/featureboard-mcp/releases/latest");
  assert.equal(call.opts.method, "GET");
  assert.ok(call.opts.signal, "an AbortController signal is passed");
});

test("checkUpdates: up to date", async () => {
  const impl = stubFetch({ json: { version: "0.6.2" } });
  const r = await checkUpdates({ fetchImpl: impl, currentVersion: "0.6.2" });
  assert.equal(r.checked, true);
  assert.equal(r.updateAvailable, false);
  assert.match(r.recommendation, /up to date \(v0\.6\.2\)/);
});

test("checkUpdates: current newer than latest is not flagged as available", async () => {
  const impl = stubFetch({ json: { version: "0.6.0" } });
  const r = await checkUpdates({ fetchImpl: impl, currentVersion: "0.6.2" });
  assert.equal(r.checked, true);
  assert.equal(r.updateAvailable, false);
});

test("checkUpdates: network failure fails soft (never throws)", async () => {
  const impl = stubFetch({ throwErr: new Error("ECONNREFUSED") });
  const r = await checkUpdates({ fetchImpl: impl, currentVersion: "0.6.2" });
  assert.equal(r.checked, false);
  assert.equal(r.current, "0.6.2");
  assert.match(r.reason, /ECONNREFUSED/);
});

test("checkUpdates: non-2xx HTTP response fails soft", async () => {
  const impl = stubFetch({ ok: false, status: 500 });
  const r = await checkUpdates({ fetchImpl: impl, currentVersion: "0.6.2" });
  assert.equal(r.checked, false);
  assert.match(r.reason, /500/);
});

test("checkUpdates: malformed JSON fails soft", async () => {
  const impl = stubFetch({ jsonThrows: true });
  const r = await checkUpdates({ fetchImpl: impl, currentVersion: "0.6.2" });
  assert.equal(r.checked, false);
  assert.match(r.reason, /not valid JSON/i);
});

test("checkUpdates: manifest missing a version field fails soft", async () => {
  const impl = stubFetch({ json: { name: "featureboard" } });
  const r = await checkUpdates({ fetchImpl: impl, currentVersion: "0.6.2" });
  assert.equal(r.checked, false);
  assert.match(r.reason, /did not include a version/i);
});

test("checkUpdates: timeout path fails soft with a timed-out reason", async () => {
  // Simulates what fetch does when the real 5s AbortController timeout fires
  // (an AbortError-named rejection) without actually waiting out the timer —
  // asserts checkUpdates' AbortError branch, and that a signal was passed in.
  let sawSignal = false;
  const impl = async (url, opts) => {
    sawSignal = !!(opts && opts.signal);
    const err = new Error("This operation was aborted");
    err.name = "AbortError";
    throw err;
  };
  const r = await checkUpdates({ fetchImpl: impl, currentVersion: "0.6.2" });
  assert.equal(sawSignal, true);
  assert.equal(r.checked, false);
  assert.match(r.reason, /timed out/i);
});

test("checkUpdates: no fetch implementation available fails soft", async () => {
  const originalFetch = globalThis.fetch;
  // eslint-disable-next-line no-undef
  globalThis.fetch = undefined;
  try {
    const r = await checkUpdates({ currentVersion: "0.6.2" });
    assert.equal(r.checked, false);
    assert.match(r.reason, /no fetch implementation/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("checkUpdates: defaults currentVersion to resolveCurrentVersion() when omitted", async () => {
  const impl = stubFetch({ json: { version: "999.0.0" } });
  const r = await checkUpdates({ fetchImpl: impl });
  assert.equal(r.current, resolveCurrentVersion());
  assert.equal(r.updateAvailable, true);
});

test("checkUpdates parses the GitHub releases API shape (tag_name/published_at/body)", async () => {
  const impl = stubFetch({ json: { tag_name: "v99.0.0", published_at: "2026-07-24T00:00:00Z", body: "big release" } });
  const r = await checkUpdates({ fetchImpl: impl, currentVersion: "0.7.1" });
  assert.equal(r.checked, true);
  assert.equal(r.latest, "99.0.0");
  assert.equal(r.updateAvailable, true);
  assert.equal(r.releasedAt, "2026-07-24T00:00:00Z");
  assert.equal(r.notes, "big release");
  assert.match(r.downloads.plugin, /releases\/latest\/download\/featureboard\.plugin/);
  assert.equal(impl.calls[0].opts.headers["User-Agent"], "featureboard-update-check");
});
