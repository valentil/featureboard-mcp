#!/usr/bin/env node
/**
 * Generate a fresh Ed25519 signing keypair for FeatureBoard licensing.
 * OWNER-ONLY. Run once. Keep the private key secret; ship only the public key.
 *
 *   node owner/keygen.mjs
 *
 * Writes owner/keys/private.pem (SECRET) and prints the public key block to paste
 * into server/license.js (PUBLIC_KEY). Rotating the keypair invalidates every
 * previously issued license key.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const keysDir = path.join(__dirname, "keys");
fs.mkdirSync(keysDir, { recursive: true });

const privPath = path.join(keysDir, "private.pem");
if (fs.existsSync(privPath) && !process.argv.includes("--force")) {
  console.error(`Refusing to overwrite existing ${privPath}. Pass --force to rotate (invalidates all issued keys).`);
  process.exit(1);
}

const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const pub = publicKey.export({ type: "spki", format: "pem" }).toString();
const priv = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

fs.writeFileSync(privPath, priv, { mode: 0o600 });
console.log(`Wrote private key -> ${privPath} (KEEP SECRET)\n`);
console.log("Paste this into server/license.js as PUBLIC_KEY:\n");
console.log(pub);
