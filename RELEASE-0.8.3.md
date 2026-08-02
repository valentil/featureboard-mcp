# Cutting v0.8.3 — run sheet

Everything is committed and pushed (`ad95e2b`). Working tree is clean, suite is
1192 pass / 0 fail. Run these from `C:\clawds\main_bot_dev\clawd-workspace\featureboard-mcp`
in **PowerShell on your machine** — `gh`, `npx` and the mcpb packer aren't
available in Claude's sandbox, which is the only reason this isn't already done.

## 0. Preconditions (once)

```powershell
gh auth status          # must be logged in to github.com as valentil
git status --porcelain  # must print nothing
git log --oneline -2    # expect ad95e2b, a18a5e3
```

## 1. The whole release, one command

`scripts/release.mjs` does the entire thing: test gate → README number refresh →
version bump in `package.json` + `manifest.json` + `artifact/board.html` → docs
regen → `.mcpb` pack (with the 20MB bloat guard) → plugin/zip/latest.json build
→ commit → tag → push → `gh release create`.

```powershell
npm run release -- --patch --themes "quiet swarm dispatch (packets no longer dumped into chat), analytics routing/lead-time/aging panels + CSV export, routing_scorecard response cap"
```

Dry-run first if you want to see the plan without touching anything:

```powershell
npm run release -- --dry-run --patch --themes "quiet swarm dispatch (packets no longer dumped into chat), analytics routing/lead-time/aging panels + CSV export, routing_scorecard response cap"
```

Verified dry-run output:

```
Version: 0.8.2 -> 0.8.3 (tag v0.8.3)
README.md numeric claims would change: true
manifest.json/package.json version would become: 0.8.3
artifact/board.html BOARD_VERSION: 0.6.2 -> 0.8.3
Commit message: release: v0.8.3 — quiet swarm dispatch (...)
Tag: v0.8.3
```

## 2. If you'd rather drive it by hand

The script exists so you don't have to, but this is what it runs:

```powershell
# version bump
npm version 0.8.3 --no-git-tag-version
node -e "const f='manifest.json',j=JSON.parse(require('fs').readFileSync(f));j.version='0.8.3';require('fs').writeFileSync(f,JSON.stringify(j,null,2)+'\n')"
node -e "const f='artifact/board.html',s=require('fs').readFileSync(f,'utf8');require('fs').writeFileSync(f,s.replace(/(const\s+BOARD_VERSION\s*=\s*)\"[\d.]+\"/,'$1\"0.8.3\"'))"

# regen + pack
npm test
npm run docs
npm run build
npx --yes @anthropic-ai/mcpb@2 pack . "featureboard-0.8.3.mcpb"
npm run plugin

# commit, tag, push (tag must be on the remote before gh will accept it)
git add -A
git commit -m "release: v0.8.3 — quiet swarm dispatch, analytics panels, routing_scorecard cap"
git tag v0.8.3
git push origin HEAD
git push origin v0.8.3

# publish
gh release create v0.8.3 `
  featureboard-0.8.3.mcpb `
  releases/featureboard.plugin `
  releases/featureboard-mcp.zip `
  releases/latest.json `
  --title "FeatureBoard 0.8.3" `
  --notes-file RELEASE-NOTES-0.8.3.md
```

`--notes-file` is worth preferring over the script's one-line `--notes` here —
this release has more to say than the usual "N commits, T tools" line. Notes
are drafted in `RELEASE-NOTES-0.8.3.md`; the fuller version is `CHANGELOG-0.8.md`.

## 3. After publishing

```powershell
# confirm the assets landed
gh release view v0.8.3

# the durable URLs the site and installers point at
curl.exe -sIL https://github.com/valentil/featureboard-mcp/releases/latest/download/featureboard.plugin | Select-String "^HTTP"
curl.exe -s  https://github.com/valentil/featureboard-mcp/releases/latest/download/latest.json
```

`server.json` still pins the MCP registry entry at **0.7.0** with a v0.7 asset
URL and sha256 — it hasn't been touched since. If you want the registry pointing
at 0.8.3, update `version`, `packages[0].identifier` (…/download/v0.8.3/featureboard.plugin)
and `fileSha256`:

```powershell
(Get-FileHash releases/featureboard.plugin -Algorithm SHA256).Hash.ToLower()
```

## 4. Restart to pick up the fixes

The running FeatureBoard MCP server still has the 0.8.2 build in memory — the
packet-dump fix and the `routing_scorecard` cap only take effect after Claude
Desktop restarts.
