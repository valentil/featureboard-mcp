#!/usr/bin/env node
/**
 * Polar checkout → auto-issued FeatureBoard license key (FBMCPF-210, +monthly FBMCPF-298).
 * OWNER-ONLY: needs owner/keys/private.pem. Never ship this folder.
 *
 * A tiny no-dependency HTTP listener for Polar webhooks (standard-webhooks spec):
 *   - verifies the webhook signature (HMAC-SHA256 over "id.timestamp.body")
 *   - on order.paid, issues a signed key sized to the billing interval
 *     (the signed payload embeds the Polar order id so refund revocations match):
 *       yearly / one-time  -> 1-year key   (annual plan; unchanged default)
 *       monthly            -> ~38-day key  (1 month + buffer; each renewal's
 *                            order.paid re-issues, so it auto-extends; on cancel
 *                            it simply lapses at period end and writes freeze)
 *     licensee = customer name/email, seats = quantity; appended to issued-keys.json
 *   - on order.refunded / subscription.revoked, records a revocation
 *     (owner/revocations.json, matched by license.js isRevoked on orderId/licensee)
 *   - delivers the key by email via Resend when RESEND_API_KEY is set; otherwise
 *     prints it so you can send it manually
 *
 * Env:
 *   POLAR_WEBHOOK_SECRET  required — from the Polar webhook settings ("whsec_...")
 *   POLAR_PRODUCT_IDS     optional comma-separated allowlist of product ids
 *   RESEND_API_KEY        optional — auto-email keys (from FEATUREBOARD_LICENSE_FROM,
 *                         default licensing@featureboard.ai)
 *   PORT                  default 8790
 *
 * Run:  POLAR_WEBHOOK_SECRET=whsec_... node owner/polar-webhook-issuer.mjs
 * Point the Polar webhook at  https://<your-tunnel-or-host>/polar
 *   Subscribe to events: order.paid, order.refunded, subscription.revoked
 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { issueKey, yearsFromToday, daysFromToday } from "./issue.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const issuedLogPath = () => process.env.FEATUREBOARD_ISSUED_LOG || path.join(__dirname, "issued-keys.json");
const revocationsLogPath = () => process.env.FEATUREBOARD_REVOCATIONS_LOG || path.join(__dirname, "revocations.json");
const LICENSE_FROM = process.env.FEATUREBOARD_LICENSE_FROM || "licensing@featureboard.ai";

// Monthly keys are issued one interval + buffer so a late renewal doesn't freeze a
// paying customer mid-cycle. Each renewal fires order.paid again and re-issues.
const MONTHLY_KEY_DAYS = 38;

/** Verify a standard-webhooks signature (Polar). secret: "whsec_"+base64. */
export function verifyPolarSignature({ id, timestamp, signature, body, secret, nowMs = Date.now() }) {
  if (!id || !timestamp || !signature || !secret) return { valid: false, error: "missing signature headers" };
  // reject stale deliveries (>5 min skew) to blunt replay
  const ts = parseInt(timestamp, 10);
  if (!Number.isFinite(ts) || Math.abs(nowMs / 1000 - ts) > 300) return { valid: false, error: "timestamp out of tolerance" };
  const secretBytes = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = crypto
    .createHmac("sha256", secretBytes)
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64");
  // header may carry several space-separated "v1,<sig>" entries
  for (const part of String(signature).split(" ")) {
    const sig = part.startsWith("v1,") ? part.slice(3) : part;
    const a = Buffer.from(sig), b = Buffer.from(expected);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return { valid: true };
  }
  return { valid: false, error: "signature mismatch" };
}

/**
 * Detect the billing interval of a Polar order payload. Returns "month" | "year" | null.
 * Checks the several places Polar may expose the recurring interval, defensively.
 */
export function intervalOf(o) {
  if (!o || typeof o !== "object") return null;
  const cand =
    (o.product && o.product.recurring_interval) ||
    (o.subscription && o.subscription.recurring_interval) ||
    (Array.isArray(o.items)
      ? o.items.map((it) => (it && ((it.price && it.price.recurring_interval) || (it.product && it.product.recurring_interval)))).find(Boolean)
      : null) ||
    o.recurring_interval ||
    null;
  if (!cand) return null;
  const s = String(cand).toLowerCase();
  if (s.startsWith("month")) return "month";
  if (s.startsWith("year") || s.startsWith("annual")) return "year";
  return null;
}

/** Expiry date for a billing interval. Unknown/one-time/annual -> 1 year (safe default). */
export function expiryForInterval(interval) {
  return interval === "month" ? daysFromToday(MONTHLY_KEY_DAYS) : yearsFromToday(1);
}

/** Extract what we need from a Polar order.paid payload. Returns null if not applicable. */
export function orderToLicense(event, productAllowlist = []) {
  if (!event || event.type !== "order.paid") return null;
  const o = event.data || {};
  if (productAllowlist.length && !productAllowlist.includes(o.product_id || (o.product && o.product.id))) return null;
  const email = (o.customer && o.customer.email) || o.customer_email || null;
  const name = (o.customer && o.customer.name) || null;
  if (!email && !name) return null;
  const qty = (Array.isArray(o.items) ? o.items.reduce((n, it) => n + (it.quantity || 1), 0) : o.quantity) || 1;
  const interval = intervalOf(o);
  return { licensee: name || email, email, seats: qty, interval, expires: expiryForInterval(interval), orderId: o.id || null };
}

/** Events that should immediately kill a key (refund / hard revoke). Cancel-at-period-end
 *  is NOT here: monthly keys lapse on their own at period end, annual are handled at renewal. */
const REVOKE_EVENTS = new Set(["order.refunded", "subscription.revoked"]);

/** Build a revocation record from a refund/revoke event, or null. Format matches the
 *  matcher fields license.js isRevoked() reads (orderId / licensee / issued).
 *
 *  Matcher semantics are ALL-specified-fields-must-match, so we emit the single
 *  most precise field that can actually match a key payload — never a combined
 *  {orderId, licensee} matcher (a payload missing either field would then never
 *  match, silently disabling the revocation):
 *    - order.* events: data IS the order — use its id as orderId (payloads
 *      issued since FBMCPF-298 embed orderId).
 *    - subscription.revoked: data is a SUBSCRIPTION object — its id is a sub id,
 *      NOT an order id, and would never match any key. Use the order id only if
 *      the payload nests one; otherwise fall back to a licensee matcher (kills
 *      that customer's keys, which is the intent of a hard revoke). */
export function revocationFromEvent(event) {
  if (!event || !REVOKE_EVENTS.has(event.type)) return null;
  const d = event.data || {};
  const isOrderEvent = String(event.type).startsWith("order.");
  const orderId = d.order_id || (d.order && d.order.id) || (isOrderEvent ? d.id : null) || null;
  const licensee = (d.customer && (d.customer.name || d.customer.email)) || d.customer_email || null;
  if (!orderId && !licensee) return null;
  return {
    ...(orderId ? { orderId } : { licensee }),
    reason: event.type,
    at: new Date().toISOString(),
  };
}

function appendIssued(entry) {
  let list = [];
  const p = issuedLogPath();
  try { list = JSON.parse(fs.readFileSync(p, "utf8")); } catch { list = []; }
  list.push(entry);
  fs.writeFileSync(p, JSON.stringify(list, null, 2), "utf8");
}

function appendRevocation(entry) {
  let list = [];
  const p = revocationsLogPath();
  try { list = JSON.parse(fs.readFileSync(p, "utf8")); if (!Array.isArray(list)) list = []; } catch { list = []; }
  list.push(entry);
  fs.writeFileSync(p, JSON.stringify(list, null, 2), "utf8");
}

async function emailKey({ to, licensee, key, payload }) {
  if (!process.env.RESEND_API_KEY || !to) return { sent: false, reason: "no RESEND_API_KEY or recipient" };
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: `FeatureBoard Licensing <${LICENSE_FROM}>`,
      to: [to],
      subject: "Your FeatureBoard commercial license key",
      text:
        `Thanks for buying FeatureBoard!\n\nLicensee: ${licensee}\nSeats: ${payload.seats || 1}\n` +
        `Valid until: ${payload.expires}\n\nYour license key:\n\n${key}\n\n` +
        `Activate it with the activate_license tool (or paste it into the onboarding screen).\n` +
        `Questions: ${LICENSE_FROM}`,
    }),
  });
  return { sent: res.ok, status: res.status };
}

export async function handleWebhook({ headers, body, secret, privatePem, allowlist }) {
  const v = verifyPolarSignature({
    id: headers["webhook-id"],
    timestamp: headers["webhook-timestamp"],
    signature: headers["webhook-signature"],
    body,
    secret,
  });
  if (!v.valid) return { status: 401, out: { error: v.error } };
  let event;
  try { event = JSON.parse(body); } catch { return { status: 400, out: { error: "bad json" } }; }

  // Refund / hard-revoke: record a revocation and stop.
  const rev = revocationFromEvent(event);
  if (rev) {
    appendRevocation(rev);
    console.log(`[revoked] ${rev.orderId || rev.licensee} (${rev.reason})`);
    return { status: 200, out: { revoked: true, orderId: rev.orderId || null, reason: rev.reason } };
  }

  const lic = orderToLicense(event, allowlist);
  if (!lic) return { status: 200, out: { ignored: event.type || "unknown" } };
  const { key, payload } = issueKey(lic, privatePem);
  const mail = await emailKey({ to: lic.email, licensee: lic.licensee, key, payload });
  appendIssued({ ...payload, interval: lic.interval || "year", email: lic.email, orderId: lic.orderId, key, emailed: mail.sent, at: new Date().toISOString() });
  console.log(`[issued] ${lic.licensee} seats=${payload.seats || 1} interval=${lic.interval || "year"} expires=${payload.expires} emailed=${mail.sent}`);
  if (!mail.sent) console.log(`Key (deliver manually to ${lic.email || "customer"}):\n${key}`);
  return { status: 200, out: { issued: true, licensee: lic.licensee, interval: lic.interval || "year", emailed: mail.sent } };
}

// ---- server (only when run directly) ----
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href) {
  const secret = process.env.POLAR_WEBHOOK_SECRET;
  if (!secret) { console.error("POLAR_WEBHOOK_SECRET is required."); process.exit(1); }
  const privatePem = fs.readFileSync(path.join(__dirname, "keys", "private.pem"), "utf8");
  const allowlist = (process.env.POLAR_PRODUCT_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const port = parseInt(process.env.PORT || "8790", 10);
  http
    .createServer((req, res) => {
      if (req.method !== "POST") { res.writeHead(405).end(); return; }
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        try {
          const r = await handleWebhook({ headers: req.headers, body, secret, privatePem, allowlist });
          res.writeHead(r.status, { "Content-Type": "application/json" }).end(JSON.stringify(r.out));
        } catch (e) {
          console.error("[error]", e);
          res.writeHead(500).end(JSON.stringify({ error: "internal" }));
        }
      });
    })
    .listen(port, () => console.log(`Polar webhook issuer listening on :${port} (POST /polar)`));
}
