# v0.8.3 — post-release run sheet

v0.8.3 is tagged and published (`9a9a57c`, tag `v0.8.3`). What's left is one
upload and a site deploy. **Step 1 is required** — the site now points at
`featureboard.mcpb`, which the v0.8.3 release doesn't carry yet.

## 1 · Upload the stable-named bundle to v0.8.3 — do this first

The homepage download was 404ing because it linked
`releases/latest/download/featureboard-0.8.0.mcpb` — the durable
`latest/download/` prefix with a **versioned** filename, which stops existing
the moment the next release becomes latest. The fix is a stable asset name.
`scripts/release.mjs` publishes `featureboard.mcpb` from 0.8.4 onward
(FBMCPF-373); v0.8.3 needs it backfilled once:

```powershell
cd C:\clawds\main_bot_dev\clawd-workspace\featureboard-mcp
Copy-Item featureboard-0.8.3.mcpb releases\featureboard.mcpb -Force
gh release upload v0.8.3 releases\featureboard.mcpb --clobber
```

Verify — this must return `HTTP/2 302` then `200`, not `404`:

```powershell
curl.exe -sIL https://github.com/valentil/featureboard-mcp/releases/latest/download/featureboard.mcpb | Select-String "^HTTP"
```

## 2 · Push and deploy the site

Website repo is `valentil/FeatureBoardWebsite`, branch `master`. The changes are
committed locally as `67a2e42`; only the push and deploy are left.

```powershell
cd C:\clawds\main_bot_dev\clawd-workspace\projectpads\FeatureBoard\website
git push origin master

cd cloudflare
node build.js
npx wrangler pages deploy .
```

(If Pages is git-connected rather than direct-upload, the push alone deploys —
skip the `wrangler` line.)

## 3 · Verify the live site

```powershell
# the three asset URLs the site now uses — all should end 200
curl.exe -sIL https://github.com/valentil/featureboard-mcp/releases/latest/download/featureboard.mcpb     | Select-String "^HTTP"
curl.exe -sIL https://github.com/valentil/featureboard-mcp/releases/latest/download/featureboard-mcp.zip  | Select-String "^HTTP"
curl.exe -sIL https://github.com/valentil/featureboard-mcp/releases/latest/download/latest.json           | Select-String "^HTTP"

# and the hero CTA as served
curl.exe -s https://featureboard.ai/ | Select-String "featureboard.mcpb"
```

## 4 · Optional — MCP registry

`server.json` is still pinned at **0.7.0** with a v0.7 asset URL and sha256; it
hasn't been touched in three releases. `scripts/release-publish.mjs` syncs it
from `package.json` + the built plugin, creates the release if missing, publishes
to the registry, and verifies the latest tag matches:

```powershell
node scripts/release-publish.mjs --dry-run   # see what it would change
node scripts/release-publish.mjs             # do it
```

## What changed on the site

- Every release-asset link now uses a **stable** name behind `latest/download/`:
  `featureboard.mcpb`, `featureboard-mcp.zip`, `latest.json`. No versioned URLs
  remain, so a release no longer silently breaks the download.
- Cowork install path names the `.mcpb` bundle instead of `featureboard.plugin`
  across `get-started.html`, `install.html`, `faq.html`, `llms.txt` and
  `llms-full.txt`. The Cowork and Claude Desktop cards on get-started merged —
  same file, same two steps.
- Version labels 0.8.0 → 0.8.3, hero release note rewritten for 0.8.3, and the
  stale "expect 214 tools" claim in install.html corrected to 215.
- The install manifest keeps `claudePlugin` for back-compat and adds
  `claudeBundle`; `latest.json` gains an `mcpb` artifact, listed first.

## Still outstanding from the release itself

Restart Claude Desktop — the running FeatureBoard MCP server is still the 0.8.2
build, so the packet-dump fix and the `routing_scorecard` cap aren't live in this
session yet.
