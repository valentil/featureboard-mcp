# FeatureBoard — Security Notes (template)

_Template generated 2026-07-13. Review with counsel before publishing — not legal advice._

## Trust boundary
The server runs locally under your user account and only accesses the configured
boards folder. Project names are validated to stay within that folder (no path
traversal). Writes are atomic (temp file + rename) to avoid corruption.

## Permissions
- Read-only tools carry `readOnlyHint: true`; destructive tools carry
  `destructiveHint: true`. See docs/TOOLS.md.
- Writes can be gated by the licensing state (`allowWrites`).

## Reporting a vulnerability
Contact Lewis Valentine privately (see LICENSE.md). Do not file security issues publicly.
