// FBMCPF-274 — activation-by-order: activate_license gains a second input
// mode, { email, orderId }, that has the server fetch the signed key from the
// featureboard.ai claim API (POST /api/claim) instead of requiring a pasted
// key. Whichever mode supplies the key, it goes through the EXACT same
// offline verifyKey/activate path — these tests cover:
//   1. server/license.js's fetchKeyByOrder in isolation, with an injected
//      fetchImpl (mirrors test/check_updates.test.js's stubFetch style and
//      test/registration.test.js — no real network access).
//   2. the real activate_license tool handler end-to-end, via the same
//      fake-server harness trick used by test/eta_hints.test.js and
//      test/board_tools_parity.test.js (index.js can't be imported directly:
//      main() connects a stdio transport as an import-time side effect).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import * as license from "../server/license.js";
import { registerLicensingTools } from "../server/register/licensing.js";
import { issueKey } from "../owner/issue.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// owner/keys/private.pem is owner-only and gitignored (never committed — see
// owner/README.md); it's only present on the maintainer's own machine. Where
// it exists, it's the private half of the exact keypair embedded as PUBLIC_KEY
// in server/license.js, so we can use it (via owner/issue.mjs, the same
// issuance helper generate-license.mjs/polar-webhook-issuer.mjs use) to build
// a REAL signed key fixture that verifies for real — a true end-to-end
// round-trip, not a re-implementation of verifyKey. If it's absent (e.g. a
// fresh checkout without the secret), the one test that needs it is skipped
// rather than failing the whole suite.
const PRIVATE_KEY_PATH = path.join(root, "owner", "keys", "private.pem");
const hasPrivateKey = fs.existsSync(PRIVATE_KEY_PATH);

function tmpDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fb-activate-autofetch-"));
}

// A fetch stub factory mirroring test/check_updates.test.js's stubFetch.
function stubFetch({ ok = true, status = 200, json = null, throwErr = null } = {}) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, opts });
    if (throwErr) throw throwErr;
    return { ok, status, json: async () => json };
  };
  impl.calls = calls;
  return impl;
}

// ---- fake-server harness (mirrors test/eta_hints.test.js) -----------------
function ok(obj) {
  return { content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] };
}
function fail(msg) {
  return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
}
function tryTool(fn) {
  return async (args) => {
    try {
      return ok(await fn(args));
    } catch (e) {
      return fail(e.message);
    }
  };
}
function makeFakeServer() {
  const tools = new Map();
  return {
    tools,
    registerTool(name, _meta, handler) {
      tools.set(name, handler);
    },
    registerPrompt() {},
  };
}
function buildTools(dataDir) {
  const ctx = {
    DATA_DIR: dataDir,
    checkUpdates: async () => ({ checked: false }),
    license,
    registerEmail: async () => ({ stored: false, posted: false }),
    tryTool,
    z,
  };
  const server = makeFakeServer();
  registerLicensingTools(server, ctx);
  return server.tools;
}
async function call(handler, args) {
  const res = await handler(args);
  const text = res.content[0].text;
  if (res.isError) throw new Error(text);
  return JSON.parse(text);
}
async function callExpectError(handler, args) {
  const res = await handler(args);
  assert.equal(res.isError, true, "expected the activate_license call to fail");
  return res.content[0].text;
}

/** Temporarily swap globalThis.fetch (the tool handler's default fetchImpl),
 *  restoring the original afterwards even on throw. */
async function withFetch(stub, fn) {
  const hadOwn = Object.prototype.hasOwnProperty.call(globalThis, "fetch");
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await fn();
  } finally {
    if (hadOwn) globalThis.fetch = original;
    else delete globalThis.fetch;
  }
}

// ---------------------------------------------------------------------------
// (1) server/license.js: fetchKeyByOrder in isolation (injected fetchImpl)
// ---------------------------------------------------------------------------

test("fetchKeyByOrder: success returns key + licensee/seats/expires and posts email+orderId to CLAIM_URL", async () => {
  const impl = stubFetch({ status: 200, json: { key: "abc.def", licensee: "Acme Corp", seats: 5, expires: "2027-07-19" } });
  const out = await license.fetchKeyByOrder({ email: "buyer@acme.test", orderId: "ord_123", fetchImpl: impl });
  assert.equal(out.key, "abc.def");
  assert.equal(out.licensee, "Acme Corp");
  assert.equal(out.seats, 5);
  assert.equal(out.expires, "2027-07-19");

  assert.equal(impl.calls.length, 1);
  assert.equal(impl.calls[0].url, license.CLAIM_URL);
  assert.equal(impl.calls[0].opts.method, "POST");
  assert.deepEqual(JSON.parse(impl.calls[0].opts.body), { email: "buyer@acme.test", orderId: "ord_123" });
});

test("fetchKeyByOrder: 404 maps to a clear no-key-found error", async () => {
  const impl = stubFetch({ ok: false, status: 404, json: {} });
  await assert.rejects(
    () => license.fetchKeyByOrder({ email: "buyer@acme.test", orderId: "ord_bad", fetchImpl: impl }),
    /no key found for that email\+order/
  );
});

test("fetchKeyByOrder: 429 maps to a clear rate-limit error", async () => {
  const impl = stubFetch({ ok: false, status: 429, json: {} });
  await assert.rejects(
    () => license.fetchKeyByOrder({ email: "buyer@acme.test", orderId: "ord_123", fetchImpl: impl }),
    /too many attempts, wait an hour/
  );
});

test("fetchKeyByOrder: network failure is actionable and names the manual claim URL", async () => {
  const impl = stubFetch({ throwErr: new Error("getaddrinfo ENOTFOUND featureboard.ai") });
  await assert.rejects(
    () => license.fetchKeyByOrder({ email: "buyer@acme.test", orderId: "ord_123", fetchImpl: impl }),
    (err) => {
      assert.match(err.message, /ENOTFOUND/);
      assert.match(err.message, /https:\/\/featureboard\.ai\/claim/, "must point at the manual claim URL as a fallback");
      return true;
    }
  );
});

test("fetchKeyByOrder: timeout (AbortError) fails with a timed-out reason naming the manual claim URL", async () => {
  // Simulates the real 10s AbortController timeout firing (an AbortError-named
  // rejection) without actually waiting out the timer — same trick as
  // test/check_updates.test.js's "timeout path fails soft" test.
  let sawSignal = false;
  const impl = async (url, opts) => {
    sawSignal = !!(opts && opts.signal);
    const err = new Error("This operation was aborted");
    err.name = "AbortError";
    throw err;
  };
  await assert.rejects(
    () => license.fetchKeyByOrder({ email: "buyer@acme.test", orderId: "ord_123", fetchImpl: impl }),
    (err) => {
      assert.match(err.message, /timed out after 10s/);
      assert.match(err.message, /https:\/\/featureboard\.ai\/claim/);
      return true;
    }
  );
  assert.equal(sawSignal, true, "expected an AbortController signal to be passed to fetchImpl");
});

test("fetchKeyByOrder: missing email or orderId throws before any network call", async () => {
  const impl = stubFetch({ json: { key: "x" } });
  await assert.rejects(() => license.fetchKeyByOrder({ email: "", orderId: "ord_1", fetchImpl: impl }), /email and orderId are both required/);
  await assert.rejects(() => license.fetchKeyByOrder({ email: "a@b.com", orderId: "", fetchImpl: impl }), /email and orderId are both required/);
  assert.equal(impl.calls.length, 0, "must not hit the network with an incomplete request");
});

// ---------------------------------------------------------------------------
// (2) the real activate_license tool: XOR validation (handler-level, no
// network reached in any of these — validation must fail before fetching)
// ---------------------------------------------------------------------------

test("activate_license: neither key nor email/orderId -> clear validation error, no network call", async () => {
  const dataDir = tmpDataDir();
  const tools = buildTools(dataDir);
  let fetchCalled = false;
  await withFetch(async () => { fetchCalled = true; return { ok: true, status: 200, json: async () => ({}) }; }, async () => {
    const msg = await callExpectError(tools.get("activate_license"), {});
    assert.match(msg, /Provide either a license key, or email \+ orderId/i);
  });
  assert.equal(fetchCalled, false);
  assert.equal(license.readState(dataDir), null, "must not write any state on validation failure");
});

test("activate_license: both key AND email/orderId given -> clear validation error (XOR violated)", async () => {
  const dataDir = tmpDataDir();
  const tools = buildTools(dataDir);
  const msg = await callExpectError(tools.get("activate_license"), {
    key: "some.key",
    email: "buyer@acme.test",
    orderId: "ord_123",
  });
  assert.match(msg, /not both/i);
  assert.equal(license.readState(dataDir), null);
});

test("activate_license: email without orderId -> clear validation error", async () => {
  const dataDir = tmpDataDir();
  const tools = buildTools(dataDir);
  const msg = await callExpectError(tools.get("activate_license"), { email: "buyer@acme.test" });
  assert.match(msg, /requires BOTH email and orderId/i);
  assert.equal(license.readState(dataDir), null);
});

test("activate_license: orderId without email -> clear validation error", async () => {
  const dataDir = tmpDataDir();
  const tools = buildTools(dataDir);
  const msg = await callExpectError(tools.get("activate_license"), { orderId: "ord_123" });
  assert.match(msg, /requires BOTH email and orderId/i);
  assert.equal(license.readState(dataDir), null);
});

// ---------------------------------------------------------------------------
// (3) the real activate_license tool: order-mode error propagation
// (fetchKeyByOrder's failure surfaces through the tool, and nothing is stored)
// ---------------------------------------------------------------------------

test("activate_license: order mode, claim API 404 -> tool call fails with the no-key-found message, nothing stored", async () => {
  const dataDir = tmpDataDir();
  const tools = buildTools(dataDir);
  await withFetch(
    async () => ({ ok: false, status: 404, json: async () => ({}) }),
    async () => {
      const msg = await callExpectError(tools.get("activate_license"), { email: "buyer@acme.test", orderId: "ord_bad" });
      assert.match(msg, /no key found for that email\+order/);
    }
  );
  assert.equal(license.readState(dataDir), null);
});

test("activate_license: order mode, claim API 429 -> tool call fails with the rate-limit message", async () => {
  const dataDir = tmpDataDir();
  const tools = buildTools(dataDir);
  await withFetch(
    async () => ({ ok: false, status: 429, json: async () => ({}) }),
    async () => {
      const msg = await callExpectError(tools.get("activate_license"), { email: "buyer@acme.test", orderId: "ord_123" });
      assert.match(msg, /too many attempts, wait an hour/);
    }
  );
  assert.equal(license.readState(dataDir), null);
});

test("activate_license: order mode, network failure -> tool call fails with an actionable message naming the claim URL", async () => {
  const dataDir = tmpDataDir();
  const tools = buildTools(dataDir);
  await withFetch(
    async () => { throw new Error("network is down"); },
    async () => {
      const msg = await callExpectError(tools.get("activate_license"), { email: "buyer@acme.test", orderId: "ord_123" });
      assert.match(msg, /network is down/);
      assert.match(msg, /https:\/\/featureboard\.ai\/claim/);
    }
  );
  assert.equal(license.readState(dataDir), null);
});

// ---------------------------------------------------------------------------
// (4) success path: a validly-signed key fetched via order mode round-trips
// into stored state through the SAME offline activate() path a pasted key
// uses. Needs the real owner private key to produce a signature that verifies
// against server/license.js's embedded PUBLIC_KEY -- skipped where that
// owner-only secret isn't present (see hasPrivateKey above).
// ---------------------------------------------------------------------------

test(
  "activate_license: order mode success -> fetched key verifies and activates exactly like a pasted key",
  { skip: hasPrivateKey ? false : "owner/keys/private.pem not present in this environment; skipping real-signature round-trip" },
  async () => {
    const dataDir = tmpDataDir();
    const tools = buildTools(dataDir);
    const privatePem = fs.readFileSync(PRIVATE_KEY_PATH, "utf8");
    const { key: fixtureKey, payload } = issueKey({ licensee: "Acme Corp", seats: 5, expires: "2030-01-01" }, privatePem);

    let postedBody = null;
    const out = await withFetch(
      async (url, opts) => {
        postedBody = JSON.parse(opts.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({ key: fixtureKey, licensee: payload.licensee, seats: payload.seats, expires: payload.expires }),
        };
      },
      () => call(tools.get("activate_license"), { email: "buyer@acme.test", orderId: "ord_123" })
    );

    assert.deepEqual(postedBody, { email: "buyer@acme.test", orderId: "ord_123" });
    assert.equal(out.activated, true);
    assert.equal(out.status, "commercial-licensed");
    assert.equal(out.allowWrites, true);
    assert.equal(out.license.licensee, "Acme Corp");
    assert.equal(out.license.seats, 5);
    assert.equal(out.license.expires, "2030-01-01");

    // Stored state matches the exact same shape activate() with a pasted key produces.
    const stored = license.readState(dataDir);
    assert.equal(stored.usageType, "commercial");
    assert.equal(stored.licenseKey, fixtureKey);
    assert.equal(stored.license.licensee, "Acme Corp");

    // Re-evaluating from disk (as if a fresh process read the stored state)
    // confirms it verifies for real, not just in the freshly-returned response.
    const ev = license.evaluate(dataDir);
    assert.equal(ev.status, "commercial-licensed");
    assert.equal(ev.allowWrites, true);
  }
);

test(
  "activate_license: pasted-key mode is unaffected by the new schema (regression)",
  { skip: hasPrivateKey ? false : "owner/keys/private.pem not present in this environment; skipping real-signature round-trip" },
  async () => {
    const dataDir = tmpDataDir();
    const tools = buildTools(dataDir);
    const privatePem = fs.readFileSync(PRIVATE_KEY_PATH, "utf8");
    const { key: fixtureKey } = issueKey({ licensee: "Direct Co", seats: 2, expires: "2030-01-01" }, privatePem);

    let fetchCalled = false;
    const out = await withFetch(
      async () => { fetchCalled = true; return { ok: true, status: 200, json: async () => ({}) }; },
      () => call(tools.get("activate_license"), { key: fixtureKey })
    );

    assert.equal(fetchCalled, false, "pasted-key mode must never touch the network");
    assert.equal(out.activated, true);
    assert.equal(out.license.licensee, "Direct Co");
  }
);
