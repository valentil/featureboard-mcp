import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PRICE_PER_SEAT_YEAR_USD,
  CHECKOUT_URL,
  LICENSE_CONTACT_URL,
  verifyKey,
} from "../server/license.js";

// FBMCPF-208: published pricing surfaced from the license module.
test("published price is $119/seat/year", () => {
  assert.equal(PRICE_PER_SEAT_YEAR_USD, 119);
});

test("checkout URL defaults to the stable featureboard.dev/buy redirect", () => {
  assert.equal(CHECKOUT_URL, "https://featureboard.dev/buy");
  assert.ok(LICENSE_CONTACT_URL.startsWith("https://"));
});

test("verifyKey still rejects malformed keys (pricing change is additive)", () => {
  assert.equal(verifyKey("not-a-key").valid, false);
});
