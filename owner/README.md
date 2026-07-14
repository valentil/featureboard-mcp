# FeatureBoard licensing — owner runbook

Everything here is **owner-only**. Never ship the `owner/` folder (especially
`owner/keys/private.pem`) to customers. `.gitignore` already excludes the key.

## One-time setup

A keypair is already provisioned (`owner/keys/private.pem`, public key embedded in
`server/license.js`). To rotate — which invalidates every key you've ever issued:

```
node owner/keygen.mjs --force
# paste the printed PUBLIC KEY block into server/license.js -> PUBLIC_KEY
```

## Issuing a license key (after a signed contract)

```
node owner/generate-license.mjs --licensee "Acme Corp" --seats 5 --expires 2027-07-13
# perpetual: omit --expires
```

Send the printed key to the customer; they run `activate_license` (or paste it into
the onboarding screen). Verification is offline — no server needed on your side.

## The pipeline (runs in your existing FeatureBoard CRM)

The commercial flow is a CRM funnel; you already have the machinery for it
(`switcher/public/FeatureBoard/crm.html`, `crm_inbox.json`, `leads.json`,
`standardContracts.js`, `crm_approvals.json`). The licensing states map onto it:

1. **Request** — a prospect on a `commercial-trial` (or `commercial`) install runs
   `request_commercial_license`. That records a lead in
   `<boards>/.featureboard/license_requests.json` and returns your licensing URL +
   email so they can reach you. Import these into the CRM inbox as new leads.
2. **Evaluation** — track the deal in the CRM (stage: evaluation). The customer keeps
   read access after the 24-hour trip-wire; writes are frozen until you issue a key.
3. **Contract** — use `standardContracts.js` / your contract templates to send terms.
   On signature, move the CRM record to "won / licensing".
4. **Issue** — run `generate-license.mjs`, deliver the key, mark the CRM record
   "licensed" with the key's licensee/seats/expiry stored on the customer.
5. **Customer** — renewals: reissue before `expires`; churn: let it lapse (the grace
   day covers timezone slippage). Seat changes: issue a new key with updated `seats`.

### Suggested CRM fields to add for licensing
`license_state` (lead → evaluation → contract → licensed → lapsed), `licensee_name`,
`seats`, `issued_date`, `expires_date`, `license_key` (store the issued key), and a
link back to the originating `license_requests.json` entry id (`LR-…`).

## Key format (for reference)

`base64url(JSON payload) + "." + base64url(ed25519 signature)`, where payload is
`{ licensee, type:"commercial", seats?, issued, expires|null, v:1 }`. The server
verifies the signature with the embedded public key and checks `expires` (+1 grace
day). Tampering with the payload breaks the signature.
