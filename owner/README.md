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

## Self-serve: Polar checkout → auto-issued key (FBMCPF-210)

The manual CRM pipeline above stays for POs/enterprise. The self-serve path is:

**Customer** buys at https://featureboard.dev/buy (redirect to the Polar checkout,
US$119/seat/year, quantity = seats) → **Polar** fires an `order.paid` webhook →
**`polar-webhook-issuer.mjs`** verifies it, issues a signed 1-year key, logs it to
`owner/issued-keys.json` (gitignored — holds customer emails + keys), and emails the
key via Resend (or prints it for manual delivery).

### One-time Polar setup

1. Create a Polar organization and a product: "FeatureBoard Commercial License",
   $119/year, per-unit pricing with quantity = seats. Polar is the merchant of
   record — they handle global VAT/sales tax.
2. Point featureboard.dev/buy at the product's checkout link.
3. Add a webhook (Settings → Webhooks): event `order.paid`, URL = wherever the
   issuer listens (see below). Copy the `whsec_…` secret.
4. Optional: a Resend API key for auto-delivery from licensing@featureboard.dev.

### Running the issuer

```
POLAR_WEBHOOK_SECRET=whsec_...            # required
POLAR_PRODUCT_IDS=prod_...                # optional allowlist
RESEND_API_KEY=re_...                     # optional auto-email
node owner/polar-webhook-issuer.mjs       # listens on :8790
```

Expose it with a Cloudflare Tunnel (`cloudflared tunnel --url http://localhost:8790`)
or run the same `handleWebhook` logic in a Cloudflare Worker (paste the private key
as a Worker secret — never commit it). No dependencies; signature verification is
the standard-webhooks HMAC scheme implemented with node:crypto.

If the email step fails or is unconfigured, the key is printed to the console and
kept in `issued-keys.json` — deliver it manually and you've lost nothing.

### Renewals

Keys expire 1 year after purchase (+1 grace day). Polar subscriptions renew →
each renewal `order.paid` re-fires the webhook → a fresh key is issued and emailed
automatically. Lapsed customers keep read access; writes freeze until they renew.
