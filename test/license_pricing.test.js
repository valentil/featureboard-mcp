import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PRICE_PER_SEAT_YEAR_USD,
  CHECKOUT_URL,
  LICENSE_CONTACT_URL,
  verifyKey,
  setUsageType,
  writeState,
  evaluate,
} from "../server/license.js";

// FBMCPF-208 (repriced by FBMCPF-294/295): published pricing surfaced from the
// license module. $99.99/seat/yr since 2026-07-20 ($9.99/mo lives checkout-side).
test("published price is $99.99/seat/year", () => {
  assert.equal(PRICE_PER_SEAT_YEAR_USD, 99.99);
});

test("checkout URL defaults to the stable featureboard.ai/buy redirect", () => {
  assert.equal(CHECKOUT_URL, "https://featureboard.ai/buy");
  assert.ok(LICENSE_CONTACT_URL.startsWith("https://"));
});

test("verifyKey still rejects malformed keys (pricing change is additive)", () => {
  assert.equal(verifyKey("not-a-key").valid, false);
});

// FBMCPF-209: every write-blocking state carries the checkout URL.
test("trial-expired message includes price and checkout URL", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-lic-"));
  setUsageType(dir, "commercial-trial");
  writeState(dir, {
    usageType: "commercial-trial",
    trialStart: new Date(Date.now() - 25 * 3600000).toISOString(),
  });
  const ev = evaluate(dir);
  assert.equal(ev.status, "trial-expired");
  assert.equal(ev.allowWrites, false);
  assert.equal(ev.checkoutUrl, CHECKOUT_URL);
  assert.ok(ev.message.includes(CHECKOUT_URL));
  assert.ok(ev.message.includes(String(PRICE_PER_SEAT_YEAR_USD)));
});

test("commercial-unlicensed message includes checkout URL", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-lic2-"));
  writeState(dir, { usageType: "commercial" });
  const ev = evaluate(dir);
  assert.equal(ev.status, "commercial-unlicensed");
  assert.ok(ev.message.includes(CHECKOUT_URL));
});

// FBMCPF-324: single source of truth for price. Prior repricing (FBMCPF-295)
// left stale "$119/seat/yr" copy in the board artifact and comparison docs, and
// a wrong "featureboard.dev/buy" domain — a mismatch a buyer sees at the exact
// moment they'd convert. This drift guard scans SHIPPED copy for the old price
// and domain so they can never silently return. Changelogs are excluded: they
// legitimately record that 0.6 shipped at $119 and 0.7 repriced away from it.
test("FBMCPF-324: no stale $119 price or featureboard.dev domain in shipped copy", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const SCAN_DIRS = ["server", "artifact", "docs"];
  const SCAN_FILES = ["README.md", "COMMERCIAL-LICENSE.md", "PRIVACY.md", "manifest.json"];
  const SKIP_DIRS = new Set(["node_modules", ".git", "test", "checks"]);
  const isText = (f) => /\.(js|mjs|cjs|md|html|json)$/i.test(f);
  const isHistorical = (f) => /CHANGELOG/i.test(f); // changelogs record past prices on purpose

  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name));
      } else if (isText(e.name) && !isHistorical(e.name)) {
        files.push(path.join(dir, e.name));
      }
    }
  };
  for (const d of SCAN_DIRS) { const p = path.join(root, d); if (fs.existsSync(p)) walk(p); }
  for (const f of SCAN_FILES) { const p = path.join(root, f); if (fs.existsSync(p) && !isHistorical(f)) files.push(p); }

  const STALE_PRICE = /\$?119\s*\/?\s*(?:seat|yr|year)/i; // "$119/seat/yr", "119/year", etc.
  const WRONG_DOMAIN = /featureboard\.dev/i;
  const offenders = [];
  for (const f of files) {
    const text = fs.readFileSync(f, "utf8");
    const rel = path.relative(root, f);
    text.split(/\r?\n/).forEach((line, i) => {
      if (STALE_PRICE.test(line)) offenders.push(`${rel}:${i + 1} stale price: ${line.trim().slice(0, 120)}`);
      if (WRONG_DOMAIN.test(line)) offenders.push(`${rel}:${i + 1} wrong domain: ${line.trim().slice(0, 120)}`);
    });
  }
  assert.equal(offenders.length, 0, `stale pricing/domain copy found:\n${offenders.join("\n")}`);
});
