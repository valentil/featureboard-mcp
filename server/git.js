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
import { resolveGitTargets } from "./metadata.js";

export const GIT_CONFIG_FILE = "git.config.json";

export const DEFAULT_GIT_CONFIG = {
  enabled: false,
  remote: "origin",
  branch: "main",
  push: false,
  messagePrefix: "",
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
  atomicWrite(configPath(board, project), JSON.stringify(cfg, null, 2) + "\n");
  return cfg;
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
  const plan = buildCommitPlan(config, opts);
  const results = [];
  for (const step of plan.steps) {
    const r = exec(step.args, codeCwd);
    results.push({ step: step.label, status: r.status, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() });
    if (r.status !== 0) {
      return { committed: false, failedAt: step.label, message: plan.message, pushed: false, results };
    }
  }
  const out = { committed: true, message: plan.message, pushed: plan.push, codeRepo: codeCwd, results };

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
        if (!ok) out.warning = `projectpad commit in ${padPath} did not complete cleanly (see padCommit.results)`;
      }
    } catch (e) {
      out.warning = `projectpad commit failed: ${e.message}`;
    }
  }
  return out;
}
