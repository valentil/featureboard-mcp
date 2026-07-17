# Directory submission — answers of record (FBMCPF-115)

Rev 2 — 2026-07-16, sprint 2026-W29 wave. Supersedes the 2026-07-15 (v0.4.0) draft.
Form was submitted by Lewis 2026-07-16; this file captures the answers as they
should read against the current artifact. Technical preflight green as of
v0.5.0: `npm run check` ✓, 473/473 tests ✓, docs/manifest regenerated
(186 tools) ✓, `featureboard-0.5.0.mcpb` packed and verified (manifest parity ✓).

---

## Form answers (record)

**Extension name:** FeatureBoard

**One-line description:** A markdown-backed feature/bug board Claude manages as
your project agent — plan, work, and ship tickets without leaving the chat.

**Long description:** FeatureBoard turns Claude into a project agent with a
persistent, human-readable board. Tasks live in plain markdown (featurelist.md /
buglist.md) so the data is portable, diffable, and works without the extension.
Claude plans work onto the board, pulls tickets one at a time with focused work
packets, tracks velocity and per-model $ cost from a work log, and ships:
sprints with audience-specific close-out reports (marketing/sales/technical/
executive), churn mode (autonomous run-until-condition), per-ticket token caps
and model tiering with automatic assignment at intake, a piano-roll timeline of
ticket history, full audit trail per ticket (get_ticket_history), PR-style
review comments, parallel dispatch in isolated git worktrees, a project
knowledge base injected into work packets, multi-model test generation with a
catch-rate eval harness, testing center, CRM, media, website builder,
campaigns, analytics, and licensing — 186 tools, all local. The server
reads/writes the local boards folder, with a handful of deliberate, opt-in
exceptions detailed in the privacy summary below — including the onboarding
tier-picker's optional email field, which is stored locally and POSTed once to
the featureboard.ai registrations listener only if you explicitly click "Save
email" (skip it and nothing leaves your machine). No usage telemetry.

**Repository:** (public repo URL — as submitted by Lewis)

**Artifact:** featureboard-0.5.0.mcpb (3.4 MB packed, 2,159 files pre-ignore / 799 packed)

**Version:** 0.5.0

**Author / contact:** Lewis Valentine — lewis.valentine@gmail.com

**License:** PolyForm Noncommercial 1.0.0 (free for personal/public use) +
commercial license available (see COMMERCIAL-LICENSE.md)

**Privacy summary:** All data stays local (FEATUREBOARD_DATA_DIR). No usage
telemetry. openWorldHint=false on all tools except: notify_slack (posts only to
a user-configured Slack webhook), request_commercial_license (surfaces a mailto
URL only; request details written locally), register_email (optional onboarding
email — stored locally, POSTed once to the featureboard.ai registrations
listener only on explicit "Save email" submit), deploy_site / commit_feature
(git push to the user's own configured remote), get_site_traffic (fetch
from the user's own configured analytics endpoint), and create_worktree /
cleanup_worktree (flagged for filesystem access outside the repo's working
tree — local git subcommands only, no network call). Every network-touching
call is user-configured and user-initiated. See docs/compliance/PRIVACY.md for
the full disclosure (complete egress inventory, FBMCPB-14).

**Screenshots to attach:**
1. Board artifact, light theme — Todo/In Progress/Done with sprint chips
2. Board artifact, dark theme — churn banner active
3. 📊 Analytics dashboard (velocity + cost-by-model + burndown)
4. 🎹 Timeline panel — piano-roll ticket history with hover card

**Reviewer demo calls:** see docs/DIRECTORY_SUBMISSION.md §4.
