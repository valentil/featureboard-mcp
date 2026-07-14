/**
 * FeatureBoard external site-analytics config + read proxy (FBMCPF-83).
 *
 * The original OpenClaw board showed *live site traffic* on its dashboard. It did
 * this with a small server-side proxy: the browser asked the backend for stats,
 * the backend called the analytics provider's stats API (holding the API key so it
 * never reached the page, and sidestepping CORS), then handed the numbers back.
 *
 * This ports that as three pieces:
 *   - config          set_analytics_config: which provider + site id/domain to read
 *   - auto-configure  auto_configure_analytics: derive that from the site's existing
 *                     tracking settings (website.js setSiteAnalytics) so you don't
 *                     retype the domain
 *   - proxy           getSiteTraffic: fetch the provider's stats and normalise them
 *
 * Config lives in <project>/analytics.config.json:
 *   { enabled, provider, siteId, host, metrics, period, statsUrl }
 * Exactly like the git integration, **no secret is stored**: the stats API key is
 * read from the FEATUREBOARD_ANALYTICS_KEY environment variable at call time and is
 * never written to disk or echoed back. When no key (or no fetch) is available the
 * proxy degrades gracefully — it returns the exact request descriptor so Claude can
 * make the call itself, mirroring the "Claude is the agent" pattern used elsewhere.
 *
 * buildStatsRequest and normalizeStats are pure and exported for tests; getSiteTraffic
 * performs the fetch through an injectable `fetchImpl` (defaults to global fetch).
 */

import fs from "node:fs";
import path from "node:path";
import { getSite } from "./website.js";

export const ANALYTICS_CONFIG_FILE = "analytics.config.json";

/** Providers this proxy can read. `ga` is descriptor-only (needs OAuth / a connector). */
export const ANALYTICS_PROVIDERS = ["plausible", "umami", "ga", "custom"];

export const DEFAULT_ANALYTICS_CONFIG = {
  enabled: false,
  provider: "plausible",
  siteId: "", // plausible domain, umami website id, etc.
  host: "", // API host; defaults per-provider (e.g. plausible.io)
  metrics: ["visitors", "pageviews", "bounce_rate", "visit_duration"],
  period: "7d",
  statsUrl: "", // only for provider 'custom': the full stats endpoint
};

const KEY_ENV = "FEATUREBOARD_ANALYTICS_KEY";

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}
function atomicWrite(filePath, data) {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}
function configPath(board, project) {
  return path.join(board.projectDir(project), ANALYTICS_CONFIG_FILE);
}

/** Default API host for a provider when none is configured. */
export function defaultHost(provider) {
  if (provider === "plausible") return "plausible.io";
  return "";
}

/** Read a project's external-analytics config (merged over defaults). */
export function getAnalyticsConfig(board, project) {
  const raw = readJsonSafe(configPath(board, project));
  return { ...DEFAULT_ANALYTICS_CONFIG, ...(raw && typeof raw === "object" ? raw : {}) };
}

/** Update the config (only provided fields change). Validates types. */
export function setAnalyticsConfig(board, project, patch = {}) {
  const cfg = getAnalyticsConfig(board, project);
  if (patch.enabled != null) cfg.enabled = !!patch.enabled;
  if (patch.provider != null) {
    const p = String(patch.provider).toLowerCase();
    if (!ANALYTICS_PROVIDERS.includes(p)) {
      throw new Error(`provider must be one of: ${ANALYTICS_PROVIDERS.join(", ")}`);
    }
    cfg.provider = p;
  }
  if (patch.siteId != null) cfg.siteId = String(patch.siteId).trim();
  if (patch.host != null) cfg.host = String(patch.host).trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (patch.statsUrl != null) cfg.statsUrl = String(patch.statsUrl).trim();
  if (patch.period != null) {
    if (!String(patch.period).trim()) throw new Error("period must be non-empty");
    cfg.period = String(patch.period).trim();
  }
  if (patch.metrics != null) {
    if (!Array.isArray(patch.metrics) || !patch.metrics.length) {
      throw new Error("metrics must be a non-empty array of metric names");
    }
    cfg.metrics = patch.metrics.map((m) => String(m).trim()).filter(Boolean);
  }
  atomicWrite(configPath(board, project), JSON.stringify(cfg, null, 2) + "\n");
  return redactConfig(cfg);
}

/** Config as safe to return (no secrets are stored, but keep the shape consistent). */
export function redactConfig(cfg) {
  return {
    enabled: !!cfg.enabled,
    provider: cfg.provider,
    siteId: cfg.siteId || null,
    host: cfg.host || defaultHost(cfg.provider) || null,
    metrics: cfg.metrics,
    period: cfg.period,
    statsUrl: cfg.statsUrl || null,
  };
}

/**
 * Map the site's *tracking* analytics (website.js setSiteAnalytics: {provider,id})
 * to an external *reading* provider config. This is the "auto-configure" step —
 * you already told the site which domain/property to track, so reuse it.
 */
export function deriveFromSite(siteAnalytics) {
  const a = siteAnalytics && typeof siteAnalytics === "object" ? siteAnalytics : {};
  const raw = String(a.provider || "").toLowerCase();
  if (!raw && !a.id) return null;
  let provider = "custom";
  if (raw === "plausible") provider = "plausible";
  else if (raw === "umami") provider = "umami";
  else if (raw === "ga" || raw === "ga4" || raw === "google") provider = "ga";
  return { provider, siteId: a.id ? String(a.id) : "" };
}

/** Auto-configure external analytics from the project's site tracking settings. */
export function autoConfigureAnalytics(board, project) {
  const site = getSite(board, project);
  const derived = deriveFromSite(site && site.analytics);
  if (!derived) {
    throw new Error(
      "no site analytics to auto-configure from — set the site's tracking first with set_site_analytics, or configure manually with set_analytics_config"
    );
  }
  return setAnalyticsConfig(board, project, { ...derived, enabled: true });
}

/**
 * Build the provider stats-API request (pure). Returns { provider, method, url,
 * headers, hasKey }. The key is only placed in headers when supplied; callers that
 * expose the descriptor should not pass the key so it is never surfaced.
 */
export function buildStatsRequest(cfg, { period, metrics, key } = {}) {
  const provider = cfg.provider;
  const p = period || cfg.period || "7d";
  const mts = Array.isArray(metrics) && metrics.length ? metrics : cfg.metrics;
  const host = cfg.host || defaultHost(provider);
  const headers = {};
  if (key) headers.Authorization = `Bearer ${key}`;
  let url;
  if (provider === "custom") {
    if (!cfg.statsUrl) throw new Error("provider 'custom' needs a statsUrl (set_analytics_config)");
    url = cfg.statsUrl.replace(/\{period\}/g, encodeURIComponent(p));
  } else if (provider === "plausible") {
    if (!cfg.siteId) throw new Error("plausible needs a siteId (the site domain)");
    const qs = new URLSearchParams({ site_id: cfg.siteId, period: p, metrics: mts.join(",") });
    url = `https://${host}/api/v1/stats/aggregate?${qs.toString()}`;
  } else if (provider === "umami") {
    if (!host) throw new Error("umami needs a host (your umami instance URL)");
    if (!cfg.siteId) throw new Error("umami needs a siteId (the website id)");
    const end = Date.now();
    const start = end - periodToMs(p);
    const qs = new URLSearchParams({ startAt: String(start), endAt: String(end) });
    url = `https://${host}/api/websites/${cfg.siteId}/stats?${qs.toString()}`;
  } else if (provider === "ga") {
    // GA4 Data API needs OAuth; we can't build a bearer-key GET for it here.
    throw new Error(
      "Google Analytics reads need OAuth via a Google Analytics connector — this proxy can't call GA directly. Use provider 'plausible'/'umami'/'custom', or add the connector."
    );
  } else {
    throw new Error(`unsupported provider: ${provider}`);
  }
  return { provider, method: "GET", url, headers, hasKey: !!key };
}

/** Rough period → milliseconds for windowed providers (umami). */
export function periodToMs(period) {
  const m = String(period).match(/^(\d+)\s*([dhmw])$/i);
  const day = 24 * 60 * 60 * 1000;
  if (!m) return 7 * day;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (unit === "h") return n * 60 * 60 * 1000;
  if (unit === "d") return n * day;
  if (unit === "w") return n * 7 * day;
  if (unit === "m") return n * 30 * day;
  return 7 * day;
}

/** Normalise a provider's raw stats JSON into a flat { metric: value } map (pure). */
export function normalizeStats(provider, json) {
  if (!json || typeof json !== "object") return {};
  if (provider === "plausible") {
    const results = json.results || {};
    const out = {};
    for (const [k, v] of Object.entries(results)) {
      out[k] = v && typeof v === "object" && "value" in v ? v.value : v;
    }
    return out;
  }
  if (provider === "umami") {
    const out = {};
    for (const [k, v] of Object.entries(json)) {
      out[k] = v && typeof v === "object" && "value" in v ? v.value : v;
    }
    return out;
  }
  // custom / unknown: hand back whatever the endpoint returned.
  return json;
}

/**
 * The read proxy: fetch the configured provider's site traffic and return it
 * normalised. Degrades gracefully — when disabled, unconfigured, missing a key, or
 * without a fetch implementation, it returns { skipped, reason } plus the request
 * descriptor so Claude can make the call itself. `fetchImpl`/`env` are injectable.
 */
export async function getSiteTraffic(
  board,
  project,
  { period, metrics } = {},
  { fetchImpl = globalThis.fetch, env = process.env } = {}
) {
  const cfg = getAnalyticsConfig(board, project);
  const resolved = redactConfig(cfg);
  if (!cfg.enabled) {
    return { skipped: true, reason: "external analytics is disabled for this project (enable it with set_analytics_config)", config: resolved };
  }
  const key = env[KEY_ENV] || "";
  let descriptor;
  try {
    // Build a key-free descriptor for surfacing, and a real one for the call.
    descriptor = buildStatsRequest(cfg, { period, metrics });
  } catch (e) {
    return { skipped: true, reason: e.message, config: resolved };
  }
  const needsKey = cfg.provider === "plausible" || cfg.provider === "umami";
  if (needsKey && !key) {
    return {
      skipped: true,
      reason: `no stats API key — set the ${KEY_ENV} environment variable for the extension, or fetch the URL below yourself`,
      request: descriptor,
      config: resolved,
    };
  }
  if (typeof fetchImpl !== "function") {
    return { skipped: true, reason: "no fetch available in this runtime — fetch the request URL yourself", request: descriptor, config: resolved };
  }
  const real = buildStatsRequest(cfg, { period, metrics, key });
  try {
    const res = await fetchImpl(real.url, { method: "GET", headers: real.headers });
    if (!res || !res.ok) {
      const status = res ? res.status : "no response";
      let body = "";
      try { body = res && res.text ? await res.text() : ""; } catch { /* ignore */ }
      return { error: `stats request failed (${status})`, body: body ? String(body).slice(0, 500) : undefined, request: descriptor, config: resolved };
    }
    const json = await res.json();
    return {
      provider: cfg.provider,
      siteId: cfg.siteId || null,
      period: period || cfg.period,
      metrics: normalizeStats(cfg.provider, json),
      fetchedAt: new Date().toISOString(),
      source: "proxy",
      config: resolved,
    };
  } catch (e) {
    return { error: `stats request errored: ${e.message}`, request: descriptor, config: resolved };
  }
}
