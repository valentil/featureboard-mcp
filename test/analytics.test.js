import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getAnalyticsConfig, setAnalyticsConfig, autoConfigureAnalytics,
  buildStatsRequest, normalizeStats, deriveFromSite, getSiteTraffic,
  ANALYTICS_CONFIG_FILE, DEFAULT_ANALYTICS_CONFIG, periodToMs,
} from "../server/analytics.js";
import { setSiteAnalytics } from "../server/website.js";

// FBMCPF-83 — external site analytics config + read proxy

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbanalytics-"));
  return { dir, board: { projectDir: () => dir } };
}

test("disabled by default, plausible provider", () => {
  const { board } = tmpBoard();
  const c = getAnalyticsConfig(board, "P");
  assert.equal(c.enabled, false);
  assert.equal(c.provider, "plausible");
});

test("setAnalyticsConfig persists, validates, redacts", () => {
  const { dir, board } = tmpBoard();
  const c = setAnalyticsConfig(board, "P", { enabled: true, provider: "plausible", siteId: "example.com" });
  assert.equal(c.enabled, true);
  assert.equal(c.siteId, "example.com");
  assert.equal(c.host, "plausible.io"); // default host surfaced
  assert.ok(fs.existsSync(path.join(dir, ANALYTICS_CONFIG_FILE)));
  assert.equal(getAnalyticsConfig(board, "P").enabled, true); // round-trips
  assert.throws(() => setAnalyticsConfig(board, "P", { provider: "matomo" }), /provider must be one of/);
  assert.throws(() => setAnalyticsConfig(board, "P", { metrics: [] }), /non-empty array/);
});

test("host is normalised (scheme + trailing slash stripped)", () => {
  const { board } = tmpBoard();
  const c = setAnalyticsConfig(board, "P", { provider: "umami", host: "https://umami.example.com/", siteId: "abc" });
  assert.equal(c.host, "umami.example.com");
});

test("buildStatsRequest: plausible aggregate URL + auth only with key", () => {
  const cfg = { ...DEFAULT_ANALYTICS_CONFIG, provider: "plausible", siteId: "example.com", metrics: ["visitors", "pageviews"] };
  const noKey = buildStatsRequest(cfg, { period: "30d" });
  assert.match(noKey.url, /^https:\/\/plausible\.io\/api\/v1\/stats\/aggregate\?/);
  assert.match(noKey.url, /site_id=example\.com/);
  assert.match(noKey.url, /period=30d/);
  assert.match(noKey.url, /metrics=visitors%2Cpageviews/);
  assert.equal(noKey.hasKey, false);
  assert.equal(noKey.headers.Authorization, undefined);

  const withKey = buildStatsRequest(cfg, { key: "secret" });
  assert.equal(withKey.headers.Authorization, "Bearer secret");
  assert.equal(withKey.hasKey, true);
});

test("buildStatsRequest: umami needs host + siteId, uses time window", () => {
  const cfg = { ...DEFAULT_ANALYTICS_CONFIG, provider: "umami", host: "umami.example.com", siteId: "site-1" };
  const r = buildStatsRequest(cfg, { period: "7d" });
  assert.match(r.url, /^https:\/\/umami\.example\.com\/api\/websites\/site-1\/stats\?/);
  assert.match(r.url, /startAt=\d+/);
  assert.match(r.url, /endAt=\d+/);
  assert.throws(() => buildStatsRequest({ ...cfg, siteId: "" }), /siteId/);
});

test("buildStatsRequest: custom substitutes {period}; ga is descriptor-blocked", () => {
  const custom = { ...DEFAULT_ANALYTICS_CONFIG, provider: "custom", statsUrl: "https://api.me/stats?range={period}" };
  assert.equal(buildStatsRequest(custom, { period: "30d" }).url, "https://api.me/stats?range=30d");
  assert.throws(() => buildStatsRequest({ ...DEFAULT_ANALYTICS_CONFIG, provider: "ga", siteId: "G-X" }), /OAuth|connector/);
});

test("normalizeStats flattens plausible/umami value objects", () => {
  const plausible = normalizeStats("plausible", { results: { visitors: { value: 12 }, bounce_rate: { value: 40 } } });
  assert.deepEqual(plausible, { visitors: 12, bounce_rate: 40 });
  const umami = normalizeStats("umami", { pageviews: { value: 99 }, visitors: { value: 7 } });
  assert.deepEqual(umami, { pageviews: 99, visitors: 7 });
  assert.deepEqual(normalizeStats("custom", { anything: 1 }), { anything: 1 });
});

test("deriveFromSite maps tracking provider → reading provider", () => {
  assert.deepEqual(deriveFromSite({ provider: "plausible", id: "example.com" }), { provider: "plausible", siteId: "example.com" });
  assert.deepEqual(deriveFromSite({ provider: "ga4", id: "G-XYZ" }), { provider: "ga", siteId: "G-XYZ" });
  assert.equal(deriveFromSite({}), null);
});

test("autoConfigureAnalytics derives config from site tracking settings", () => {
  const { board } = tmpBoard();
  assert.throws(() => autoConfigureAnalytics(board, "P"), /no site analytics/);
  setSiteAnalytics(board, "P", { provider: "plausible", id: "example.com" });
  const c = autoConfigureAnalytics(board, "P");
  assert.equal(c.enabled, true);
  assert.equal(c.provider, "plausible");
  assert.equal(c.siteId, "example.com");
});

test("periodToMs parses windows with a sane default", () => {
  assert.equal(periodToMs("1d"), 24 * 60 * 60 * 1000);
  assert.equal(periodToMs("2h"), 2 * 60 * 60 * 1000);
  assert.equal(periodToMs("garbage"), 7 * 24 * 60 * 60 * 1000);
});

test("getSiteTraffic: skips when disabled", async () => {
  const { board } = tmpBoard();
  const r = await getSiteTraffic(board, "P", {}, { fetchImpl: () => { throw new Error("no call"); }, env: {} });
  assert.equal(r.skipped, true);
  assert.match(r.reason, /disabled/);
});

test("getSiteTraffic: without a key returns the request descriptor to fetch manually", async () => {
  const { board } = tmpBoard();
  setAnalyticsConfig(board, "P", { enabled: true, provider: "plausible", siteId: "example.com" });
  const r = await getSiteTraffic(board, "P", {}, { fetchImpl: () => { throw new Error("no call"); }, env: {} });
  assert.equal(r.skipped, true);
  assert.match(r.reason, /FEATUREBOARD_ANALYTICS_KEY/);
  assert.match(r.request.url, /plausible\.io/);
});

test("getSiteTraffic: proxies via injected fetch and normalises", async () => {
  const { board } = tmpBoard();
  setAnalyticsConfig(board, "P", { enabled: true, provider: "plausible", siteId: "example.com" });
  let calledWith = null;
  const fetchImpl = async (url, opts) => {
    calledWith = { url, opts };
    return { ok: true, status: 200, json: async () => ({ results: { visitors: { value: 42 }, pageviews: { value: 108 } } }) };
  };
  const r = await getSiteTraffic(board, "P", { period: "30d" }, { fetchImpl, env: { FEATUREBOARD_ANALYTICS_KEY: "k" } });
  assert.equal(r.source, "proxy");
  assert.deepEqual(r.metrics, { visitors: 42, pageviews: 108 });
  assert.equal(calledWith.opts.headers.Authorization, "Bearer k");
  assert.match(calledWith.url, /period=30d/);
});

test("getSiteTraffic: surfaces provider errors with the descriptor", async () => {
  const { board } = tmpBoard();
  setAnalyticsConfig(board, "P", { enabled: true, provider: "plausible", siteId: "example.com" });
  const fetchImpl = async () => ({ ok: false, status: 401, text: async () => "unauthorized" });
  const r = await getSiteTraffic(board, "P", {}, { fetchImpl, env: { FEATUREBOARD_ANALYTICS_KEY: "bad" } });
  assert.match(r.error, /401/);
  assert.equal(r.body, "unauthorized");
  assert.match(r.request.url, /plausible\.io/);
});
