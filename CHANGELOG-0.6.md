# FeatureBoard 0.6.x

## 0.6.1 (2026-07-19) — the revenue release

- **Self-serve commercial licensing:** published pricing (US$119/seat/year, 24h
  trial unchanged), checkout URL surfaced in `license_status`, every write-freeze
  message, the board's trial/frozen banners, and the onboarding tier picker.
- **Polar checkout -> auto-issued keys:** owner-side webhook issuer
  (standard-webhooks verification, Ed25519 key issuance, optional Resend
  delivery) + runbook. Canonical funnel domain: **featureboard.ai**.
- **PR loop:** `open_pull_request` turns a ticket branch into a PR (gh CLI or
  compare-URL fallback); PR URL is recorded on the ticket.
- **Triage intelligence:** new tickets inherit product/priority from similar
  past tickets (deterministic, explicit values always win) — on `add_feature`,
  `log_bug`, and `capture_ask`.
- **Done gates:** per-project `doneGates` config — require resolved review
  comments, a passing test run, a work-log entry, and/or a recorded PR before
  a ticket can close (`approve:true` overrides).
- **capture_ask:** paste a Slack message/email -> structured, triaged ticket.
- **export_metrics:** work-log and completions time series as CSV/JSON.
- **Sprint auto-assign:** `sprintAutoAssign` policy (off/priority/all) slots
  un-slotted tickets into the active sprint at intake.
- Housekeeping: `.gitattributes` line-ending normalization, packaging config
  filled, product taxonomy reconciled, stale bundles removed. 750 tests.

## 0.6.0 (2026-07-17)

See git history — correlation suite, automation rules, symbol-level code map,
priority-scaled SLA escalation, post_project_update, and the 0.6.0 tool set.
