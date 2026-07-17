/**
 * FeatureBoard git integration (FBMCPF-65) — optional, opt-in.
 *
 * The original OpenClaw app committed/pushed by shelling out on the user's machine
 * (`git add . && git commit -m "..." && git push origin master`, cwd = repo). This
 * ports that as an *encouraged but not required* per-project capability: enable it,
 * point it at the project's code repo, and commit_feature runs git there when a
 * ticket is finished.
 *
 * Config lives in <project>/git.config.json:
 *   { enabled, remote, branch, push, messagePrefix }
 * No secrets are stored — pushing relies on the machine's ambient git credentials
 * (credential manager / SSH), exactly like OpenClaw did. Disabled by default, so it
 * never touches a repo unless the user turns it on.
 *
 * buildCommitPlan is pure (config + ticket → the exact git argv steps) and exported
 * for tests; commitFeature runs the plan via an injected exec (spawnSync by default).
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveGitTargets, logWork } from "./metadata.js";
import { PAD_FILES } from "./graduate.js";
import { appendEvent, recordedCommitsForTicket } from "./events.js";

// git's well-known empty-tree object — diffing a root commit against this
// (instead of a nonexistent HEAD^) is the standard way to get its stats.
const EMPTY_TREE_HASH = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export const GIT_CONFIG_FILE = "git.config.json";

// FBMCPF-163: account-wide git config lives at <boardsRoot>/.featureboard.global.json,
// sibling to the per-project folders (board.dataDir). A project's own gitMode (below)
// wins over this; this wins over the built-in default ("commit-only" — never push
// unless asked, matching the original pre-FBMCPF-163 behavior).
export const GLOBAL_CONFIG_FILE = ".featureboard.global.json";

/** The only three git push behaviors a project or the account can be set to. */
export const GIT_MODES = ["commit-only", "commit-push", "ask"];

export const DEFAULT_GLOBAL_CONFIG = {
  gitMode: "commit-only",
};

export const DEFAULT_GIT_CONFIG = {
  enabled: false,
  remote: "origin",
  branch: "main",
  push: false,
  messagePrefix: "",
  // FBMCPF-163: project-level override of the account-wide/default gitMode. null
  // means "not set here" — falls through to the global config, then the default.
  gitMode: null,
};

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}
function atomicWrite(filePath, data) {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}
function configPath(board, project) {
  return path.join(board.projectDir(project), GIT_CONFIG_FILE);
}

/** Path to the account-wide config, or null when the board has no resolvable root
 *  (e.g. lightweight test doubles that only implement projectDir()). */
function globalConfigPath(board) {
  const root = board && typeof board.dataDir === "string" && board.dataDir ? board.dataDir : null;
  return root ? path.join(root, GLOBAL_CONFIG_FILE) : null;
}

/** Raw parsed global config file, or null if missing/unreadable/malformed — the
 *  tolerant-parsing primitive other helpers build on. Never throws. */
function readGlobalConfigRaw(board) {
  const p = globalConfigPath(board);
  if (!p) return null;
  const raw = readJsonSafe(p);
  return raw && typeof raw === "object" ? raw : null;
}

/** Read a project's git config (merged over defaults). */
export function getGitConfig(board, project) {
  const raw = readJsonSafe(configPath(board, project));
  return { ...DEFAULT_GIT_CONFIG, ...(raw && typeof raw === "object" ? raw : {}) };
}

/** Update a project's git config (only provided fields change). Validates types. */
export function setGitConfig(board, project, patch = {}) {
  const cfg = getGitConfig(board, project);
  if (patch.enabled != null) cfg.enabled = !!patch.enabled;
  if (patch.push != null) cfg.push = !!patch.push;
  if (patch.remote != null) {
    if (!String(patch.remote).trim()) throw new Error("remote must be non-empty");
    cfg.remote = String(patch.remote).trim();
  }
  if (patch.branch != null) {
    if (!String(patch.branch).trim()) throw new Error("branch must be non-empty");
    cfg.branch = String(patch.branch).trim();
  }
  if (patch.messagePrefix != null) cfg.messagePrefix = String(patch.messagePrefix);
  if (patch.gitMode != null) {
    if (!GIT_MODES.includes(patch.gitMode)) {
      throw new Error(`gitMode must be one of: ${GIT_MODES.join(", ")}`);
    }
    cfg.gitMode = patch.gitMode;
  }
  atomicWrite(configPath(board, project), JSON.stringify(cfg, null, 2) + "\n");
  return cfg;
}

/** Read the account-wide git config (tolerant of a missing/corrupt file — always
 *  returns a valid object, defaulting gitMode to "commit-only"). */
export function getGlobalConfig(board) {
  const raw = readGlobalConfigRaw(board);
  const cfg = { ...DEFAULT_GLOBAL_CONFIG };
  if (raw && GIT_MODES.includes(raw.gitMode)) cfg.gitMode = raw.gitMode;
  return cfg;
}

/** Update the account-wide git config (currently just gitMode). Requires a board
 *  with a resolvable dataDir (a real Board, not a projectDir()-only test double). */
export function setGlobalConfig(board, patch = {}) {
  const p = globalConfigPath(board);
  if (!p) throw new Error("board has no resolvable dataDir — cannot locate the account-wide config file");
  const cfg = getGlobalConfig(board);
  if (patch.gitMode != null) {
    if (!GIT_MODES.includes(patch.gitMode)) {
      throw new Error(`gitMode must be one of: ${GIT_MODES.join(", ")}`);
    }
    cfg.gitMode = patch.gitMode;
  }
  atomicWrite(p, JSON.stringify(cfg, null, 2) + "\n");
  return cfg;
}

/**
 * FBMCPF-163: resolve the effective git push mode for a project. Precedence:
 *   1. the project's own gitMode (set_git_config) — explicit per-project override.
 *   2. legacy per-project push:true (pre-dates gitMode; kept so existing configs
 *      that only ever set `push` keep behaving exactly as before).
 *   3. the account-wide gitMode (set_global_config), if the file actually sets one.
 *   4. the built-in default: "commit-only" (never push unless asked — the original
 *      behavior before this ticket).
 * Returns { mode, source } where source is "project" | "global" | "default", so
 * get_git_config can report not just the resolved mode but where it came from.
 */
export function resolveGitMode(board, project, config) {
  if (config && GIT_MODES.includes(config.gitMode)) {
    return { mode: config.gitMode, source: "project" };
  }
  if (config && config.push === true) {
    return { mode: "commit-push", source: "project" };
  }
  const globalRaw = readGlobalConfigRaw(board);
  if (globalRaw && GIT_MODES.includes(globalRaw.gitMode)) {
    return { mode: globalRaw.gitMode, source: "global" };
  }
  return { mode: DEFAULT_GLOBAL_CONFIG.gitMode, source: "default" };
}

/** Compose the commit message for a ticket. */
export function commitMessage({ ticket, title, message, messagePrefix = "" } = {}) {
  if (message && String(message).trim()) return `${messagePrefix}${String(message).trim()}`;
  const head = [ticket, title].filter(Boolean).join(": ");
  if (!head) throw new Error("a ticket/title or an explicit message is required");
  return `${messagePrefix}${head}`;
}

/**
 * Build the ordered git steps (pure). paths default to "." (whole repo, like
 * OpenClaw). Push is included only when requested/config'd.
 */
export function buildCommitPlan(config, { ticket, title, message, paths, push } = {}) {
  const msg = commitMessage({ ticket, title, message, messagePrefix: config.messagePrefix });
  const addPaths = Array.isArray(paths) && paths.length ? paths : ["."];
  const doPush = push == null ? !!config.push : !!push;
  const steps = [
    { label: "add", args: ["add", "--", ...addPaths] },
    { label: "commit", args: ["commit", "-m", msg] },
  ];
  if (doPush) steps.push({ label: "push", args: ["push", config.remote, config.branch] });
  return { message: msg, push: doPush, steps };
}

/** Default exec: run git synchronously in cwd. Returns {status, stdout, stderr}. */
function defaultExec(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { status: r.status == null ? 1 : r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

/**
 * FBMCPF-188: after a successful commit, capture its hash plus line stats so
 * commit_feature can hand the ticket its own commit correlation instead of
 * relying on get_ticket_diff grepping git log after the fact. Guards the
 * root-commit case (no HEAD^) by diffing against git's empty-tree object
 * instead. Never throws — a git hiccup here must not undo/fail the commit
 * that already landed; callers should try/catch around this anyway as
 * defense-in-depth, but this itself always returns either a result or null.
 */
export function captureCommitInfo(exec, cwd) {
  try {
    const rev = exec(["rev-parse", "HEAD"], cwd);
    if (rev.status !== 0) return null;
    const hash = (rev.stdout || "").trim();
    if (!hash) return null;
    const shortHash = hash.slice(0, 8);

    const parentCheck = exec(["rev-parse", "--verify", "-q", "HEAD^"], cwd);
    const range = parentCheck.status === 0 ? "HEAD^..HEAD" : `${EMPTY_TREE_HASH}..HEAD`;

    let additions = 0;
    let deletions = 0;
    const numstat = exec(["diff", "--numstat", range], cwd);
    if (numstat.status === 0) {
      for (const line of (numstat.stdout || "").split(/\r?\n/)) {
        if (!line.trim()) continue;
        const [a, d] = line.split("\t");
        const an = parseInt(a, 10);
        const dn = parseInt(d, 10);
        if (!Number.isNaN(an)) additions += an;
        if (!Number.isNaN(dn)) deletions += dn;
      }
    }
    return { hash, shortHash, additions, deletions };
  } catch {
    return null;
  }
}

/**
 * FBMCPF-135: per-ticket diff capture. Find commits in the project's code repo
 * whose message mentions the ticket id and return, per commit, a summary
 * (hash/author/date/subject) plus a size-capped unified diff (`git show`).
 * Read-only — never writes or fetches. Handles gracefully (returns a `warning`,
 * never throws): no codeLocation configured, the path is not a git repo, git
 * log failing, and no matching commits (returns an empty list with a `message`).
 *
 * opts: { maxCommits=20, context=3, maxBytes=60000 } — `context` is git's
 * unified context-line count; `maxBytes` caps the TOTAL emitted diff across all
 * commits (each over-cap diff is truncated with a notice, later commits omitted).
 * exec(args, cwd) is injectable for tests (defaults to git via spawnSync).
 */
export function getTicketDiff(board, project, ticket, opts = {}, { exec = defaultExec } = {}) {
  if (!ticket || !String(ticket).trim()) throw new Error("ticket is required");
  const tk = String(ticket).trim();
  const maxCommits = Math.max(1, Math.min(Number(opts.maxCommits) || 20, 100));
  const context = Math.max(0, Math.min(opts.context != null ? Number(opts.context) : 3, 20));
  const maxBytes = Math.max(1000, Math.min(Number(opts.maxBytes) || 60000, 500000));

  const targets = resolveGitTargets(board, project);
  const repo = (targets.codeRepo && targets.codeRepo.path) || null;
  if (!repo) {
    return { ticket: tk, repo: null, count: 0, commits: [], warning: "no codeLocation configured for this project — set the project's codeLocation (or gitTargets.codeRepo) to the code git repo." };
  }
  if (!fs.existsSync(path.join(repo, ".git"))) {
    return { ticket: tk, repo, count: 0, commits: [], warning: `no git repository at ${repo} (no .git) — cannot capture diffs.` };
  }

  // FBMCPF-188: prefer commits recorded by commit_feature's enrichment (real
  // correlation — this ticket produced exactly these hashes) over grepping
  // commit messages, which can both miss commits whose message doesn't
  // literally contain the ticket id and pick up unrelated commits that
  // happen to mention it. Falls back to grep for legacy tickets that never
  // went through commit_feature's recording path (or whose recorded hashes
  // no longer resolve in this repo, e.g. after a history rewrite).
  let source = "grep";
  let rows = [];
  const recordedHashes = recordedCommitsForTicket(board, project, tk).slice(0, maxCommits);
  if (recordedHashes.length) {
    const recLog = exec(["log", "--no-walk", "--format=%H%x00%an%x00%aI%x00%s", ...recordedHashes], repo);
    if (recLog.status === 0) {
      const recRows = (recLog.stdout || "").split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);
      if (recRows.length) {
        source = "recorded";
        rows = recRows;
      }
    }
  }
  if (source === "grep") {
    const log = exec(["log", `--max-count=${maxCommits}`, "--fixed-strings", `--grep=${tk}`, "--format=%H%x00%an%x00%aI%x00%s"], repo);
    if (log.status !== 0) {
      return { ticket: tk, repo, count: 0, commits: [], warning: `git log failed: ${(log.stderr || "").trim() || "unknown error"}` };
    }
    rows = (log.stdout || "").split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);
  }
  if (!rows.length) {
    return { ticket: tk, repo, count: 0, commits: [], message: `no commits mention ${tk} in ${repo}.` };
  }

  let totalBytes = 0;
  let truncated = false;
  const commits = [];
  for (const row of rows) {
    const [hash, author, date, subject] = row.split("\u0000");
    let diff = "";
    let diffTruncated = false;
    if (truncated) {
      diff = "… [diff omitted — total diff byte cap reached; raise maxBytes to see it]";
      diffTruncated = true;
    } else {
      const show = exec(["show", `--unified=${context}`, "--format=", hash], repo);
      if (show.status === 0) {
        diff = show.stdout || "";
        const remaining = maxBytes - totalBytes;
        if (diff.length > remaining) {
          const kept = Math.max(0, remaining);
          const dropped = diff.length - kept;
          diff = diff.slice(0, kept) + `\n… [diff truncated — ${dropped} more bytes; raise maxBytes to see the rest]`;
          diffTruncated = true;
          truncated = true;
          totalBytes += kept;
        } else {
          totalBytes += diff.length;
        }
      } else {
        diff = `[git show failed: ${(show.stderr || "").trim() || "unknown error"}]`;
      }
    }
    commits.push({ hash, shortHash: (hash || "").slice(0, 8), author: author || null, date: date || null, subject: subject || null, diff, diffTruncated });
  }

  return { ticket: tk, repo, context, maxBytes, maxCommits, count: commits.length, truncated, commits, source };
}

/**
 * FBMCPF-151: for graduated projects, refresh a read-only snapshot mirror of the
 * board's pad files (+ config) into <codeRepo>/.featureboard/ so the code repo
 * carries the board's own context alongside the code. One-way: the boards dir (the
 * source of truth) is only ever read here, never written. Tolerant of missing pad
 * files and of the mirror itself failing — callers should surface `warning` without
 * treating it as fatal; this function never throws.
 */
export function mirrorGraduatedPad(board, project, targets) {
  if (!targets || targets.stage !== "graduated") {
    return { skipped: true, reason: "project stage is not graduated" };
  }
  const codePath = targets.codeRepo && targets.codeRepo.path;
  if (!codePath) {
    return { skipped: true, reason: "no code repo path configured" };
  }
  const mirrored = [];
  try {
    const padDir = board.projectDir(project);
    const mirrorDir = path.join(codePath, ".featureboard");
    for (const name of PAD_FILES) {
      const src = path.join(padDir, name);
      if (!fs.existsSync(src)) continue;
      fs.mkdirSync(mirrorDir, { recursive: true });
      fs.cpSync(src, path.join(mirrorDir, name));
      mirrored.push(path.join(".featureboard", name));
    }
    return { mirrored };
  } catch (e) {
    return { mirrored, warning: `pad mirror failed: ${e.message}` };
  }
}

/**
 * Run the commit (and optional push) for a ticket in the repo at `cwd`. No-ops with
 * a clear reason when git integration is disabled for the project. Stops at the
 * first failing step and reports it. `exec(args, cwd)` is injectable for testing.
 */
export function commitFeature(board, project, opts = {}, { exec = defaultExec, cwd } = {}) {
  const config = getGitConfig(board, project);
  if (!config.enabled) {
    return { skipped: true, reason: "git integration is disabled for this project (enable it with set_git_config)" };
  }
  // FBMCPF-149: the code and the projectpad can live in different repos. Commit code
  // in gitTargets.codeRepo.path when set, otherwise fall back to the passed cwd
  // (codeLocation). Explicit config wins.
  const targets = resolveGitTargets(board, project);
  const codeCwd = (targets.codeRepo && targets.codeRepo.path) || cwd;
  if (!codeCwd) throw new Error("no code repo path — set the project's codeLocation in project config");

  // FBMCPF-151: for graduated projects, refresh the .featureboard/ pad mirror in the
  // code repo BEFORE staging, so the snapshot rides along in the same "add ." /
  // commit as the code change. Never blocks the close-out: failures come back as a
  // warning on `out`, not a throw.
  const padMirror = mirrorGraduatedPad(board, project, targets);

  // FBMCPF-163: when the caller didn't pass an explicit push param, resolve the
  // effective gitMode (project > global > default) instead of silently defaulting
  // to no-push. "ask" never pushes here — it surfaces a note telling the caller to
  // confirm with the user, then call again with push:true. An explicit opts.push
  // (true or false) always wins over all of this — the resolution below only runs
  // when opts.push is null/undefined.
  let effectivePush = opts.push;
  let gitModeInfo = null;
  let pushNote = null;
  if (opts.push == null) {
    gitModeInfo = resolveGitMode(board, project, config);
    if (gitModeInfo.mode === "commit-push") {
      effectivePush = true;
    } else if (gitModeInfo.mode === "ask") {
      effectivePush = false;
      pushNote =
        `git push mode is "ask" (resolved from ${gitModeInfo.source} config) — committed without pushing. ` +
        `Confirm with the user, then call again with push:true to push.`;
    } else {
      effectivePush = false;
    }
  }

  const plan = buildCommitPlan(config, { ...opts, push: effectivePush });
  const results = [];
  for (const step of plan.steps) {
    const r = exec(step.args, codeCwd);
    results.push({ step: step.label, status: r.status, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() });
    if (r.status !== 0) {
      return { committed: false, failedAt: step.label, message: plan.message, pushed: false, results };
    }
  }
  const out = { committed: true, message: plan.message, pushed: plan.push, codeRepo: codeCwd, results };
  if (gitModeInfo) out.gitMode = gitModeInfo;
  if (pushNote) out.note = pushNote;

  // FBMCPF-188: correlation — capture the commit this just produced and let the
  // ticket learn its own hash (work-log line + a "commit" audit event) instead
  // of correlation being grep-only (get_ticket_diff searching commit messages
  // after the fact). Best-effort: any failure here is swallowed so a git hiccup
  // in the enrichment step can never undo or fail a commit that already landed.
  try {
    const info = captureCommitInfo(exec, codeCwd);
    if (info) {
      out.commit = info;
      if (opts.ticket) {
        try {
          logWork(board, project, {
            ticket: opts.ticket,
            summary: "commit",
            hash: info.shortHash,
            additions: info.additions,
            deletions: info.deletions,
          });
        } catch {
          // work-log append is best-effort — never blocks the commit result
        }
        try {
          appendEvent(board, project, {
            ticket: opts.ticket,
            field: "commit",
            from: null,
            to: info.shortHash,
            hash: info.hash,
            shortHash: info.shortHash,
            additions: info.additions,
            deletions: info.deletions,
            source: "commit_feature",
          });
        } catch {
          // audit event append is best-effort — never blocks the commit result
        }
      }
    }
  } catch {
    // commit-info capture is best-effort — the commit itself already succeeded
  }

  if (!padMirror.skipped) {
    out.padMirror = padMirror;
    if (padMirror.warning) out.warning = padMirror.warning;
  }

  // FBMCPF-149: if the projectpad lives in its OWN git repo (distinct from the code
  // repo), also stage/commit the board's markdown files there. Best-effort: any
  // failure is reported as a warning string rather than throwing, so a code commit
  // is never lost because the pad commit stumbled.
  const padPath = targets.padRepo && targets.padRepo.path;
  if (padPath && padPath !== codeCwd) {
    try {
      if (fs.existsSync(path.join(padPath, ".git"))) {
        const projDir = board.projectDir(project);
        let rel = path.relative(padPath, projDir);
        if (!rel) rel = ".";
        const padMsg = `${opts.ticket || "board"}: board update`;
        const padResults = [];
        let ok = true;
        for (const step of [
          { label: "add", args: ["add", "--", rel] },
          { label: "commit", args: ["commit", "-m", padMsg] },
        ]) {
          const r = exec(step.args, padPath);
          padResults.push({ step: step.label, status: r.status, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() });
          if (r.status !== 0) { ok = false; break; }
        }
        out.padCommit = { committed: ok, path: padPath, message: padMsg, results: padResults };
        if (!ok) {
          const w = `projectpad commit in ${padPath} did not complete cleanly (see padCommit.results)`;
          out.warning = out.warning ? `${out.warning}; ${w}` : w;
        }
      }
    } catch (e) {
      const w = `projectpad commit failed: ${e.message}`;
      out.warning = out.warning ? `${out.warning}; ${w}` : w;
    }
  }
  return out;
}
