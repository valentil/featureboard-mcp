// Auto-extracted from server/index.js (FBMCPF-224). Registration blocks moved verbatim.
export function registerTaskTools(server, ctx) {
  const { StatusEnum, codeFileMap, dismissCleanupFinding, evaluateCommitGate, evaluateDoneGates, evaluateRules, existsSync, getBoard, listCodeTree, meta, mirrorGraduatedPad, nodePath, notifySlack, notifyTicketEvent, pruneBoard, readCodeFile, readFileSync, readdirSync, scanBoardCleanup, suggestFileSplit, tryTool, writeHandoff, writeTool, z } = ctx;

// duplicate-id repair (FBMCPB-11) --------------------------------------------
server.registerTool(
  "repair_duplicate_ids",
  {
    title: "Repair duplicate ticket ids",
    description:
      "Find ticket ids that appear more than once on a board (legacy data can carry collisions like FBF-491 twice), " +
      "and optionally renumber the later occurrences to fresh ids. Dry-run by default; pass apply:true to write. " +
      "Note: updates to a duplicated id are refused until the board is repaired.",
    inputSchema: {
      project: z.string(),
      apply: z.boolean().optional().default(false).describe("Renumber later occurrences (writes the board files)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  writeTool(({ project, apply }) => {
    const board = getBoard();
    const duplicates = board.findDuplicateTickets(project);
    const repair = board.repairDuplicateTickets(project, { dryRun: !apply });
    return { duplicates, ...repair };
  })
);

server.registerTool(
  "set_status",
  {
    title: "Set status",
    description:
      "Move a task between Todo / In Progress / Review / Done. Review sits between In Progress and Done when requireReview is on; approve:true overrides the gate. When moving to Done you can also record structured completion metadata (model, tokens, additions, deletions) — these are written to the work log and roll up into velocity/metrics. For graduated projects, moving to Done also refreshes the pad snapshot in <codeRepo>/.featureboard/ (best-effort; a mirror failure never blocks the status change). If git is enabled for the project and Done is reached with no commit referencing the ticket (recorded via commit_feature, or found via git log --grep), the response carries uncommitted:true + a commitReminder — or, when requireCommitOnDone is on, the move is refused outright (approve:true overrides).",
    inputSchema: {
      project: z.string(),
      ticket: z.string(),
      status: StatusEnum,
      approve: z.boolean().optional().describe("Override the requireReview gate, and the requireCommitOnDone gate, when moving straight to Done."),
      completionSummary: z.string().optional().describe("Recommended when moving to Done."),
      model: z.string().optional().describe("Model that did the work (Done only)."),
      tokens: z.number().int().optional().describe("Total tokens used (Done only)."),
      inputTokens: z.number().int().optional(),
      outputTokens: z.number().int().optional(),
      additions: z.number().int().optional().describe("Lines added (Done only)."),
      deletions: z.number().int().optional().describe("Lines deleted (Done only)."),
      handoff: z.string().optional().describe("Handoff note for successor tickets, written to handoffs/<TICKET>.md (Done only)."),
      verbose: z.boolean().optional().describe("Return the full ticket view (description, labels, attachments, dates, ...) instead of the default compact ack."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  writeTool(({ project, ticket, status, approve, completionSummary, model, tokens, inputTokens, outputTokens, additions, deletions, handoff, verbose }) => {
    const board = getBoard();
    // FBMCPF-189: Done-without-commit gate/warning. evaluateCommitGate is a
    // no-op (missingCommit:false) whenever git is disabled for the project,
    // whenever a commit is actually found, or whenever the check itself is
    // "unknown" (a git hiccup) — so the non-git path does no extra work and
    // a git failure can never break set_status. When it does report a
    // genuinely missing commit, requireCommitOnDone decides whether that's
    // a hard refusal (thrown before the mutation below, approve:true
    // overrides) or just a non-blocking uncommitted/commitReminder note.
    let commitGate = { missingCommit: false, refuse: false };
    if (status === "Done") {
      try {
        commitGate = evaluateCommitGate(board, project, ticket, { approve: approve === true });
      } catch {
        commitGate = { missingCommit: false, refuse: false };
      }
    }
    if (commitGate.refuse) throw new Error(commitGate.error);
    // FBMCPF-215: configurable Done gates (resolved review / passing test / work log).
    if (status === "Done" && approve !== true) {
      const gate = evaluateDoneGates(board, project, ticket);
      if (gate.refuse) throw new Error(gate.error);
    }
    const result = board.setStatus(project, ticket, status, completionSummary, { approve });
    if (commitGate.missingCommit) {
      result.uncommitted = true;
      result.commitReminder = `${ticket} moved to Done with no commit found for it yet — consider commit_feature.`;
    }
    if (status === "Done" && handoff) writeHandoff(board, project, ticket, handoff); // FBMCPF-144
    // FBMCPF-155: non-blocking Slack notification on Done/Review (never throws).
    if (status === "Done" || status === "Review") {
      try {
        const t = board.getTask(project, ticket);
        notifyTicketEvent(board, project, status === "Done" ? "done" : "review", t).catch(() => {});
      } catch {}
    }
    // On completion, log structured metrics so they roll up into velocity.
    if (status === "Done" && (model || tokens != null || additions != null || deletions != null)) {
      meta.logWork(board, project, {
        ticket,
        summary: completionSummary || `Completed ${ticket}`,
        model, tokens, inputTokens, outputTokens, additions, deletions,
      });
      result.metrics = meta.ticketMetrics(board, project, ticket);
      // FBMCPF-190: nudge for token telemetry — velocity/eval readouts are
      // skewed by metrics events that omit a token count (docs/EVIDENCE.md).
      if (tokens == null) result.telemetryHint = "tokens not recorded \u2014 pass tokens for accurate velocity/eval";
    }
    // FBMCPF-151: for graduated projects, refresh the .featureboard/ pad mirror in
    // the code repo on close-out too (not just commit_feature), so the snapshot
    // stays fresh even if commit_feature is never called for this ticket. Never
    // blocks Done: a mirror failure comes back as a warning, not a thrown error.
    if (status === "Done") {
      try {
        const targets = meta.resolveGitTargets(board, project);
        const padMirror = mirrorGraduatedPad(board, project, targets);
        if (!padMirror.skipped) {
          result.padMirror = padMirror;
          if (padMirror.warning) result.warning = padMirror.warning;
        }
      } catch (e) {
        result.warning = `pad mirror failed: ${e.message}`;
      }
    }
    // Close-out discipline: a Done ticket should always carry a summary.
    if (status === "Done" && !completionSummary) {
      const w =
        "Closed without a completionSummary — pass one so the board records what was done. Also consider log_work with additions/deletions.";
      result.warning = result.warning ? `${result.warning}; ${w}` : w;
    }
    // FBMCPF-196: fire status-change automation rules (best-effort).
    const auto = evaluateRules(board, project, { trigger: "status-change", ticket, to: status }, { notify: (text) => notifySlack(board, project, { text, event: "summary" }) });
    if (auto.applied.length) result.automations = auto.applied;
    if (auto.warnings.length) result.warning = result.warning ? `${result.warning}; ${auto.warnings.join("; ")}` : auto.warnings.join("; ");
    return verbose ? result : meta.compactAck(result);
  })
);

server.registerTool(
  "decompose_feature",
  {
    title: "Decompose feature",
    description:
      "Replace one feature with a set of linked subtasks. You provide the subtasks; this creates them (each linked to the parent) and deletes the parent. Returns the new tickets.",
    inputSchema: {
      project: z.string(),
      ticket: z.string().describe("The parent feature to decompose."),
      subtasks: z
        .array(
          z.object({
            title: z.string(),
            description: z.string().optional(),
            dueDate: z.string().optional(),
            product: z.string().optional(),
          })
        )
        .min(2),
      keepParent: z.boolean().optional().default(false).describe("If true, keep the parent instead of deleting it."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, ticket, subtasks, keepParent }) => {
    const board = getBoard();
    const parent = board.getTask(project, ticket);
    if (!parent) throw new Error(`Parent feature ${ticket} not found.`);
    const created = subtasks.map((s) =>
      board.addTask(project, "feature", { ...s, linkedIssue: ticket })
    );
    if (!keepParent) board.deleteTask(project, ticket);
    return { parent: ticket, kept: !!keepParent, created };
  })
);

server.registerTool(
  "link_tasks",
  {
    title: "Link tasks",
    description:
      "Relate two tickets. kind \"linked\" (default) sets `ticket`'s linked issue to `linkedIssue` " +
      "(e.g. link a bug to the feature it affects). kind \"blocks\" makes `linkedIssue` a blocker of " +
      "`ticket` — the child `ticket` gains `linkedIssue` in its blockedBy list; edges that would close a " +
      "dependency cycle are rejected.",
    inputSchema: {
      project: z.string(),
      ticket: z.string(),
      linkedIssue: z.string(),
      kind: z.enum(["linked", "blocks"]).optional().default("linked"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  writeTool(({ project, ticket, linkedIssue, kind }) => {
    const board = getBoard();
    if (kind === "blocks") {
      const existing = board.getTask(project, ticket);
      if (!existing) throw new Error(`Task ${ticket} not found.`);
      const cur = existing.blockedBy || [];
      const next = cur.includes(linkedIssue) ? cur : [...cur, linkedIssue];
      return board.updateTask(project, ticket, { blockedBy: next });
    }
    return board.linkTasks(project, ticket, linkedIssue);
  })
);

server.registerTool(
  "add_attachment",
  {
    title: "Add attachment",
    description:
      "Attach a file path or URL to a ticket (stored as [Attachments: ...] on the ticket line). Idempotent: attaching the same item twice is a no-op.",
    inputSchema: { project: z.string(), ticket: z.string(), attachment: z.string().describe("A file path or URL.") },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  writeTool(({ project, ticket, attachment }) => {
    const board = getBoard();
    const t = board.getTask(project, ticket);
    if (!t) throw new Error(`Ticket ${ticket} not found in "${project}".`);
    const attachments = (t.attachments || []).slice();
    if (!attachments.includes(attachment)) attachments.push(attachment);
    return board.updateTask(project, ticket, { attachments });
  })
);

server.registerTool(
  "remove_attachment",
  {
    title: "Remove attachment",
    description: "Detach a previously attached file path or URL from a ticket.",
    inputSchema: { project: z.string(), ticket: z.string(), attachment: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  writeTool(({ project, ticket, attachment }) => {
    const board = getBoard();
    const t = board.getTask(project, ticket);
    if (!t) throw new Error(`Ticket ${ticket} not found in "${project}".`);
    const attachments = (t.attachments || []).filter((a) => a !== attachment);
    return board.updateTask(project, ticket, { attachments });
  })
);

server.registerTool(
  "delete_task",
  {
    title: "Delete task",
    description: "Permanently remove a task from its board.",
    inputSchema: { project: z.string(), ticket: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, ticket }) => {
    const deleted = getBoard().deleteTask(project, ticket);
    return { deleted: ticket, title: deleted.title };
  })
);

server.registerTool(
  "scan_board_cleanup",
  {
    title: "Scan board for cleanup",
    description:
      "Read-only deep-clean scan: finds likely-duplicate tickets (grouped by title similarity, each group nominating a keeper + removal candidates), stale/placeholder tickets (old Todo items, placeholder titles), open tickets missing a model:/cap: label (FBMCPF-159 intake orchestration guard — nothing should sit in the queue without a sub-model orchestration decision), and priority-scaled SLA breaches (FBMCPF-198: high-priority tickets stuck In Progress with no recent work-log activity → 'escalate'; tickets languishing in Todo → 'stale'; per-priority thresholds overridable via the slaThresholds config key). Returns a suggested removal set to feed prune_board. Never deletes — a good fit for a recurring Cowork scheduled task that surfaces breaches each morning.",
    inputSchema: {
      project: z.string(),
      staleDays: z.coerce.number().int().optional().default(30).describe("Age (days) at which an open Todo counts as stale."),
      similarity: z.coerce.number().optional().default(0.7).describe("Title-similarity threshold 0–1 for duplicate grouping."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, staleDays, similarity }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return scanBoardCleanup(board, project, { staleDays, similarity });
  })
);

server.registerTool(
  "scan_test_cleanup",
  {
    title: "Scan tests for cleanup",
    description: "Read-only deep-clean of the project's test/ dir: finds byte-identical duplicate test files, stale files whose filename ticket id is no longer on the board, and empty stub files (only TODO placeholder assertions). Returns a suggested removal set. Never deletes — companion to scan_board_cleanup.",
    inputSchema: { project: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    const cfg = meta.getProjectConfig(board, project);
    if (!cfg.codeLocation) throw new Error("no codeLocation set for this project (set it with set_project_config).");
    const testDir = nodePath.join(cfg.codeLocation, "test");
    let files = [];
    if (existsSync(testDir)) {
      files = readdirSync(testDir)
        .filter((f) => /\.test\.(m?js|ts)$/.test(f))
        .map((f) => ({ name: f, content: (() => { try { return readFileSync(nodePath.join(testDir, f), "utf8"); } catch { return ""; } })() }));
    }
    const known = board.listTasks(project, {}).map((t) => t.ticketNumber);
    return { project, testDir, ...scanTestFiles(files, { knownTickets: known }) };
  })
);

server.registerTool(
  "prune_board",
  {
    title: "Prune board tickets",
    description:
      "Guarded cleanup: deletes ONLY the ticket ids you pass, and only when confirm is true (otherwise returns a dry-run preview of what would be deleted). Non-existent ids are reported, not fatal. Pair with scan_board_cleanup's suggestedRemovals.",
    inputSchema: {
      project: z.string(),
      tickets: z.array(z.string()).describe("Exact ticket ids to remove."),
      confirm: z.boolean().optional().default(false).describe("Must be true to actually delete."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, tickets, confirm }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return pruneBoard(board, project, tickets, { confirm });
  })
);

server.registerTool(
  "dismiss_cleanup_finding",
  {
    title: "Dismiss a cleanup finding",
    description:
      "Suppress a scan_board_cleanup finding from future scans WITHOUT deleting anything — for false positives or findings you've consciously accepted. Pass the finding's stable `id` (shown on each duplicate/stale/unlabeled/SLA finding) and an optional reason. Dismissals are append-only; future scans hide the finding and report dismissedCount. The id is a hash of the finding's type+ticket, so it keeps matching across rescans until that ticket changes category.",
    inputSchema: {
      project: z.string(),
      findingId: z.string().describe("The stable `id` from a scan_board_cleanup finding."),
      reason: z.string().optional().describe("Why this finding is being dismissed."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  writeTool(({ project, findingId, reason }) => dismissCleanupFinding(getBoard(), project, { findingId, reason }))
);

/* ---------- code file explorer over codeLocation (FBMCPF-82) ---------- */
function codeRoot(project) {
  const board = getBoard();
  if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
  const cfg = meta.getProjectConfig(board, project);
  if (!cfg || !cfg.codeLocation) throw new Error(`Project "${project}" has no codeLocation configured (set it with set_project_config).`);
  return cfg.codeLocation;
}

server.registerTool(
  "list_code_files",
  {
    title: "List code files",
    description:
      "List files and folders under the project's codeLocation (optionally a subpath), with sizes and extensions. Skips vendor/build dirs (node_modules, .git, dist, …). depth controls how many levels to expand. Sandboxed to codeLocation.",
    inputSchema: {
      project: z.string(),
      subpath: z.string().optional().describe("Directory under codeLocation to list (default: root)."),
      depth: z.coerce.number().int().optional().default(1).describe("Levels to expand (1 = just this dir)."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, subpath, depth }) => listCodeTree(codeRoot(project), { subpath, depth }))
);

server.registerTool(
  "read_code_file",
  {
    title: "Read a code file",
    description:
      "Read a file under the project's codeLocation as UTF-8 text (size-capped; binary files are flagged, not dumped). Returns content + line count. Sandboxed to codeLocation (no path escape).",
    inputSchema: {
      project: z.string(),
      path: z.string().describe("File path relative to codeLocation, e.g. server/index.js."),
      maxBytes: z.coerce.number().int().optional().default(200000),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, path: rel, maxBytes }) => readCodeFile(codeRoot(project), rel, { maxBytes }))
);

server.registerTool(
  "suggest_file_split",
  {
    title: "Suggest a file split (refactor prompt)",
    description:
      "Given an oversized source file (see code_file_map's splitCandidates), return a structured, ready-to-execute refactor proposal: exported symbols clustered by name-prefix, proposed target modules, keep-original-as-barrel guidance, and a prompt to hand straight to the agent. Read-only — the server never edits code; Claude executes the split.",
    inputSchema: {
      project: z.string(),
      file: z.string().describe("Path relative to the project's codeLocation."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, file }) => {
    const board = getBoard();
    const root = meta.getProjectConfig(board, project).codeLocation;
    if (!root) throw new Error("No codeLocation configured for this project.");
    return suggestFileSplit(root, file);
  })
);

server.registerTool(
  "code_file_map",
  {
    title: "Map the codebase",
    description:
      "Recursively map the project's codeLocation: total file count + bytes, counts by extension, and the files that exceed the split thresholds (lines/bytes) as split candidates (worst first) — useful for spotting oversized modules to decompose. With symbols:true, also returns a per-file list of top-level exported functions/classes/consts for JS/TS files (regex-based, capped per file) — a lightweight symbol map for navigation.",
    inputSchema: {
      project: z.string(),
      splitLines: z.coerce.number().int().optional().default(400),
      splitBytes: z.coerce.number().int().optional().default(32768),
      symbols: z.boolean().optional().default(false).describe("Also extract top-level exported symbols per JS/TS file."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, splitLines, splitBytes, symbols }) => codeFileMap(codeRoot(project), { splitLines, splitBytes, symbols }))
);

}
