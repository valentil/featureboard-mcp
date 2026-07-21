# Troubleshooting

## The Cowork sandbox won't start / `bash` fails / scheduled tasks silently stop

**This is the single most common way FeatureBoard appears "broken," and it isn't a
FeatureBoard bug** — it's a resource leak in the Claude Desktop **Cowork** sandbox
(the isolated Linux VM that runs shell commands). FeatureBoard runs *inside* Cowork,
so when the sandbox can't start, anything that shells out stops working: running
your test suite, the async **check-runner** that `commit_feature`/`start_checks`
kick off, and — worst of all — **scheduled steering tasks, which fail with no
error in chat**. You just notice the expected output never arrived.

### Symptoms

You'll see one of these:

- `bash failed on resume, create, and re-resume.`
- `RPC error: ensure user: useradd failed: exit status 12: useradd: cannot create directory /sessions/<name>`
- `useradd: /etc/passwd.NNNNN: No space left on device`
- `Workspace still starting` that never finishes, or `Workspace unavailable. The isolated Linux environment failed to start.`
- `start_checks` returns `started:true` but `get_check_results` never finds a result (the runner starts and dies).

### Why it happens

The Cowork sandbox has two small (~10 GB) ephemeral disks — `/` and `/sessions`.
Every conversation creates a new `/sessions/<name>/` directory and copies caches
into it (installed plugins/skills, Playwright/Chromium, the systemd journal, npm
cache), and **nothing garbage-collects them**. After enough sessions the disks hit
100%, and the next session can't even create its Linux user — that's the `useradd`
failure. The more plugins you have installed, the sooner you hit it (each session
copies them all). On macOS this shows up as a single fixed-size `sessiondata.img`
(~8.5 GB) filling up.

This is tracked upstream — see the links at the bottom. There's no in-sandbox fix
(the sandbox user is unprivileged and can't delete the accumulated files), so the
recovery is to **reset the sandbox's disk image from your computer**.

### Fix: reset the Cowork sandbox disk image

> Your work is safe. This only clears **sandbox** state. Your connected folders,
> git repos, and FeatureBoard boards live on your normal filesystem and are never
> touched by any of the steps below.

**Always start by fully quitting Claude Desktop** — including the system-tray /
menu-bar icon. The disk image is locked while the app runs.

**macOS**

1. Fully quit Claude Desktop.
2. Move the disk image out of the way:
   `~/Library/Application Support/Claude/vm_bundles/claudevm.bundle/sessiondata.img`
   → rename it to `sessiondata.img.bak` (or move it to your Desktop).
3. Relaunch Claude Desktop — it rebuilds a fresh, empty image.
4. Once Cowork's sandbox works again, delete the `.bak` to reclaim the space (~8.5 GB).

**Windows**

1. Fully quit Claude Desktop (check the system tray).
2. Open File Explorer and go to the Cowork VM folder inside the packaged app cache:
   `%LOCALAPPDATA%\Packages\Claude_<id>\LocalCache\Roaming\Claude\vm_bundles\`
   The `Claude_<id>` package name has a random suffix — if you can't find it, paste
   `%LOCALAPPDATA%\Packages\` into the address bar and look for the `Claude_*` folder,
   then follow `LocalCache\Roaming\Claude\vm_bundles\`. Some builds also mirror it at
   `%APPDATA%\Claude\vm_bundles`.
3. Rename or move `claudevm.bundle` (or just the `sessiondata.*` file inside it) to a
   `.bak`.
4. Relaunch Claude Desktop — it rebuilds a fresh image.
5. Once the sandbox works again, delete the `.bak`.

**If it still won't provision:** remove the whole `vm_bundles` directory, then
uninstall and reinstall Claude Desktop for a complete wipe.

### Reduce how often you hit it

- Reset the image periodically instead of waiting for the hard failure — a heavy
  daily scheduled task can fill the disks in weeks.
- Keep the number of installed Cowork plugins/skills modest; each session copies
  them all into its own `/sessions/<name>/` cache.
- If you rely on a scheduled steering task, add a disk pre-flight to its playbook
  (abort with a useful message when the sandbox is >95% full) so it fails loudly
  instead of silently.

### FeatureBoard-specific notes

- FeatureBoard's own board data (`featurelist.md`, `buglist.md`, work log) lives in
  your boards folder on disk, **not** in the sandbox — it survives a sandbox reset
  intact.
- If `commit_feature` reports the commit succeeded but you never get check results,
  it's this issue: the commit landed (git runs on the host), only the sandboxed
  check-runner couldn't start. Re-run `start_checks` after resetting the sandbox.
- A large `churn_reconcile` no longer needs the sandbox to page its output — it
  returns a compact, worst-drift-first page by default (`limit`/`offset`, or
  `full:true`), so the steering review pass keeps working even when a file spill
  would have been unreadable.

### References

- Anthropic — [Claude Cowork architecture overview](https://support.claude.com/en/articles/14479288-claude-cowork-architecture-overview)
- GitHub — [#59856: per-session disk leak fills ephemeral disks; `useradd: No space left on device`](https://github.com/anthropics/claude-code/issues/59856)
- GitHub — [#30751: plugin cache never cleaned up, `sessiondata.img` fills, new conversations fail](https://github.com/anthropics/claude-code/issues/30751)
- GitHub — [#44622: Cowork VM session disk fills within hours for scheduled-task users](https://github.com/anthropics/claude-code/issues/44622)
- GitHub — [#56145: Windows Cowork sessions — cloud workspace not provisioning](https://github.com/anthropics/claude-code/issues/56145)

If none of this resolves it, it's an app-level problem rather than a FeatureBoard
one — file it on the [Claude Code / Cowork issue tracker](https://github.com/anthropics/claude-code/issues)
with your `df -h /` / `df -h /sessions` output from inside a session that does boot.
