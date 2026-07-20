#!/usr/bin/env node
/**
 * Issue a signed FeatureBoard commercial license key.
 * OWNER-ONLY: needs owner/keys/private.pem, which must never ship to customers.
 *
 * Usage:
 *   node owner/generate-license.mjs --licensee "Acme Corp" --seats 5 --expires 2027-07-13
 *   node owner/generate-license.mjs --licensee "Acme Corp"            # perpetual (no expiry)
 *
 * Prints the license key to paste into the customer's activate_license tool.
 */
import fs from "node:fs";
import path from "node:path";
import { issueKey } from "./issue.mjs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const licensee = arg("licensee");
if (!licensee) {
  console.error('Missing --licensee. Example:\n  node owner/generate-license.mjs --licensee "Acme Corp" --seats 5 --expires 2027-07-13');
  process.exit(1);
}
const seats = parseInt(arg("seats", "0"), 10) || undefined;
const expires = arg("expires", null); // YYYY-MM-DD or null = perpetual

const keyPath = arg("key", path.join(__dirname, "keys", "private.pem"));
let privatePem;
try {
  privatePem = fs.readFileSync(keyPath, "utf8");
} catch {
  console.error(`Could not read private key at ${keyPath}. Run: node owner/keygen.mjs`);
  process.exit(1);
}
const { key, payload } = issueKey({ licensee, seats, expires }, privatePem);

console.log("License payload:", JSON.stringify(payload, null, 2));
console.log("\nLicense key (send to customer):\n");
console.log(key);
