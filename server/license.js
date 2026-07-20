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

export const USAGE_TYPES = ["personal", "public", "commercial-trial", "commercial"];
// where a commercial licence should be requested
export const LICENSE_CONTACT_URL =
  process.env.FEATUREBOARD_LICENSE_URL || "https://featureboard.ai/licensing";
export const LICENSE_CONTACT_EMAIL =
  process.env.FEATUREBOARD_LICENSE_EMAIL || "licensing@featureboard.ai";

// Published self-serve pricing (FBMCPF-208). Seat-year USD; checkout is the Polar
// storefront behind the stable featureboard.ai/buy redirect. Override for tests/staging.
export const PRICE_PER_SEAT_YEAR_USD = 119;
export const CHECKOUT_URL =
  process.env.FEATUREBOARD_CHECKOUT_URL || "https://featureboard.ai/buy";

function stateDir(dataDir) {
  return path.join(dataDir, STATE_DIR);
}
function statePath(dataDir) {
  return path.join(stateDir(dataDir), STATE_FILE);
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
  const s = readState(dataDir) || {};
  s.usageType = "commercial";
  s.licenseKey = key.trim();
  s.license = v.payload;
  s.updatedAt = new Date().toISOString();
  return writeState(dataDir, s);
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

  if (type === "personal" || type === "public") {
    return { status: type, configured: true, allowWrites: true, tier: type };
  }

  // A valid key always grants full commercial access.
  if (s.licenseKey) {
    const v = verifyKey(s.licenseKey);
    if (v.valid) {
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
