// FBMCPF-276 — refunds currently can't kill a key. This covers the local,
// optional revocations file added to server/license.js:
//   1. isRevoked() matcher semantics in isolation (orderId match, licensee
//      match, combined match, no-match, and a malformed/empty matcher that
//      must never act as a blanket "revoke everything").
//   2. evaluate() flips an already-activated, validly-signed key to
//      "commercial-revoked" (allowWrites:false) once a matching revocation
//      is added -- built with a REAL signed key the same way
//      test/activate_autofetch.test.js does (via owner/issue.mjs +
//      owner/keys/private.pem), skipped where that owner-only secret isn't
//      present.
//   3. activate() itself refuses to activate a key that's already revoked.
//   4. fetchKeyByOrder refuses when the claim API response carries
//      revoked:true (injected fetchImpl, no real network).
//   5. A missing or malformed revocations.json is a silent no-op -- never
//      throws, never revokes anything.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as license from "../server/license.js";
import { issueKey } from "../owner/issue.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// See test/activate_autofetch.test.js for why this is guarded: the private
// key is owner-only and gitignored, present only on the maintainer's machine.
const PRIVATE_KEY_PATH = path.join(root, "owner", "keys", "private.pem");
const hasPrivateKey = fs.existsSync(PRIVATE_KEY_PATH);

function tmpDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fb-revocation-"));
}

function revocationsFilePath(dataDir) {
  return path.join(dataDir, ".featureboard", "revocations.json");
}

// ---------------------------------------------------------------------------
// (1) isRevoked() matcher semantics, in isolation -- no signed keys needed.
// ---------------------------------------------------------------------------

test("isRevoked: matches on orderId alone", () => {
  const list = [{ orderId: "ord_1" }];
  assert.equal(license.isRevoked({ orderId: "ord_1", licensee: "Acme" }, list), true);
  assert.equal(license.isRevoked({ orderId: "ord_2", licensee: "Acme" }, list), false);
});

test("isRevoked: matches on licensee alone", () => {
  const list = [{ licensee: "Acme Corp" }];
  assert.equal(license.isRevoked({ licensee: "Acme Corp", issued: "2026-01-01" }, list), true);
  assert.equal(license.isRevoked({ licensee: "Other Co", issued: "2026-01-01" }, list), false);
});

test("isRevoked: matches on issued alone", () => {
  const list = [{ issued: "2026-01-01" }];
  assert.equal(license.isRevoked({ licensee: "Acme Corp", issued: "2026-01-01" }, list), true);
  assert.equal(license.isRevoked({ licensee: "Acme Corp", issued: "2026-06-01" }, list), false);
});

test("isRevoked: combined matcher requires ALL specified fields to match", () => {
  const list = [{ orderId: "ord_1", licensee: "Acme Corp" }];
  // both match
  assert.equal(license.isRevoked({ orderId: "ord_1", licensee: "Acme Corp" }, list), true);
  // licensee matches but orderId doesn't -> no match
  assert.equal(license.isRevoked({ orderId: "ord_9", licensee: "Acme Corp" }, list), false);
  // orderId matches but licensee doesn't -> no match
  assert.equal(license.isRevoked({ orderId: "ord_1", licensee: "Other Co" }, list), false);
  // payload missing the orderId field entirely -> no match (can't satisfy a specified field)
  assert.equal(license.isRevoked({ licensee: "Acme Corp" }, list), false);
});

test("isRevoked: no-match when the list is empty, absent, or has no overlapping matcher", () => {
  assert.equal(license.isRevoked({ licensee: "Acme Corp" }, []), false);
  assert.equal(license.isRevoked({ licensee: "Acme Corp" }, undefined), false);
  assert.equal(license.isRevoked({ licensee: "Acme Corp" }, [{ licensee: "Someone Else" }]), false);
});

test("isRevoked: a matcher with no specified fields is malformed and never a blanket match", () => {
  const list = [{ revokedAt: "2026-07-20T00:00:00.000Z" }, {}];
  assert.equal(license.isRevoked({ licensee: "Acme Corp", orderId: "ord_1", issued: "2026-01-01" }, list), false);
});

// ---------------------------------------------------------------------------
// (2) & (3): evaluate()/activate() wired to the local revocations file, using
// a REAL signed key (owner/issue.mjs + owner/keys/private.pem), skipped where
// that owner-only secret isn't present.
// ---------------------------------------------------------------------------

test(
  "evaluate(): a validly-signed, already-activated key flips to commercial-revoked once a matching revocation exists",
  { skip: hasPrivateKey ? false : "owner/keys/private.pem not present in this environment; skipping real-signature round-trip" },
  () => {
    const dataDir = tmpDataDir();
    const privatePem = fs.readFileSync(PRIVATE_KEY_PATH, "utf8");
    const { key, payload } = issueKey({ licensee: "Acme Corp", seats: 5, expires: "2030-01-01" }, privatePem);

    // Activate while unrevoked -- must succeed and read back as fully licensed.
    license.activate(dataDir, key);
    let ev = license.evaluate(dataDir);
    assert.equal(ev.status, "commercial-licensed");
    assert.equal(ev.allowWrites, true);

    // Now revoke it (retroactively, as a refund would) and re-evaluate.
    license.writeRevocations(dataDir, [{ licensee: "Acme Corp", issued: payload.issued }]);
    ev = license.evaluate(dataDir);
    assert.equal(ev.status, "commercial-revoked");
    assert.equal(ev.allowWrites, false);
    assert.match(ev.message, /revoked/i);
    assert.match(ev.message, /licensing@featureboard\.ai/);
  }
);

test(
  "activate(): refuses to activate a key that's already revoked, with a clear message; nothing is stored",
  { skip: hasPrivateKey ? false : "owner/keys/private.pem not present in this environment; skipping real-signature round-trip" },
  () => {
    const dataDir = tmpDataDir();
    const privatePem = fs.readFileSync(PRIVATE_KEY_PATH, "utf8");
    const { key, payload } = issueKey({ licensee: "Refunded Co", seats: 1, expires: "2030-01-01" }, privatePem);

    license.writeRevocations(dataDir, [{ licensee: "Refunded Co", issued: payload.issued }]);

    assert.throws(() => license.activate(dataDir, key), (err) => {
      assert.match(err.message, /revoked/i);
      assert.match(err.message, /licensing@featureboard\.ai/);
      return true;
    });
    assert.equal(license.readState(dataDir), null, "a refused activation must not write any state");
  }
);

test(
  "evaluate(): an unrelated revocation entry does not affect a still-valid, non-matching license",
  { skip: hasPrivateKey ? false : "owner/keys/private.pem not present in this environment; skipping real-signature round-trip" },
  () => {
    const dataDir = tmpDataDir();
    const privatePem = fs.readFileSync(PRIVATE_KEY_PATH, "utf8");
    const { key } = issueKey({ licensee: "Good Customer", seats: 1, expires: "2030-01-01" }, privatePem);

    license.activate(dataDir, key);
    license.writeRevocations(dataDir, [{ licensee: "Somebody Else" }, { orderId: "ord_unrelated" }]);

    const ev = license.evaluate(dataDir);
    assert.equal(ev.status, "commercial-licensed");
    assert.equal(ev.allowWrites, true);
  }
);

// ---------------------------------------------------------------------------
// (4) fetchKeyByOrder refuses on a claim API response carrying revoked:true.
// ---------------------------------------------------------------------------

test("fetchKeyByOrder: claim API response with revoked:true is refused with a clear message", async () => {
  const impl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ revoked: true, key: "should.not-be-used", licensee: "Refunded Co" }),
  });
  await assert.rejects(
    () => license.fetchKeyByOrder({ email: "buyer@acme.test", orderId: "ord_refunded", fetchImpl: impl }),
    (err) => {
      assert.match(err.message, /revoked/i);
      assert.match(err.message, /licensing@featureboard\.ai/);
      return true;
    }
  );
});

test("fetchKeyByOrder: revoked:false (or absent) is unaffected -- normal success path still returns the key", async () => {
  const impl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ revoked: false, key: "abc.def", licensee: "Good Customer" }),
  });
  const out = await license.fetchKeyByOrder({ email: "buyer@acme.test", orderId: "ord_ok", fetchImpl: impl });
  assert.equal(out.key, "abc.def");
});

// ---------------------------------------------------------------------------
// (5) Missing / malformed revocations.json is a silent no-op.
// ---------------------------------------------------------------------------

test("readRevocations: missing file returns an empty list (no throw)", () => {
  const dataDir = tmpDataDir();
  assert.deepEqual(license.readRevocations(dataDir), []);
});

test("readRevocations: malformed JSON returns an empty list (no throw)", () => {
  const dataDir = tmpDataDir();
  fs.mkdirSync(path.dirname(revocationsFilePath(dataDir)), { recursive: true });
  fs.writeFileSync(revocationsFilePath(dataDir), "{not valid json,,,", "utf8");
  assert.deepEqual(license.readRevocations(dataDir), []);
});

test("readRevocations: valid JSON that isn't an array returns an empty list (no throw)", () => {
  const dataDir = tmpDataDir();
  fs.mkdirSync(path.dirname(revocationsFilePath(dataDir)), { recursive: true });
  fs.writeFileSync(revocationsFilePath(dataDir), JSON.stringify({ oops: "not an array" }), "utf8");
  assert.deepEqual(license.readRevocations(dataDir), []);
});

test(
  "evaluate(): a malformed revocations.json does not block an otherwise-valid license",
  { skip: hasPrivateKey ? false : "owner/keys/private.pem not present in this environment; skipping real-signature round-trip" },
  () => {
    const dataDir = tmpDataDir();
    const privatePem = fs.readFileSync(PRIVATE_KEY_PATH, "utf8");
    const { key } = issueKey({ licensee: "Acme Corp", seats: 5, expires: "2030-01-01" }, privatePem);
    license.activate(dataDir, key);

    fs.writeFileSync(revocationsFilePath(dataDir), "not json at all {{{", "utf8");

    const ev = license.evaluate(dataDir);
    assert.equal(ev.status, "commercial-licensed");
    assert.equal(ev.allowWrites, true);
  }
);
