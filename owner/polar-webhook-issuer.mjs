#!/usr/bin/env node
/**
 * Polar checkout → auto-issued FeatureBoard license key (FBMCPF-210).
 * OWNER-ONLY: needs owner/keys/private.pem. Never ship this folder.
 *
 * A tiny no-dependency HTTP listener for Polar webhooks (standard-webhooks spec):
 *   - verifies the webhook signature (HMAC-SHA256 over "id.timestamp.body")
 *   - on order.paid, issues a signed 1-year key (licensee = customer name/email,
 *     seats = quantity), appends to owner/issued-keys.json
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
 * Point the Polar webhook at  https://<your-tunnel-or-host>/polar  (event: order.paid)
 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { issueKey, yearsFromToday } from "./issue.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const issuedLogPath = () => process.env.FEATUREBOARD_ISSUED_LOG || path.join(__dirname, "issued-keys.json");
const LICENSE_FROM = process.env.FEATUREBOARD_LICENSE_FROM || "licensing@featureboard.ai";

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

/** Extract what we need from a Polar order.paid payload. Returns null if not applicable. */
export function orderToLicense(event, productAllowlist = []) {
  if (!event || event.type !== "order.paid") return null;
  const o = event.data || {};
  if (productAllowlist.length && !productAllowlist.includes(o.product_id || (o.product && o.product.id))) return null;
  const email = (o.customer && o.customer.email) || o.customer_email || null;
  const name = (o.customer && o.customer.name) || null;
  if (!email && !name) return null;
  const qty = (Array.isArray(o.items) ? o.items.reduce((n, it) => n + (it.quantity || 1), 0) : o.quantity) || 1;
  return { licensee: name || email, email, seats: qty, expires: yearsFromToday(1), orderId: o.id || null };
}

function appendIssued(entry) {
  let list = [];
  const p = issuedLogPath();
  try { list = JSON.parse(fs.readFileSync(p, "utf8")); } catch { list = []; }
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
  const lic = orderToLicense(event, allowlist);
  if (!lic) return { status: 200, out: { ignored: event.type || "unknown" } };
  const { key, payload } = issueKey(lic, privatePem);
  const mail = await emailKey({ to: lic.email, licensee: lic.licensee, key, payload });
  appendIssued({ ...payload, email: lic.email, orderId: lic.orderId, key, emailed: mail.sent, at: new Date().toISOString() });
  console.log(`[issued] ${lic.licensee} seats=${payload.seats || 1} expires=${payload.expires} emailed=${mail.sent}`);
  if (!mail.sent) console.log(`Key (deliver manually to ${lic.email || "customer"}):\n${key}`);
  return { status: 200, out: { issued: true, licensee: lic.licensee, emailed: mail.sent } };
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
