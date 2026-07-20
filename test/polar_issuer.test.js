import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
process.env.FEATUREBOARD_ISSUED_LOG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fb-issued-")), "issued-keys.json");
import { verifyPolarSignature, orderToLicense, handleWebhook } from "../owner/polar-webhook-issuer.mjs";
import { issueKey, buildPayload, yearsFromToday } from "../owner/issue.mjs";

const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });
const publicPem = publicKey.export({ type: "spki", format: "pem" });

const SECRET = "whsec_" + Buffer.from("test-secret-bytes").toString("base64");

function sign(body, { id = "msg_1", ts = Math.floor(Date.now() / 1000) } = {}) {
  const mac = crypto
    .createHmac("sha256", Buffer.from(SECRET.slice(6), "base64"))
    .update(`${id}.${ts}.${body}`)
    .digest("base64");
  return { "webhook-id": id, "webhook-timestamp": String(ts), "webhook-signature": `v1,${mac}` };
}

const ORDER = JSON.stringify({
  type: "order.paid",
  data: { id: "ord_1", product_id: "prod_fb", customer: { name: "Acme Corp", email: "ops@acme.test" }, items: [{ quantity: 5 }] },
});

test("valid standard-webhooks signature is accepted, tampered body rejected", () => {
  const h = sign(ORDER);
  assert.equal(verifyPolarSignature({ id: h["webhook-id"], timestamp: h["webhook-timestamp"], signature: h["webhook-signature"], body: ORDER, secret: SECRET }).valid, true);
  assert.equal(verifyPolarSignature({ id: h["webhook-id"], timestamp: h["webhook-timestamp"], signature: h["webhook-signature"], body: ORDER + " ", secret: SECRET }).valid, false);
});

test("stale timestamps are rejected (replay guard)", () => {
  const old = Math.floor(Date.now() / 1000) - 3600;
  const h = sign(ORDER, { ts: old });
  assert.equal(verifyPolarSignature({ id: "msg_1", timestamp: String(old), signature: h["webhook-signature"], body: ORDER, secret: SECRET }).valid, false);
});

test("order.paid maps to licensee/seats/1yr-expiry; other events ignored", () => {
  const lic = orderToLicense(JSON.parse(ORDER));
  assert.equal(lic.licensee, "Acme Corp");
  assert.equal(lic.seats, 5);
  assert.equal(lic.expires, yearsFromToday(1));
  assert.equal(orderToLicense({ type: "order.created", data: {} }), null);
  assert.equal(orderToLicense(JSON.parse(ORDER), ["other_product"]), null);
});

test("issued key payload matches buildPayload and signature verifies", () => {
  const { key, payload } = issueKey({ licensee: "Acme Corp", seats: 5, expires: "2027-07-19" }, privatePem);
  const [pb, sb] = key.split(".");
  const payloadBuf = Buffer.from(pb, "base64url");
  assert.equal(crypto.verify(null, payloadBuf, publicPem, Buffer.from(sb, "base64url")), true);
  const parsed = JSON.parse(payloadBuf.toString());
  assert.deepEqual(parsed, payload);
  assert.equal(parsed.type, "commercial");
  assert.equal(parsed.seats, 5);
  assert.equal(parsed.v, 1);
  assert.equal(buildPayload({ licensee: "X" }).expires, null);
});

test("handleWebhook end-to-end: 401 on bad sig, issues on good sig", async () => {
  const bad = await handleWebhook({ headers: {}, body: ORDER, secret: SECRET, privatePem, allowlist: [] });
  assert.equal(bad.status, 401);
  const h = sign(ORDER);
  const good = await handleWebhook({ headers: h, body: ORDER, secret: SECRET, privatePem, allowlist: [] });
  assert.equal(good.status, 200);
  assert.equal(good.out.issued, true);
  assert.equal(good.out.licensee, "Acme Corp");
});
