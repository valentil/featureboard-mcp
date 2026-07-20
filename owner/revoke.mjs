#!/usr/bin/env node
/**
 * Append a local revocation matcher (FBMCPF-276 — refunds should be able to
 * kill a key without breaking the offline no-phone-home validation model).
 * OWNER-ONLY.
 *
 * Usage:
 *   node owner/revoke.mjs --orderId ord_x --licensee "Acme"
 *   node owner/revoke.mjs --licensee "Acme Corp"
 *   node owner/revoke.mjs --issued 2026-01-01 --licensee "Acme Corp"
 *
 * Appends a matcher { orderId?, licensee?, issued? } to owner/revocations.json.
 * server/license.js's isRevoked() treats a license payload as revoked when
 * EVERY field a matcher specifies equals the same field on the payload
 * (unspecified fields are ignored; a matcher with nothing specified is
 * malformed and never matches). evaluate() and activate() both check this
 * list, so:
 *   - an already-activated key retroactively flips to "commercial-revoked"
 *     (writes freeze, reads still work) the next time evaluate() runs, and
 *   - a revoked key can no longer be (re-)activated at all.
 *
 * This is a LOCAL, offline check — nothing here calls out to the network.
 * See owner/README.md's "Refunds" section for the full runbook, including
 * copying this file to any other machine you control and the separate
 * worker-side KV change (tracked in the website repo) needed to stop the
 * order being claimable via activate_license's email+orderId mode.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REVOCATIONS_PATH = process.env.FEATUREBOARD_OWNER_REVOCATIONS || path.join(__dirname, "revocations.json");

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}

const orderId = arg("orderId");
const licensee = arg("licensee");
const issued = arg("issued");

if (!orderId && !licensee && !issued) {
  console.error(
    'Provide at least one of --orderId, --licensee, --issued. Example:\n' +
      '  node owner/revoke.mjs --orderId ord_x --licensee "Acme"'
  );
  process.exit(1);
}

let list = [];
try {
  const parsed = JSON.parse(fs.readFileSync(REVOCATIONS_PATH, "utf8"));
  if (Array.isArray(parsed)) list = parsed;
} catch {
  list = [];
}

const matcher = {
  ...(orderId ? { orderId } : {}),
  ...(licensee ? { licensee } : {}),
  ...(issued ? { issued } : {}),
  revokedAt: new Date().toISOString(),
};
list.push(matcher);

fs.mkdirSync(path.dirname(REVOCATIONS_PATH), { recursive: true });
fs.writeFileSync(REVOCATIONS_PATH, JSON.stringify(list, null, 2), "utf8");

console.log("Appended revocation matcher:");
console.log(JSON.stringify(matcher, null, 2));
console.log(`\nWrote to ${REVOCATIONS_PATH}`);
console.log(
  "\nThis file only enforces the check LOCALLY, wherever it's read from " +
    "(<boards>/.featureboard/revocations.json on a server-side install). " +
    "Copy it to any other machine you control to enforce it there too.\n" +
    "\nREMINDER: also set revoked:true on the worker KV `claim:` and `order:` " +
    "records for this order (website repo) so the order stops being claimable " +
    "via activate_license's email+orderId mode."
);
