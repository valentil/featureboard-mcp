// FBMCPF-298 follow-up (found in review of the 2026-07-20 Opus batch): the
// interval-aware issuer's revocation records could never actually revoke a key.
//
//   (a) buildPayload() didn't embed orderId, so the signed key payload had no
//       orderId field — and isRevoked()'s all-specified-fields matcher means a
//       matcher that specifies orderId can then NEVER match any key.
//   (b) revocationFromEvent() used data.id as the orderId for BOTH event kinds,
//       but subscription.revoked carries a SUBSCRIPTION object whose id is a
//       sub id, not an order id — another never-matches matcher.
//   (c) it also combined { orderId, licensee } into one matcher; under
//       all-fields semantics that only ever makes matching harder.
//
// These tests pin the fixed behavior end-to-end: order.paid -> issued key whose
// payload embeds the order id -> order.refunded -> revocation record -> the
// real isRevoked() actually flags that key's payload.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
process.env.FEATUREBOARD_ISSUED_LOG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fb-iss-int-")), "issued-keys.json");
process.env.FEATUREBOARD_REVOCATIONS_LOG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fb-rev-int-")), "revocations.json");
import { intervalOf, expiryForInterval, orderToLicense, revocationFromEvent, handleWebhook } from "../owner/polar-webhook-issuer.mjs";
import { issueKey, buildPayload, yearsFromToday, daysFromToday } from "../owner/issue.mjs";
import { isRevoked } from "../server/license.js";

const { privateKey } = crypto.generateKeyPairSync("ed25519");
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });

const SECRET = "whsec_" + Buffer.from("test-secret-bytes").toString("base64");
function sign(body, { id = "msg_1", ts = Math.floor(Date.now() / 1000) } = {}) {
  const mac = crypto
    .createHmac("sha256", Buffer.from(SECRET.slice(6), "base64"))
    .update(`${id}.${ts}.${body}`)
    .digest("base64");
  return { "webhook-id": id, "webhook-timestamp": String(ts), "webhook-signature": `v1,${mac}` };
}

// ---------------------------------------------------------------------------
// interval detection + expiry sizing
// ---------------------------------------------------------------------------

test("intervalOf: finds the recurring interval wherever Polar exposes it", () => {
  assert.equal(intervalOf({ product: { recurring_interval: "month" } }), "month");
  assert.equal(intervalOf({ subscription: { recurring_interval: "year" } }), "year");
  assert.equal(intervalOf({ items: [{ price: { recurring_interval: "monthly" } }] }), "month");
  assert.equal(intervalOf({ items: [{ product: { recurring_interval: "annual" } }] }), "year");
  assert.equal(intervalOf({ recurring_interval: "MONTH" }), "month");
  assert.equal(intervalOf({}), null);
  assert.equal(intervalOf(null), null);
});

test("expiryForInterval: monthly ~38 days, everything else 1 year", () => {
  assert.equal(expiryForInterval("month"), daysFromToday(38));
  assert.equal(expiryForInterval("year"), yearsFromToday(1));
  assert.equal(expiryForInterval(null), yearsFromToday(1));
});

// ---------------------------------------------------------------------------
// the payload now embeds orderId (the piece that makes revocation matchable)
// ---------------------------------------------------------------------------

test("buildPayload/issueKey embed orderId in the signed payload", () => {
  const { payload } = issueKey({ licensee: "Acme Corp", seats: 2, expires: "2027-07-20", orderId: "ord_1" }, privatePem);
  assert.equal(payload.orderId, "ord_1");
  // absent orderId stays absent (legacy shape, no undefined/null field)
  assert.equal("orderId" in buildPayload({ licensee: "X" }), false);
});

test("orderToLicense carries the order id + interval through to issuance", () => {
  const lic = orderToLicense({
    type: "order.paid",
    data: { id: "ord_9", product: { recurring_interval: "month" }, customer: { name: "Acme", email: "a@acme.test" }, items: [{ quantity: 1 }] },
  });
  assert.equal(lic.orderId, "ord_9");
  assert.equal(lic.interval, "month");
  assert.equal(lic.expires, daysFromToday(38));
});

// ---------------------------------------------------------------------------
// revocationFromEvent emits matchers that can actually match
// ---------------------------------------------------------------------------

test("order.refunded -> single-field orderId matcher (no combined matcher)", () => {
  const rev = revocationFromEvent({
    type: "order.refunded",
    data: { id: "ord_1", customer: { name: "Acme Corp", email: "ops@acme.test" } },
  });
  assert.equal(rev.orderId, "ord_1");
  assert.equal("licensee" in rev, false); // combined matchers only ever make matching harder
  assert.equal(rev.reason, "order.refunded");
});

test("subscription.revoked -> sub id is NOT used as an orderId; falls back to licensee", () => {
  const rev = revocationFromEvent({
    type: "subscription.revoked",
    data: { id: "sub_123", customer: { name: "Acme Corp", email: "ops@acme.test" } },
  });
  assert.equal("orderId" in rev, false);
  assert.equal(rev.licensee, "Acme Corp");
});

test("subscription.revoked with a nested order id uses that order id", () => {
  const rev = revocationFromEvent({
    type: "subscription.revoked",
    data: { id: "sub_123", order: { id: "ord_7" }, customer: { email: "ops@acme.test" } },
  });
  assert.equal(rev.orderId, "ord_7");
});

// ---------------------------------------------------------------------------
// end-to-end: refund actually revokes the key that order issued
// ---------------------------------------------------------------------------

test("end-to-end: order.paid issues a key that order.refunded's record revokes", async () => {
  const orderBody = JSON.stringify({
    type: "order.paid",
    data: { id: "ord_e2e", customer: { name: "Acme Corp", email: "ops@acme.test" }, items: [{ quantity: 1 }] },
  });
  const res = await handleWebhook({ headers: sign(orderBody), body: orderBody, secret: SECRET, privatePem, allowlist: [] });
  assert.equal(res.out.issued, true);
  const issued = JSON.parse(fs.readFileSync(process.env.FEATUREBOARD_ISSUED_LOG, "utf8"));
  const payload = issued[issued.length - 1];
  assert.equal(payload.orderId, "ord_e2e"); // signed payload carries the order id

  const refundBody = JSON.stringify({
    type: "order.refunded",
    data: { id: "ord_e2e", customer: { name: "Acme Corp", email: "ops@acme.test" } },
  });
  const res2 = await handleWebhook({ headers: sign(refundBody, { id: "msg_2" }), body: refundBody, secret: SECRET, privatePem, allowlist: [] });
  assert.equal(res2.out.revoked, true);
  const revs = JSON.parse(fs.readFileSync(process.env.FEATUREBOARD_REVOCATIONS_LOG, "utf8"));

  // The whole point: the recorded revocation matches the issued key's payload.
  assert.equal(isRevoked(payload, revs), true);
  // And it does NOT nuke an unrelated order's key.
  const other = buildPayload({ licensee: "Acme Corp", orderId: "ord_other" });
  assert.equal(isRevoked(other, revs), false);
});
