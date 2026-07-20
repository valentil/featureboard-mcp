// Auto-extracted from server/index.js (FBMCPF-224). Registration blocks moved verbatim.
export function registerGitTools(server, ctx) {
  const { captureAsk, cleanupWorktree, commitFeature, createWorktree, fail, getBoard, getGitConfig, getGlobalConfig, listWorktrees, meta, openPullRequest, resolveGitMode, setGitConfig, setGlobalConfig, tryTool, writeTool, z } = ctx;

// Git integration (optional, opt-in) ---------------------------------------

server.registerTool(
  "get_git_config",
  {
    title: "Get git integration config",
    description:
      "Read the project's optional git integration settings (enabled, remote, branch, push, messagePrefix, gitMode). Also reports the RESOLVED push mode (resolvedGitMode) and where it came from (gitModeSource: \"project\" | \"global\" | \"default\") — the project's own gitMode wins, then the account-wide default (set_global_config), then \"commit-only\" (never push). Disabled by default.",
    inputSchema: { project: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    const cfg = getGitConfig(board, project);
    const resolved = resolveGitMode(board, project, cfg);
    return { ...cfg, resolvedGitMode: resolved.mode, gitModeSource: resolved.source };
  })
);

server.registerTool(
  "set_git_config",
  {
    title: "Configure git integration",
    description:
      "Enable/configure optional per-project git integration so finished tickets can be committed (and optionally pushed) to the project's code repo. No secrets are stored — push uses the machine's own git credentials. Set codeLocation in project config to point at the repo. gitMode (\"commit-only\" | \"commit-push\" | \"ask\") controls what commit_feature/deploy_site do when a call doesn't pass an explicit push param, and overrides the account-wide default from set_global_config for this project only.",
    inputSchema: {
      project: z.string(),
      enabled: z.boolean().optional(),
      remote: z.string().optional(),
      branch: z.string().optional(),
      push: z.boolean().optional().describe("Also push after committing. Superseded by gitMode going forward; kept for back-compat."),
      messagePrefix: z.string().optional(),
      gitMode: z.enum(["commit-only", "commit-push", "ask"]).optional().describe("Per-project push behavior, overriding the account-wide default (set_global_config)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  writeTool(({ project, enabled, remote, branch, push, messagePrefix, gitMode }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return setGitConfig(board, project, { enabled, remote, branch, push, messagePrefix, gitMode });
  })
);

server.registerTool(
  "get_global_config",
  {
    title: "Get account-wide config",
    description:
      "Read FeatureBoard's account-wide settings that apply across every project unless a project overrides them via set_git_config. Currently just gitMode (default \"commit-only\"). Stored at <boardsRoot>/.featureboard.global.json.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(() => getGlobalConfig(getBoard()))
);

server.registerTool(
  "set_global_config",
  {
    title: "Configure account-wide settings",
    description:
      "Set FeatureBoard's account-wide settings, applied to every project that doesn't set its own override via set_git_config. Currently: gitMode — \"commit-only\" (never push automatically; the original default behavior), \"commit-push\" (push after every commit_feature/deploy_site that doesn't pass an explicit push param), or \"ask\" (commit only, and return a note asking the caller to confirm with the user before pushing — never pushes silently). Ask the user which they want during onboarding.",
    inputSchema: {
      gitMode: z.enum(["commit-only", "commit-push", "ask"]).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  writeTool(({ gitMode }) => setGlobalConfig(getBoard(), { gitMode }))
);

server.registerTool(
  "commit_feature",
  {
    title: "Commit a finished feature",
    description:
      "If git integration is enabled for the project, commit (and optionally push) the current changes in the project's code repo with a message like 'FBMCPF-##: title' — mirroring the original OpenClaw git flow. For graduated projects, also refreshes a read-only snapshot of the pad (featurelist.md, buglist.md, scratchpad.md, agent_work_log.md, config) into <codeRepo>/.featureboard/ and includes it in the same commit — the central pad stays authoritative, this is a one-way mirror. No-ops with a reason when disabled. When push is omitted, the effective push behavior is resolved from gitMode (project override via set_git_config, else the account-wide default via set_global_config, else \"commit-only\") — \"ask\" commits without pushing and returns a note asking you to confirm before pushing again with push:true; it never pushes silently. Passing push explicitly always overrides gitMode. When the autoStatusOnCommit config key is on, closing keywords in the commit message ('closes/fixes/resolves FBB-12') move that ticket to Done (or Review if requireReview is on) — same-project tickets only (FBMCPF-200). Runs on this machine using its git credentials.",
    inputSchema: {
      project: z.string(),
      ticket: z.string().optional(),
      title: z.string().optional(),
      message: z.string().optional().describe("Explicit commit message (overrides ticket/title)."),
      push: z.boolean().optional().describe("Override the resolved gitMode for this commit (always wins over gitMode)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  writeTool(({ project, ticket, title, message, push }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    const cwd = meta.getProjectConfig(board, project).codeLocation;
    return commitFeature(board, project, { ticket, title, message, push }, { cwd });
  })
);

server.registerTool(
  "open_pull_request",
  {
    title: "Open a PR for a ticket's branch",
    description:
      "Turn a ticket's pushed ticket/<id> branch into a pull request with a ticket-linked title and a closing-keyword body (Closes <id>) — the last step of the worktree→review loop after create_worktree + commit_feature. Uses the gh CLI when installed; otherwise returns a pre-filled compare URL to open manually. If the branch isn't on origin yet it is pushed first only when the resolved git mode is commit-push. Never throws for environmental gaps (no remote, no gh, unpushed branch) — returns opened:false with a reason.",
    inputSchema: {
      project: z.string(),
      ticket: z.string(),
      base: z.string().optional().describe("Base branch for the PR (default: the repo's default branch)."),
      draft: z.boolean().optional().describe("Open as a draft PR."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  writeTool(({ project, ticket, base, draft }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    const t = board.getTask(project, ticket);
    const r = openPullRequest(board, project, {
      ticket,
      title: t ? t.title : "",
      description: t ? t.description || "" : "",
      base,
      draft,
    });
    // FBMCPF-234: record the PR URL on the ticket so board cards can link it
    // and doneGates.requirePullRequest can verify it.
    if (r.opened && r.url) {
      try { board.updateTask(project, ticket, { website: r.url }, { source: "open_pull_request" }); } catch {}
    }
    return r;
  })
);

// parallel-dispatch git worktrees (FBMCPF-136) ------------------------------
server.registerTool(
  "create_worktree",
  {
    title: "Create a git worktree for a ticket",
    description:
      "Create (or reuse) an isolated git worktree for a ticket so several tickets can be worked in PARALLEL - each sub-agent edits its own checked-out directory on branch ticket/<ticket>, sharing one .git object store, never the shared repo working tree. Created at <worktreeDir>/<ticket>. IMPORTANT SYNC CAVEAT: worktrees are placed OUTSIDE the code repo by default (sibling directory <codeLocation>-worktrees/), configurable via the project config key worktreeDir - under Cowork, a worktree created INSIDE a synced repo mount can corrupt git internals or fail to sync, so this tool REFUSES a worktreeDir inside the repo and never auto-creates worktrees in the repo itself. Reuses an existing worktree at the path; creates branch ticket/<ticket> off baseRef (or current HEAD) when absent. Returns the worktree path, branch, and merge-back guidance. Errors clearly when the project has no codeLocation, the path is not a git repo, git is too old (< 2.5), or a non-worktree directory squats the path.",
    inputSchema: {
      project: z.string(),
      ticket: z.string(),
      baseRef: z.string().optional().describe("Branch/ref to base the new ticket branch on (default: repo HEAD)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  writeTool(({ project, ticket, baseRef }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return createWorktree(board, project, ticket, { baseRef });
  })
);

server.registerTool(
  "list_worktrees",
  {
    title: "List a project's git worktrees",
    description:
      "List the git worktrees for a project's code repo (git worktree list). Each entry carries its path, branch, HEAD, whether it's the main repo working tree (isMain), and the derived ticket id. Also returns the resolved worktreeDir where per-ticket worktrees live (OUTSIDE the repo by default; see the sync caveat on create_worktree). Read-only.",
    inputSchema: {
      project: z.string(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return listWorktrees(board, project);
  })
);

server.registerTool(
  "cleanup_worktree",
  {
    title: "Remove a ticket's git worktree",
    description:
      "Remove a ticket's git worktree once its branch has been merged back (git worktree remove + prune). REFUSES when the worktree has uncommitted changes unless force:true. No-ops with a message when no worktree is registered for the ticket, and never force-deletes a path git doesn't recognise as a worktree. Leaves the ticket/<ticket> branch intact (merge it back first with the merge-back guidance).",
    inputSchema: {
      project: z.string(),
      ticket: z.string(),
      force: z.boolean().optional().describe("Remove even if the worktree has uncommitted changes."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  writeTool(({ project, ticket, force }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return cleanupWorktree(board, project, ticket, { force });
  })
);

server.registerTool(
  "capture_ask",
  {
    title: "Capture an external request as a ticket",
    description:
      "Structure ONE pasted external request — a Slack message, forwarded email body, chat snippet — into a feature or bug via the same heuristics as validate_feedback (type/product/priority keywords, model/cap intake guard), labeled ask:<source> with the requester recorded in the description. This is paste-to-structure, not a live intake listener.",
    inputSchema: {
      project: z.string(),
      text: z.string().describe("The pasted request text."),
      source: z.string().optional().describe("Source channel, e.g. slack, email, meeting (label becomes ask:<source>)."),
      from: z.string().optional().describe("Who asked (name/handle/email) — recorded in the description header."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, text, source, from }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return captureAsk(board, project, { source, text, from });
  })
);

}
