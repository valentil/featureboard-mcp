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
