# FeatureBoard — Privacy Policy (template)

_Template generated 2026-07-13. Review with counsel before publishing — not legal advice._

## What data is processed
FeatureBoard operates entirely on your local machine. It reads and writes the markdown
board files in the folder you configure (`FEATUREBOARD_DATA_DIR`): `featurelist.md`,
`buglist.md`, `scratchpad.md`, `agent_work_log.md`, `test_runs.md`, and a
`.featureboard` index cache.

## What is NOT collected
- No analytics or telemetry.
- No outbound network requests, other than the deliberate, opt-in exceptions below.
- No third-party data sharing.

## Exceptions

This is the complete egress inventory: every tool that carries the MCP
`openWorldHint:true` annotation, what leaves the machine, where it goes, and when.
Anything not listed here — the other 180+ tools — is local-only: it only reads/writes
files under `FEATUREBOARD_DATA_DIR` (or, for git-integration tools, the project's own
code repo on disk) and makes no network call.

- `notify_slack` posts a message to a project's Slack incoming webhook. Only fires when
  you've set `slackWebhook` via `set_project_config` (a `https://hooks.slack.com/...`
  URL you paste in — validated to that host) and the event is in the project's
  `slackEvents` allow-list. No webhook configured, or event not allow-listed → no
  network call (`sent:false`).
- `deploy_site` and `commit_feature` commit (and, if configured, push) the project's
  code/site repo to its configured git remote (default `origin`), using the machine's
  own ambient git credentials — no credentials are stored or transmitted by FeatureBoard
  itself. Only runs when git integration is enabled for the project via
  `set_git_config` (`enabled:true`); pushing additionally requires `push:true` in that
  same config (or an explicit per-call override). Disabled by default; no-ops with a
  reason when git integration is off.
- `get_site_traffic` is a read proxy: it fetches traffic stats from the site's
  configured external analytics provider (Plausible at `plausible.io`, a self-hosted
  umami instance at the host you configured, or a custom endpoint) via
  `set_analytics_config` / `auto_configure_analytics`, and only when the
  `FEATUREBOARD_ANALYTICS_KEY` environment variable is set. Unconfigured, disabled, or
  missing a key → no network call; it returns the request URL for you to fetch yourself
  instead.
- `create_worktree` and `cleanup_worktree` carry `openWorldHint:true` because they touch
  the filesystem outside the project's normal working tree (a sibling
  `<codeLocation>-worktrees/` directory by default), but they make no network call —
  every step is a local `git worktree` subcommand (add/remove/prune) run via the
  machine's own git binary.
- `request_commercial_license` records the name/email/company you supply to a local
  file so Lewis Valentine can follow up about a commercial agreement. It does not transmit
  data automatically; it returns a mailto/URL for you to contact the licensor.
- `register_email`: the tier-picker onboarding screen has an optional email field. It is
  stored locally (`.featureboard/registration.json`) only when you explicitly click
  "Save email" — that click is the only consent signal used, and there is no usage
  telemetry attached to it. On that same explicit submit, the email is POSTed once to
  the featureboard.ai registrations listener (`https://featureboard.ai/api/registrations`,
  overridable via `FEATUREBOARD_REGISTRATION_URL` for self-hosted deployments).
  Skipping the field means nothing is stored or sent. This is the only telemetry-adjacent
  exception; license keys (`activate_license`) are verified offline against an embedded
  public key with no phone-home (see `server/license.js`).

## Your control
All data is local files you own. Delete the boards folder to remove everything.

## Contact
Lewis Valentine — see LICENSE.md / COMMERCIAL-LICENSE.md.
