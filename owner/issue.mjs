/**
 * Shared owner-side key issuance (FBMCPF-210). OWNER-ONLY — needs the private key.
 * Used by generate-license.mjs (manual CLI) and polar-webhook-issuer.mjs (self-serve).
 */
import crypto from "node:crypto";

/** Build the canonical license payload. expires: "YYYY-MM-DD" | null (perpetual). */
export function buildPayload({ licensee, seats, expires }) {
  if (!licensee || !String(licensee).trim()) throw new Error("licensee is required");
  const s = parseInt(seats, 10) || undefined;
  return {
    licensee: String(licensee).trim(),
    type: "commercial",
    ...(s ? { seats: s } : {}),
    issued: new Date().toISOString().split("T")[0],
    expires: expires || null,
    v: 1,
  };
}

/** Sign a payload with the owner Ed25519 private key (PEM string). Returns the key string. */
export function issueKey(fields, privatePem) {
  const privateKey = crypto.createPrivateKey(privatePem);
  const payload = buildPayload(fields);
  const payloadBuf = Buffer.from(JSON.stringify(payload));
  const sig = crypto.sign(null, payloadBuf, privateKey);
  return { key: `${payloadBuf.toString("base64url")}.${sig.toString("base64url")}`, payload };
}

/** ISO date exactly `years` from today (self-serve default: 1-year keys). */
export function yearsFromToday(years = 1) {
  const d = new Date();
  d.setFullYear(d.getFullYear() + years);
  return d.toISOString().split("T")[0];
}
