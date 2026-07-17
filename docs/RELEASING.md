# Releasing

`scripts/release.mjs` (FBMCPF-160) is the one command for cutting a release:
preflight, refresh README's numeric claims, bump the version, regenerate docs,
pack the `.mcpb`, format release notes, and publish via `gh release create`.

```bash
node scripts/release.mjs --themes "release automation, README auto-refresh"
```

What it does, in order:

1. **Preflight.** Refuses if the git tree isn't clean, or if `npm test` fails
   (`--skip-tests` is an escape hatch; the README test-count claim is left
   untouched when tests are skipped, since there's no fresh count to use).
2. **Version bump.** Reads `package.json`'s version and bumps the **minor**
   by default (`0.5.0` → `0.6.0`); pass `--patch` for a patch release
   (`0.5.1` → `0.5.2`). Writes the new version into `package.json` and
   `manifest.json`, then re-runs `npm run docs` to regenerate `docs/TOOLS.md`
   and re-sync `manifest.json`'s `tools` array from `server/index.js`.
3. **README refresh.** Rewrites README.md's drifting numeric claims from
   sources of truth: tool count from `manifest.json`'s (freshly regenerated)
   `tools` array length, test count from the `npm test` run just completed,
   and the version embedded in the quickstart `.mcpb` filename.
4. **Pack.** Runs `npm run build && npm run bundle` — the same preflight +
   pack path already documented in README's "Build & develop" section —
   producing `featureboard-<version>.mcpb`.
5. **Release notes.** Formats the established one-line shape:
   `full release notes: N commits since vPREV, T1→T2 tools, S1→S2 tests, organized as <themes>.`
   `N` comes from `git rev-list vPREV..HEAD --count`; `vPREV` is the latest
   `v*` release tag; prior tool/test counts are read from that tag's
   `manifest.json` / `README.md` via `git show vPREV:<file>`. `--themes` is
   **required** and never invented by the script — pass a short summary of
   what actually shipped.
6. **Commit, tag, release.** Commits the bump (`release: vX.Y.Z — <themes>`),
   tags `vX.Y` (matching the repo's existing minor-only tag style, e.g. `v0.4`,
   `v0.5`), and runs:
   ```
   gh release create vX.Y featureboard-X.Y.Z.mcpb --title "FeatureBoard X.Y.Z" --notes "<generated notes>"
   ```

## Flags

| Flag | Effect |
| --- | --- |
| `--themes "..."` | Required for a real release (or to see the full `--dry-run` plan). One-line theme summary for the release notes. |
| `--dry-run` | Prints the full plan — version bump, whether README would change, and the exact `gh` command — without writing any file or touching git/gh. Still runs the real `npm test` preflight (read-only) unless combined with `--skip-tests`. |
| `--patch` | Bump the patch version instead of the minor. |
| `--skip-tests` | Skip the `npm test` gate. |
| `--allow-dirty` | **Testing only.** Skips the dirty-tree refusal so the happy path can be exercised without committing. Never use this for a real release. |

## Testing the pieces

The pure logic (arg parsing, version bump, tag naming, README anchor rewrites,
release-notes formatting, `gh` argv construction) is exported from
`scripts/release.mjs` and unit-tested in `test/release_script.test.js`:

```bash
node --test test/release_script.test.js
```
