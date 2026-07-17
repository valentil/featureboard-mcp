/**
 * FeatureBoard registration — optional onboarding email (FBMCPF-130).
 *
 * The tier-picker onboarding screen (see openOnboarding in artifact/board.html) offers
 * an OPTIONAL email field alongside the usage-tier buttons. Nothing is stored or sent
 * anywhere until the user explicitly submits it — clicking "Save email" in that modal
 * is the one and only consent signal this module recognizes, and it is a separate,
 * deliberate action from picking a tier. There is no usage telemetry: registerEmail
 * stores and posts the email address and nothing else.
 *
 * Egress: exactly one deliberate outbound call, to the featureboard.ai registrations
 * listener (FEATUREBOARD_REGISTRATION_URL, default https://featureboard.ai/api/registrations
 * — the receiving endpoint is built in FBMCPF-131; the path here must match it). The
 * board is otherwise local-only; see docs/compliance/PRIVACY.md for the full disclosure.
 *
 * Local-first: the email is written to local state (.featureboard/registration.json)
 * before any network attempt, and stays there regardless of whether the POST succeeds.
 * "posted" is tracked so a repeat call (e.g. the agent re-invoking the tool, or the UI
 * calling again after a reload) does not re-send — the "POSTed once" contract is
 * enforced here, not left to the caller to get right.
 *
 * Failure-tolerant, mirroring slack.js: registerEmail never throws. Network problems
 * come back as { stored:true, posted:false, warning }.
 */

import fs from "node:fs";
import path from "node:path";

const STATE_DIR = ".featureboard";
const STATE_FILE = "registration.json";
const POST_TIMEOUT_MS = 5000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Base URL for the featureboard.ai registrations listener (FBMCPF-131 builds the receiver). */
export const REGISTRATION_URL =
  process.env.FEATUREBOARD_REGISTRATION_URL || "https://featureboard.ai/api/registrations";

function stateDir(dataDir) {
  return path.join(dataDir, STATE_DIR);
}
function statePath(dataDir) {
  return path.join(stateDir(dataDir), STATE_FILE);
}

/** Current local registration state, or null if nothing has been submitted yet. */
export function readRegistration(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(statePath(dataDir), "utf8"));
  } catch {
    return null;
  }
}

function writeRegistration(dataDir, s) {
  fs.mkdirSync(stateDir(dataDir), { recursive: true });
  fs.writeFileSync(statePath(dataDir), JSON.stringify(s, null, 2), "utf8");
  return s;
}

/**
 * Register an optional onboarding email.
 *
 * `email` must be a non-empty, validly-shaped string the caller obtained via explicit
 * user submission (the tier-picker's "Save email" button). This function does not
 * itself ask "did the user consent" beyond that — the act of being called with a
 * non-empty email IS the consent signal from the UI; callers must never invoke this
 * speculatively (e.g. from autofill or on every onboarding render).
 *
 * No email (undefined/empty/whitespace-only), or a malformed one → no-op:
 * { stored:false, posted:false, reason }. No local write, no network call.
 *
 * Otherwise: stores { email, registeredAt } locally, then — unless a previous call
 * already posted this same email — attempts exactly one POST to REGISTRATION_URL with
 * { email, registeredAt }. Never throws; network failures return
 * { stored:true, posted:false, warning }. A repeat call after a successful post
 * returns { stored:true, posted:true, alreadyPosted:true } without hitting the network
 * again.
 *
 * `fetchImpl` is injectable (defaults to globalThis.fetch) so tests can exercise the
 * success / HTTP-error / rejection paths without real network access.
 */
export async function registerEmail(dataDir, email, { fetchImpl } = {}) {
  const trimmed = typeof email === "string" ? email.trim() : "";
  if (!trimmed) {
    return {
      stored: false,
      posted: false,
      reason: "no email provided — onboarding email is optional and requires explicit submit",
    };
  }
  if (!EMAIL_RE.test(trimmed)) {
    return { stored: false, posted: false, reason: "not a valid email address" };
  }

  const existing = readRegistration(dataDir);
  const sameEmail = existing && existing.email === trimmed;
  const registeredAt = (sameEmail && existing.registeredAt) || new Date().toISOString();
  let state = writeRegistration(dataDir, {
    email: trimmed,
    registeredAt,
    posted: !!(sameEmail && existing.posted),
    postedAt: (sameEmail && existing.postedAt) || null,
  });

  if (state.posted) {
    return { stored: true, posted: true, alreadyPosted: true };
  }

  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== "function") {
    return { stored: true, posted: false, warning: "no fetch implementation available" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
  try {
    const res = await doFetch(REGISTRATION_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: trimmed, registeredAt }),
      signal: controller.signal,
    });
    if (!res || !res.ok) {
      const status = res && res.status != null ? res.status : "unknown";
      return { stored: true, posted: false, warning: `registration listener responded with HTTP ${status}` };
    }
    writeRegistration(dataDir, { ...state, posted: true, postedAt: new Date().toISOString() });
    return { stored: true, posted: true };
  } catch (err) {
    const msg = err && err.name === "AbortError" ? "timed out after 5s" : (err && err.message) || String(err);
    return { stored: true, posted: false, warning: `registration POST failed: ${msg}` };
  } finally {
    clearTimeout(timer);
  }
}
