import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PRICE_PER_SEAT_YEAR_USD,
  CHECKOUT_URL,
  LICENSE_CONTACT_URL,
  verifyKey,
  setUsageType,
  writeState,
  evaluate,
} from "../server/license.js";

// FBMCPF-208: published pricing surfaced from the license module.
test("published price is $119/seat/year", () => {
  assert.equal(PRICE_PER_SEAT_YEAR_USD, 119);
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
