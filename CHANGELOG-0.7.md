# FeatureBoard 0.7.0 — 2026-07-21

204 tools (was 198). Suite: 1022 tests, 1016 passing / 6 owner-key-gated skips.

## Revenue & licensing
- **Free-tier feature cap** (FBMCPF-294): "personal" tier meters top-level features across all boards — soft warn at 25, writes freeze at 30 (reads always work; decompose subtasks and bugs don't count; OSS/"public" and licensed users uncapped; env-overridable via `FEATUREBOARD_FREE_FEATURE_SOFT/HARD`).
- **Reprice** (FBMCPF-295): $9.99/seat/mo · $99.99/seat/yr across product, docs, and site (was $119/yr).
- **Interval-aware issuance** (FBMCPF-298): monthly Polar orders get ~38-day keys re-issued on each renewal; annual/one-time keep 1-year keys. `order.refunded` / `subscription.revoked` webhooks append local revocation matchers.
- **Revocation actually enforces** (FBMCPB-30): signed payloads now embed the Polar `orderId`; revocation records emit single-field matchers that really match. End-to-end test: paid → key → refunded → revoked.
- Activation-by-order (email + order id) in the board license modal (FBMCPF-277, FBMCPB-29).

## Research & retrieval
- **Local BM25 RAG** (FBMCPF-264): `rag_search` over kb docs (incl. research briefs), repo docs/ + README, and Done-ticket summaries — zero tokens, zero network.
- **Research-on-intake** (FBMCPF-263): `prepare_research` assembles per-ticket research request packets; briefs stored as kb `research-<ticket>` docs and auto-attached to work packets.

## Orchestration & visibility
- `record_dispatch` audit events — who's working each ticket, at what model, since when (FBMCPF-256); dispatch chips in the board UI (FBMCPF-257).
- `get_live_activity`: git/filesystem ground truth for running sub-agents (FBMCPF-254).
- Async check-runner: background static checks on commit, results as ticket events (FBMCPF-261).
- Plan-limit blend tracking + `plan_budget` blend mode (FBMCPF-278/279).

## Writing quality
- `voice_lint`: rule-based AI-tell scoring (33 rules) wired into outbound content surfaces (FBMCPF-266/267/268).
- ETA hints for long-running processing (FBMCPF-269).

## Fixes
- FBMCPB-29: voiceLint/voiceProfile/etaHints settable via set_project_config.
- FBMCPB-30..33 (churn review): revocation matching, stale $119 copy + red pricing test, premature 0.7.0 version claims, rag cache clearing.
