import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerEmail, readRegistration, REGISTRATION_URL } from "../server/registration.js";

function tmpDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fb-reg-"));
}

// A fetch stub factory: records the call and returns a chosen response (or throws).
function stubFetch({ ok = true, status = 200, throwErr = null } = {}) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, opts });
    if (throwErr) throw throwErr;
    return { ok, status };
  };
  impl.calls = calls;
  return impl;
}

test("REGISTRATION_URL defaults to the featureboard.ai registrations listener", () => {
  assert.equal(REGISTRATION_URL, "https://featureboard.ai/api/registrations");
});

test("registerEmail no-ops without a network call when email is empty/omitted (no consent)", async () => {
  const dir = tmpDataDir();
  const impl = stubFetch();
  const r1 = await registerEmail(dir, undefined, { fetchImpl: impl });
  assert.equal(r1.stored, false);
  assert.equal(r1.posted, false);
  assert.match(r1.reason, /no email provided/i);

  const r2 = await registerEmail(dir, "   ", { fetchImpl: impl });
  assert.equal(r2.stored, false);
  assert.equal(impl.calls.length, 0);
  assert.equal(readRegistration(dir), null, "nothing should be written locally");
});

test("registerEmail no-ops on a malformed email (no store, no network call)", async () => {
  const dir = tmpDataDir();
  const impl = stubFetch();
  const r = await registerEmail(dir, "not-an-email", { fetchImpl: impl });
  assert.equal(r.stored, false);
  assert.equal(r.posted, false);
  assert.match(r.reason, /valid email/i);
  assert.equal(impl.calls.length, 0);
  assert.equal(readRegistration(dir), null);
});

test("registerEmail stores locally and POSTs once to the registration listener on explicit submit", async () => {
  const dir = tmpDataDir();
  const impl = stubFetch();
  const r = await registerEmail(dir, "user@example.com", { fetchImpl: impl });
  assert.equal(r.stored, true);
  assert.equal(r.posted, true);
  assert.equal(impl.calls.length, 1);
  const call = impl.calls[0];
  assert.equal(call.url, REGISTRATION_URL);
  assert.equal(call.opts.method, "POST");
  const body = JSON.parse(call.opts.body);
  assert.equal(body.email, "user@example.com");
  assert.ok(body.registeredAt);
  assert.ok(call.opts.signal, "an AbortController signal is passed");

  const stored = readRegistration(dir);
  assert.equal(stored.email, "user@example.com");
  assert.equal(stored.posted, true);
  assert.ok(stored.postedAt);
});

test("registerEmail does not re-POST once already posted (idempotent egress)", async () => {
  const dir = tmpDataDir();
  const impl = stubFetch();
  const first = await registerEmail(dir, "user@example.com", { fetchImpl: impl });
  assert.equal(first.posted, true);
  assert.equal(impl.calls.length, 1);

  const second = await registerEmail(dir, "user@example.com", { fetchImpl: impl });
  assert.equal(second.stored, true);
  assert.equal(second.posted, true);
  assert.equal(second.alreadyPosted, true);
  assert.equal(impl.calls.length, 1, "no additional network call on repeat submit");
});

test("registerEmail stores locally even when the POST fails, and never throws", async () => {
  const dir = tmpDataDir();
  const impl = stubFetch({ ok: false, status: 500 });
  const r = await registerEmail(dir, "user@example.com", { fetchImpl: impl });
  assert.equal(r.stored, true);
  assert.equal(r.posted, false);
  assert.match(r.warning, /500/);

  const stored = readRegistration(dir);
  assert.equal(stored.email, "user@example.com", "local write happens before/regardless of network result");
  assert.equal(stored.posted, false);
});

test("registerEmail returns a warning (never throws) when fetch rejects", async () => {
  const dir = tmpDataDir();
  const impl = stubFetch({ throwErr: new Error("ECONNREFUSED") });
  const r = await registerEmail(dir, "user@example.com", { fetchImpl: impl });
  assert.equal(r.stored, true);
  assert.equal(r.posted, false);
  assert.match(r.warning, /ECONNREFUSED/);
});

test("registerEmail retries the POST on a later call if the first attempt failed", async () => {
  const dir = tmpDataDir();
  const failImpl = stubFetch({ ok: false, status: 503 });
  const r1 = await registerEmail(dir, "user@example.com", { fetchImpl: failImpl });
  assert.equal(r1.posted, false);

  const okImpl = stubFetch({ ok: true, status: 200 });
  const r2 = await registerEmail(dir, "user@example.com", { fetchImpl: okImpl });
  assert.equal(r2.posted, true);
  assert.equal(okImpl.calls.length, 1);
});
