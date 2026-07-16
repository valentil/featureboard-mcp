# Directory submission — ready-to-paste draft (FBMCPF-115)

Prepared 2026-07-15 during the churn run. All technical preflight is green as of
v0.4.0: version parity ✓, `npm run check` ✓, 196/196 tests ✓, docs/manifest
regenerated (152 tools) ✓, `featureboard-0.4.0.mcpb` packed and verified ✓.

**Remaining human steps:** capture screenshots and submit the interest form.

---

## Form answers (paste-ready)

**Extension name:** FeatureBoard

**One-line description:** A markdown-backed feature/bug board Claude manages as
your project agent — plan, work, and ship tickets without leaving the chat.

**Long description:** FeatureBoard turns Claude into a project agent with a
persistent, human-readable board. Tasks live in plain markdown (featurelist.md /
buglist.md) so the data is portable, diffable, and works without the extension.
Claude plans work onto the board, pulls tickets one at a time with focused work
packets, tracks velocity from a work log, and ships: sprints, churn mode
(autonomous run-until-condition), per-ticket token caps, testing center, CRM,
media, website builder, campaigns, analytics, and licensing — 152 tools, all
local. No network egress: the server only reads/writes the local boards folder.
No telemetry.

**Repository:** (fill in public repo URL)

**Artifact:** featureboard-0.4.0.mcpb (3.2 MB packed, 9.8 MB unpacked, 2,135 files)

**Version:** 0.4.0

**Author / contact:** Lewis Valentine — lewis.valentine@gmail.com

**License:** PolyForm Noncommercial 1.0.0 (free for personal/public use) +
commercial license available (see COMMERCIAL-LICENSE.md)

**Privacy summary:** All data stays local (FEATUREBOARD_DATA_DIR). No outbound
calls, no telemetry. openWorldHint=false on all tools except
request_commercial_license (surfaces a mailto URL only; request details are
written locally). See docs/compliance/PRIVACY.md.

**Screenshots to attach (capture before submitting):**
1. Board artifact, light theme — Todo/In Progress/Done with sprint chips
2. Board artifact, dark theme — churn banner active
3. 📊 Analytics dashboard (velocity + timeline charts)

**Reviewer demo calls:** see docs/DIRECTORY_SUBMISSION.md §4.
