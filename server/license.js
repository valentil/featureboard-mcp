/**
 * FeatureBoard licensing.
 *
 * Tiers (chosen during onboarding via set_usage_type):
 *   - "personal"        : free, private non-commercial use. Full access, no expiry.
 *   - "public"          : free public / open-source / nonprofit use. Full access, no expiry.
 *   - "commercial-trial": 24-hour self-serve commercial trial. Full access until the
 *                         clock runs out, then WRITES freeze (reads stay available)
 *                         until a valid commercial key is activated.
 *   - "commercial"      : requires a signed license key.
 *
 * Keys are verified OFFLINE with an embedded Ed25519 public key — no phone-home.
 * The matching private key lives only with the owner (see /owner). A key is:
 *     base64url(JSON payload) + "." + base64url(signature)
 * payload = { licensee, type:"commercial", seats?, issued, expires|null, v:1 }
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// Public key — safe to embed and ship. Regenerate with owner/keygen.mjs to rotate.
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAQXNPP6asipO3lRhMxHXlOUhwdOwtSLS7yFklkYcnQmI=
-----END PUBLIC KEY-----`;

const TRIAL_MS = 24 * 60 * 60 * 1000;
const STATE_DIR = ".featureboard";
const STATE_FILE = "license.json";
const REQUESTS_FILE = "license_requests.json";
const REVOCATIONS_FILE = "revocations.json";

export const USAGE_TYPES = ["personal", "public", "commercial-trial", "commercial"];
// where a commercial licence should be requested
export const LICENSE_CONTACT_URL =
  process.env.FEATUREBOARD_LICENSE_URL || "https://featureboard.ai/licensing";
export const LICENSE_CONTACT_EMAIL =
  process.env.FEATUREBOARD_LICENSE_EMAIL || "licensing@featureboard.ai";

// Published self-serve pricing (FBMCPF-208). Seat-year USD; checkout is the Polar
// storefront behind the stable featureboard.ai/buy redirect. Override for tests/staging.
export const PRICE_PER_SEAT_YEAR_USD = 99.99;
export const CHECKOUT_URL =
  process.env.FEATUREBOARD_CHECKOUT_URL || "https://featureboard.ai/buy";

// --- Free-tier feature cap (FBMCPF-294) --------------------------------------
// The free ("personal") tier is metered by TOP-LEVEL feature count across all
// boards in the data dir. Breaking a feature into subtasks via decompose_feature
// (those carry a 🔗 parent link) does NOT count, and bugs never count — only real
// top-level feature requests. Soft cap warns; hard cap freezes writes (reads always
// stay). Both env-overridable so the dial can move without a release. OSS/"public"
// and licensed commercial users are never capped.
export const FREE_FEATURE_SOFT = Math.max(0, parseInt(process.env.FEATUREBOARD_FREE_FEATURE_SOFT || "25", 10) || 25);
export const FREE_FEATURE_HARD = Math.max(FREE_FEATURE_SOFT, parseInt(process.env.FEATUREBOARD_FREE_FEATURE_HARD || "30", 10) || 30);

// A top-level feature line in featurelist.md: checkbox + [PREFIX-<n>] id, and no
// 🔗 link token (decompose subtasks link back to their parent).
const TOP_LEVEL_FEATURE_RE = /^\s*-\s*\[[ xXpPrR\-]\]\s*\[[A-Z][A-Z0-9\-]*\d+\]/;

/** Count top-level features across every board under dataDir (bugs + subtasks excluded). */
export function countTopLevelFeatures(dataDir) {
  let count = 0;
  let entries;
  try {
    entries = fs.readdirSync(dataDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name === STATE_DIR) continue;
    let text;
    try {
      text = fs.readFileSync(path.join(dataDir, e.name, "featurelist.md"), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      if (TOP_LEVEL_FEATURE_RE.test(line) && !line.includes("🔗")) count++;
    }
  }
  return count;
}

/** Pure quota evaluation. state: "ok" | "soft" (warn) | "hard" (freeze writes). */
export function featureQuota(count, { soft = FREE_FEATURE_SOFT, hard = FREE_FEATURE_HARD } = {}) {
  const n = Number(count) || 0;
  if (n >= hard) return { state: "hard", count: n, soft, hard, allowWrites: false };
  if (n >= soft) return { state: "soft", count: n, soft, hard, allowWrites: true };
  return { state: "ok", count: n, soft, hard, allowWrites: true };
}

// Activation-by-order (FBMCPF-274): claim a signed key from the featureboard.ai
// claim API using the receipt email + order id, instead of pasting a key. The
// key it returns still goes through the exact same offline verifyKey/activate
// path as a pasted key — this only replaces how the key ARRIVES.
export const CLAIM_URL = process.env.FEATUREBOARD_CLAIM_URL || "https://featureboard.ai/api/claim";
export const MANUAL_CLAIM_URL = "https://featureboard.ai/claim";
const CLAIM_TIMEOUT_MS = 10000;

function stateDir(dataDir) {
  return path.join(dataDir, STATE_DIR);
}
function statePath(dataDir) {
  return path.join(stateDir(dataDir), STATE_FILE);
}
function revocationsPath(dataDir) {
  return path.join(stateDir(dataDir), REVOCATIONS_FILE);
}

export function readState(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(statePath(dataDir), "utf8"));
  } catch {
    return null;
  }
}

export function writeState(dataDir, s) {
  fs.mkdirSync(stateDir(dataDir), { recursive: true });
  fs.writeFileSync(statePath(dataDir), JSON.stringify(s, null, 2), "utf8");
  return s;
}

/**
 * Local revocation list (FBMCPF-276 — refunds should be able to kill a key,
 * without breaking the offline no-phone-home validation model). Lives
 * alongside license.json in the same data dir. Entirely optional: missing or
 * malformed file is a no-op (nothing is ever revoked by accident because the
 * file couldn't be read). Populated by owner/revoke.mjs; copy the file to any
 * machine you control to enforce it there (see owner/README.md's "Refunds"
 * section) — this check is local, there is no phone-home lookup.
 */
export function readRevocations(dataDir) {
  try {
    const data = JSON.parse(fs.readFileSync(revocationsPath(dataDir), "utf8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export function writeRevocations(dataDir, list) {
  fs.mkdirSync(stateDir(dataDir), { recursive: true });
  fs.writeFileSync(revocationsPath(dataDir), JSON.stringify(list, null, 2), "utf8");
  return list;
}

// Fields a revocation matcher may specify. A matcher revokes a payload when
// EVERY field it specifies (non-empty) equals the same field on the payload;
// unspecified fields are ignored, and a matcher that specifies nothing is
// treated as malformed (skipped, never a blanket match).
const REVOCATION_MATCH_FIELDS = ["orderId", "licensee", "issued"];

/** Does `payload` match any matcher in `list`? See REVOCATION_MATCH_FIELDS above. */
export function isRevoked(payload, list) {
  if (!payload || typeof payload !== "object" || !Array.isArray(list) || list.length === 0) return false;
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const specified = REVOCATION_MATCH_FIELDS.filter(
      (f) => entry[f] !== undefined && entry[f] !== null && entry[f] !== ""
    );
    if (specified.length === 0) continue; // malformed matcher: nothing to match on
    const allMatch = specified.every(
      (f) => payload[f] !== undefined && payload[f] !== null && String(payload[f]) === String(entry[f])
    );
    if (allMatch) return true;
  }
  return false;
}

/** Verify a license key's signature and expiry. */
export function verifyKey(key) {
  try {
    const [pb, sb] = String(key).trim().split(".");
    if (!pb || !sb) return { valid: false, error: "malformed key" };
    const payloadBuf = Buffer.from(pb, "base64url");
    const ok = crypto.verify(null, payloadBuf, PUBLIC_KEY, Buffer.from(sb, "base64url"));
    if (!ok) return { valid: false, error: "signature check failed" };
    const payload = JSON.parse(payloadBuf.toString());
    // allow one grace day past expiry to avoid timezone edge cases
    if (payload.expires && Date.now() > Date.parse(payload.expires) + 86400000) {
      return { valid: false, error: "license expired", payload };
    }
    return { valid: true, payload };
  } catch (e) {
    return { valid: false, error: e.message };
  }
}

/** Record the chosen usage tier (onboarding). Starts the trial clock if needed. */
export function setUsageType(dataDir, type) {
  if (!USAGE_TYPES.includes(type)) throw new Error(`Unknown usage type: ${type}`);
  const s = readState(dataDir) || {};
  s.usageType = type;
  s.updatedAt = new Date().toISOString();
  if (type === "commercial-trial" && !s.trialStart) s.trialStart = new Date().toISOString();
  return writeState(dataDir, s);
}

/** Activate a commercial license key. */
export function activate(dataDir, key) {
  const v = verifyKey(key);
  if (!v.valid) throw new Error(`Invalid license key: ${v.error}`);
  if (isRevoked(v.payload, readRevocations(dataDir))) {
    throw new Error(
      `This license key has been revoked (e.g. following a refund). Contact ${LICENSE_CONTACT_EMAIL} if you believe this is an error.`
    );
  }
  const s = readState(dataDir) || {};
  s.usageType = "commercial";
  s.licenseKey = key.trim();
  s.license = v.payload;
  s.updatedAt = new Date().toISOString();
  return writeState(dataDir, s);
}

/**
 * Claim a signed license key from the featureboard.ai claim API using the
 * buyer's receipt email + order id (FBMCPF-274) — the "activation by order"
 * mode of activate_license, as an alternative to pasting a key.
 *
 * POSTs { email, orderId } to CLAIM_URL and expects 200 { key, licensee, seats,
 * expires } on success. Never throws a raw network/HTTP error: every failure
 * mode is mapped to an actionable message (and 404/429 get their own clear
 * wording), each pointing at MANUAL_CLAIM_URL as a fallback. Never logs the
 * full key — callers get it back in the return value only.
 *
 * `fetchImpl` is injectable (defaults to globalThis.fetch) so tests can drive
 * every path (success / 404 / 429 / network failure) without real network
 * access — same pattern as registerEmail (server/registration.js) and
 * checkUpdates (server/updates.js).
 */
export async function fetchKeyByOrder({ email, orderId, fetchImpl } = {}) {
  const trimmedEmail = typeof email === "string" ? email.trim() : "";
  const trimmedOrderId = typeof orderId === "string" ? orderId.trim() : String(orderId == null ? "" : orderId).trim();
  if (!trimmedEmail || !trimmedOrderId) {
    throw new Error("email and orderId are both required to claim a license key.");
  }

  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== "function") {
    throw new Error(
      `No fetch implementation available to reach the claim API. Claim your key manually at ${MANUAL_CLAIM_URL}.`
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLAIM_TIMEOUT_MS);
  let res;
  try {
    res = await doFetch(CLAIM_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: trimmedEmail, orderId: trimmedOrderId }),
      signal: controller.signal,
    });
  } catch (err) {
    const msg =
      err && err.name === "AbortError"
        ? `timed out after ${CLAIM_TIMEOUT_MS / 1000}s`
        : (err && err.message) || String(err);
    throw new Error(`Could not reach the featureboard.ai claim API (${msg}). Claim your key manually at ${MANUAL_CLAIM_URL}.`);
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 404) {
    throw new Error("no key found for that email+order");
  }
  if (res.status === 429) {
    throw new Error("too many attempts, wait an hour");
  }
  if (!res.ok) {
    throw new Error(`Claim API responded with HTTP ${res.status}. Claim your key manually at ${MANUAL_CLAIM_URL}.`);
  }

  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error(`Claim API returned an unreadable response. Claim your key manually at ${MANUAL_CLAIM_URL}.`);
  }
  // FBMCPF-276: the claim API flags refunded/cancelled orders with revoked:true
  // (server-side, tracked against the order/claim KV record) -- refuse before
  // ever handing back a key, rather than letting a revoked order still claim one.
  if (body && body.revoked) {
    throw new Error(
      `This order's license has been revoked (e.g. following a refund). Contact ${LICENSE_CONTACT_EMAIL} if you believe this is an error.`
    );
  }
  if (!body || !body.key) {
    throw new Error(`Claim API response did not include a key. Claim your key manually at ${MANUAL_CLAIM_URL}.`);
  }
  return { key: body.key, licensee: body.licensee, seats: body.seats, expires: body.expires };
}

/** Record a commercial-license request locally (fed into the owner's CRM pipeline). */
export function recordRequest(dataDir, req) {
  const p = path.join(stateDir(dataDir), REQUESTS_FILE);
  let list = [];
  try {
    list = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    list = [];
  }
  const entry = {
    id: `LR-${Date.now()}`,
    submittedAt: new Date().toISOString(),
    status: "new",
    ...req,
  };
  list.push(entry);
  fs.mkdirSync(stateDir(dataDir), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(list, null, 2), "utf8");
  return entry;
}

/**
 * Evaluate current entitlement. Returns { status, allowWrites, configured, message?, ... }.
 * Reads are always allowed; only allowWrites gates mutating tools.
 */
export function evaluate(dataDir) {
  const s = readState(dataDir) || {};
  const type = s.usageType;

  if (!type) {
    return {
      status: "unconfigured",
      configured: false,
      allowWrites: true,
      message:
        "Usage type not set. Ask the user (onboarding) whether this is personal/non-commercial, public/open-source, or commercial use, then call set_usage_type.",
    };
  }

  if (type === "personal") {
    const featureCount = countTopLevelFeatures(dataDir);
    const q = featureQuota(featureCount);
    if (q.state === "hard") {
      return {
        status: "free-limit-reached",
        configured: true,
        allowWrites: false,
        tier: "personal",
        featureCount,
        featureCap: q.hard,
        checkoutUrl: CHECKOUT_URL,
        message:
          `Free tier limit reached: ${featureCount} of ${q.hard} features. Reads still work; new writes are frozen. ` +
          `Keep going with a license (US$${PRICE_PER_SEAT_YEAR_USD}/seat/yr) at ${CHECKOUT_URL}, then run activate_license. ` +
          `Open-source projects and verified students are free and uncapped — set usage type "public" if that applies.`,
      };
    }
    if (q.state === "soft") {
      return {
        status: "personal",
        configured: true,
        allowWrites: true,
        tier: "personal",
        featureCount,
        featureCap: q.hard,
        warn: true,
        message:
          `You're at ${featureCount} of ${q.hard} free features — writes freeze at ${q.hard}. ` +
          `Grab a license (US$${PRICE_PER_SEAT_YEAR_USD}/seat/yr) at ${CHECKOUT_URL} to keep going uninterrupted.`,
      };
    }
    return { status: "personal", configured: true, allowWrites: true, tier: "personal", featureCount, featureCap: q.hard };
  }

  if (type === "public") {
    // Open-source / nonprofit — genuinely free and uncapped (funnel + goodwill).
    return { status: "public", configured: true, allowWrites: true, tier: "public" };
  }

  // A valid key always grants full commercial access -- unless it's been revoked.
  if (s.licenseKey) {
    const v = verifyKey(s.licenseKey);
    if (v.valid) {
      if (isRevoked(v.payload, readRevocations(dataDir))) {
        return {
          status: "commercial-revoked",
          configured: true,
          allowWrites: false,
          license: v.payload,
          message:
            `This license has been revoked (e.g. following a refund). Writes are frozen; reads remain available. ` +
            `Contact ${LICENSE_CONTACT_EMAIL} if you believe this is an error.`,
        };
      }
      return { status: "commercial-licensed", configured: true, allowWrites: true, license: v.payload };
    }
    if (type === "commercial") {
      return {
        status: "commercial-invalid",
        configured: true,
        allowWrites: false,
        checkoutUrl: CHECKOUT_URL,
        message: `Commercial license key invalid or expired (${v.error}). Writes are frozen; reads remain available. Buy a new key (US$${PRICE_PER_SEAT_YEAR_USD}/seat/yr) at ${CHECKOUT_URL}, then activate_license.`,
      };
    }
  }

  if (type === "commercial") {
    return {
      status: "commercial-unlicensed",
      configured: true,
      allowWrites: false,
      checkoutUrl: CHECKOUT_URL,
      message:
        `Commercial use requires a license key. Buy one now (US$${PRICE_PER_SEAT_YEAR_USD}/seat/yr) at ${CHECKOUT_URL} and run activate_license — or use request_commercial_license for custom/enterprise terms. Writes are frozen; reads remain available.`,
    };
  }

  // commercial-trial
  const start = s.trialStart ? Date.parse(s.trialStart) : Date.now();
  const remaining = TRIAL_MS - (Date.now() - start);
  if (remaining > 0) {
    return {
      status: "trial-active",
      configured: true,
      allowWrites: true,
      trialRemainingMs: remaining,
      trialRemainingHours: Math.round((remaining / 3600000) * 10) / 10,
      trialEndsAt: new Date(start + TRIAL_MS).toISOString(),
    };
  }
  return {
    status: "trial-expired",
    configured: true,
    allowWrites: false,
    trialEndedAt: new Date(start + TRIAL_MS).toISOString(),
    checkoutUrl: CHECKOUT_URL,
    message:
      `The 24-hour commercial trial has expired. Reads still work, but writes are frozen. ` +
      `Buy a key now (US$${PRICE_PER_SEAT_YEAR_USD}/seat/yr) at ${CHECKOUT_URL} and run activate_license — or use request_commercial_license for custom/enterprise terms.`,
  };
}
