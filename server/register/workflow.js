// Auto-extracted from server/index.js (FBMCPF-224). Registration blocks moved verbatim.
export function registerWorkflowTools(server, ctx) {
  const { applyRollover, planRollover, addDecision, addReviewComment, appendEvent, assignSprint, blendPlan, checkAcceptance, closeSprint, createSprint, dailyPlan, decisionsForTicket, estimateWork, evalReport, evaluateRules, exportBoard, exportMetricsSeries, exportWorkLog, getBoard, getGlobalConfig, getRequirements, getSprintReport, getTicketDiff, getTicketHistory, getTimelineData, graduateProject, listDecisions, listReviewComments, listSprints, meta, notifySlack, planBudget, resolveReviewComment, setRequirements, sprintOfTask, tryTool, writeHandoff, writeTool, z } = ctx;

// sprints (FBMCPF-120) -------------------------------------------------------
server.registerTool(
  "create_sprint",
  {
    title: "Create sprint",
    description:
      "Create (or update) a named sprint on a board, with optional start/end dates and a one-line goal. " +
      "The registry is persisted in the project config; tickets join a sprint via a sprint:<name> label " +
      "(see assign_sprint), so label-only sprints written by the board UI keep working.",
    inputSchema: {
      project: z.string(),
      name: z.string().describe('Sprint name, e.g. "Sprint 1" or "2026-W29". No ":", ",", "[" or "]".'),
      start: z.string().optional().describe("YYYY-MM-DD"),
      end: z.string().optional().describe("YYYY-MM-DD"),
      goal: z.string().optional().describe("One-line sprint goal."),
      tickets: z.array(z.string()).optional().describe("Tickets to pull into the sprint right away."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  writeTool(({ project, name, start, end, goal, tickets }) => {
    const board = getBoard();
    const created = createSprint(board, project, { name, start, end, goal });
    const assigned = tickets && tickets.length ? assignSprint(board, project, tickets, created.name) : null;
    return { created, ...(assigned ? { assigned: assigned.updated } : {}) };
  })
);

server.registerTool(
  "list_sprints",
  {
    title: "List sprints",
    description:
      "List a board's sprints (config registry plus any label-only sprints) with progress per sprint " +
      "(total/done/inProgress/todo, complete flag) and the count of open backlog tickets in no sprint.",
    inputSchema: { project: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project }) => listSprints(getBoard(), project))
);

server.registerTool(
  "assign_sprint",
  {
    title: "Assign sprint",
    description:
      "Move one or more tickets into a sprint — sets the sprint:<name> label, replacing any existing sprint label. " +
      "Pass sprint: null to send tickets back to the backlog.",
    inputSchema: {
      project: z.string(),
      tickets: z.array(z.string()).min(1),
      sprint: z.string().nullable().describe("Sprint name, or null to clear."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  writeTool(({ project, tickets, sprint }) => assignSprint(getBoard(), project, tickets, sprint))
);

// sprint close-out reports (FBMCPF-156) --------------------------------------
server.registerTool(
  "close_sprint",
  {
    title: "Close sprint & generate reports",
    description:
      "Close a sprint and generate four audience-specific close-out reports (marketing, sales, technical, executive) from its tickets, work log, and metrics (velocity, tokens, $ cost, ADRs touched, CRM ticket links). " +
      "Refuses to close while the sprint still has open (non-Done) tickets unless force:true. Writes reports/<sprint>/<audience>.md pads under the project and returns their paths, a metric summary, and a per-audience LLM prompt (packet + brief) for richer draft copy. " +
      "Posts a Slack summary when the project has Slack configured (never fails the close on a Slack error). " +
      "Also handles the sprint's remaining open tickets per rolloverMode (FBMCPF-197): 'review' (default) returns a categorized rollover plan without moving anything; 'auto' retags P0/P1 tickets into nextSprint (or flags them rollover-pending if no nextSprint given), labels P2/P3 tickets rollover-candidate for human review, and drops the sprint label from P4+/unprioritized tickets back to the backlog; 'off' skips rollover handling entirely. The result's existing shape is unchanged — rollover info is added as a `rollover` section.",
    inputSchema: {
      project: z.string(),
      sprint: z.string().describe("Sprint name (its sprint:<name> label)."),
      force: z.boolean().optional().describe("Close even if some tickets are still open (they are reported as carryover)."),
      rolloverMode: z
        .enum(["auto", "review", "off"])
        .optional()
        .describe(
          "How to handle tickets still open when the sprint closes. 'review' (default): categorized rollover plan only, nothing moves. " +
            "'auto': P0/P1 -> nextSprint (or rollover-pending flag if no nextSprint); P2/P3 -> rollover-candidate label; P4+/unprioritized -> dropped back to backlog. " +
            "'off': no rollover handling (legacy behavior)."
        ),
      nextSprint: z.string().optional().describe("Sprint name P0/P1 tickets roll into under rolloverMode 'auto' (created/registered if it doesn't exist yet)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  writeTool(async ({ project, sprint, force, rolloverMode, nextSprint }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    const notify = (text) => notifySlack(board, project, { text, event: "summary" });
    const result = await closeSprint(board, project, sprint, { force: !!force, notify });
    const mode = rolloverMode || "review";
    let rollover;
    if (mode === "off") {
      rollover = { mode: "off" };
    } else if (mode === "auto") {
      rollover = { mode: "auto", ...applyRollover(board, project, sprint, { nextSprint: nextSprint || null }) };
    } else {
      rollover = { mode: "review", ...planRollover(board, project, sprint, { nextSprint: nextSprint || null }) };
    }
    // FBMCPF-196: fire sprint-closed automation rules for each ticket in the sprint.
    const automations = [];
    for (const t of board.listTasks(project, {})) {
      if ((sprintOfTask(t) || "").toLowerCase() !== String(sprint).toLowerCase()) continue;
      const auto = evaluateRules(board, project, { trigger: "sprint-closed", ticket: t.ticketNumber }, { notify });
      if (auto.applied.length) automations.push({ ticket: t.ticketNumber, applied: auto.applied });
    }
    const out = { ...result, rollover };
    if (automations.length) out.automations = automations;
    return out;
  })
);

server.registerTool(
  "get_sprint_report",
  {
    title: "Read sprint reports",
    description:
      "Read the close-out reports written by close_sprint. With no sprint: list sprints that have reports. With a sprint but no audience: the manifest + which audiences exist. With sprint + audience (marketing|sales|technical|executive): that report's markdown.",
    inputSchema: {
      project: z.string(),
      sprint: z.string().optional().describe("Sprint name; omit to list all sprints with reports."),
      audience: z.enum(["marketing", "sales", "technical", "executive"]).optional().describe("Which audience's report to read."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, sprint, audience }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return getSprintReport(board, project, { sprint, audience });
  })
);

// graduation (FBMCPF-150) ---------------------------------------------------
server.registerTool(
  "graduate_project",
  {
    title: "Graduate project",
    description:
      "One-command incubator \u2192 dedicated-repo graduation (lifecycle \"Option C\"). Copies the project's " +
      "CODE out to targetPath, EXCLUDING pad files (featurelist/buglist/scratchpad/etc) and junk " +
      "(node_modules, .git, *.log, *.zip, tmp_*, ...), then repoints codeLocation, sets stage=graduated and " +
      "gitTargets.codeRepo, and records the move in the scratchpad. The pad STAYS in the boards dir — it is " +
      "only read, never modified or deleted — and the target repo additionally gets a read-only snapshot " +
      "mirror of the pad files under .featureboard/. When commit is on and git is available the copied code + " +
      "mirror are git-init'd (if needed) and committed; git absence/failure is tolerated as a warning. " +
      "DRY-RUN BY DEFAULT: apply is false unless you pass apply:true, so the first call returns the plan " +
      "(source, target, files, skipped) without touching the filesystem. CADSolver was the manual prototype.",
    inputSchema: {
      project: z.string(),
      targetPath: z.string().describe("Destination directory for the graduated code repo."),
      excludes: z.array(z.string()).optional().describe("Extra basename glob-ish excludes on top of the defaults."),
      commit: z.boolean().optional().default(true).describe("git-init (if needed) + commit the copied code in the target."),
      apply: z.boolean().optional().default(false).describe("false = dry-run plan only; true = actually move the code."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  writeTool(({ project, targetPath, excludes, commit, apply }) =>
    graduateProject(getBoard(), project, targetPath, { excludes, commit, dryRun: !apply })
  )
);

// estimator + budget planner (FBMCPF-123/124) --------------------------------
server.registerTool(
  "estimate_work",
  {
    title: "Estimate work",
    description:
      "Per-ticket token estimates for all open tickets, derived from the board's own history: a cap:<tokens> label wins, " +
      "then the median actual spend of Done tickets in the same product, then the board median, then a documented default. " +
      "Each estimate carries its basis, confidence, spend so far, and a suggested model (model:<name> label or heuristic).",
    inputSchema: { project: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project }) => estimateWork(getBoard(), project))
);

server.registerTool(
  "plan_budget",
  {
    title: "Plan budget",
    description:
      "Map a token budget onto the priority-ordered open queue BEFORE spending it: assigns tickets to days (greedy load-balance), " +
      "draws the cutline where the budget runs out, and reports the Opus/Sonnet split with blended cost units. " +
      "Optionally restrict to one sprint. When account-wide planLimits is captured (set_global_config), also returns an additive blendPlan " +
      "(FBMCPF-279): days to reset, the fable/non-fable percent-per-day pace that converges both weekly meters, and concrete parallel-wave " +
      "suggestions sized from the open backlog's effort and the board's historical tokens-per-ticket. The token budgeting is unchanged. " +
      "Read-only — apply model choices with update_task labels if you want them stuck.",
    inputSchema: {
      project: z.string(),
      budgetTokens: z.number().int().positive().optional().default(25000000).describe("Weekly token budget (default 25M)."),
      days: z.number().int().min(1).max(14).optional().default(5),
      sprint: z.string().optional().describe("Limit the plan to tickets in this sprint."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, budgetTokens, days, sprint }) => {
    const board = getBoard();
    const result = planBudget(board, project, { budgetTokens, days, sprint });
    // FBMCPF-279: additive blend plan when account-wide planLimits is captured.
    // Existing token budgeting is untouched — blend rides alongside it.
    try {
      const bp = blendPlan(board, project, getGlobalConfig(board), new Date());
      if (bp) result.blendPlan = bp;
    } catch { /* blend plan is additive/best-effort */ }
    return result;
  })
);

server.registerTool(
  "daily_plan",
  {
    title: "Daily plan",
    description:
      "Plan TODAY: pick the day's slice of the priority queue (default budget 5M logged tokens \u2248 one day of a 25M week), " +
      "assign each ticket a model from the roster (fable=orchestration/design, opus=architecture/invariants, sonnet=standard implementation, " +
      "haiku=mechanical docs/copy) and an effort level (low/medium/high). apply:true writes model:/effort: labels onto the tickets. " +
      "Returns dispatch groups: sonnet/haiku tickets safe to run as parallel sub-agents, opus/fable sequential. Pair with the daily_plan prompt to execute.",
    inputSchema: {
      project: z.string(),
      budgetTokens: z.number().int().positive().optional().default(650000).describe("Today's logged-token budget (default 650k; ~weekly 25M effective \u00f7 5 days \u00f7 ×8 orchestration multiplier)."),
      sprint: z.string().optional().describe("Limit to one sprint."),
      apply: z.boolean().optional().default(false).describe("Write model:/effort: labels to the planned tickets."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  writeTool(({ project, budgetTokens, sprint, apply }) => dailyPlan(getBoard(), project, { budgetTokens, sprint, apply }))
);

server.registerTool(
  "eval_report",
  {
    title: "Eval report",
    description:
      "Compare board-workflow vs chat-workflow trials using label conventions: experiment:board / experiment:chat marks a ticket's arm, and an optional pair:<id> label ties a board trial to its chat counterpart. Returns every labeled trial (tokens and $ cost from the work log, additions/deletions, wall-clock days, rework = linked bugs within 7 days of completion), per-arm medians/totals (including totalCost), matched pairs with a token ratio, and a one-line summary.",
    inputSchema: { project: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project }) => evalReport(getBoard(), project))
);

server.registerTool(
  "export_tasks",
  {
    title: "Export tasks",
    description:
      "Export a board's tasks to json, csv, or markdown for use outside FeatureBoard (e.g. sharing with a PM tool). Round-trips through import_tasks. Read-only.",
    inputSchema: {
      project: z.string(),
      format: z.enum(["json", "csv", "markdown"]).optional().default("json"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, format }) => ({ project, format, content: exportBoard(getBoard(), project, format) }))
);

server.registerTool(
  "export_metrics",
  {
    title: "Export metrics / work log",
    description:
      "Flat-file export of analytics for external BI/spreadsheet use, mirroring export_tasks: what:'worklog' exports the per-event work log (date, ticket, model, tokens, additions/deletions); what:'completions' exports status counts + completions-by-date. Formats: json or csv. Read-only.",
    inputSchema: {
      project: z.string(),
      what: z.enum(["worklog", "completions"]).optional().default("worklog"),
      format: z.enum(["json", "csv"]).optional().default("json"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, what, format }) => {
    const board = getBoard();
    const content =
      what === "completions"
        ? exportMetricsSeries(board.getMetrics(project), format)
        : exportWorkLog(meta.readWorkLog(board, project), format);
    return { project, what, format, content };
  })
);

server.registerTool(
  "set_requirements",
  {
    title: "Set ticket requirements",
    description:
      "Write a ticket's refined requirements pad (requirements/<TICKET>.md): intent, assumptions, acceptance criteria, and open questions. Overwrites any existing pad. Once set, the ticket's work packet carries these requirements and its definition-of-done becomes the acceptance criteria. Draft the content first (see the refine prompt), then persist it here.",
    inputSchema: {
      project: z.string(),
      ticket: z.string(),
      intent: z.string().describe("One or two sentences: what this ticket delivers and why."),
      assumptions: z.array(z.string()).optional().describe("Explicit assumptions the work relies on."),
      acceptanceCriteria: z.array(z.string()).optional().describe("Testable done-conditions, one per item."),
      openQuestions: z.array(z.string()).optional().describe("Unresolved questions to raise with the user."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  writeTool(({ project, ticket, intent, assumptions, acceptanceCriteria, openQuestions }) =>
    setRequirements(getBoard(), project, ticket, { intent, assumptions, acceptanceCriteria, openQuestions }))
);

server.registerTool(
  "get_requirements",
  {
    title: "Get ticket requirements",
    description:
      "Read a ticket's requirements pad as structured intent / assumptions / acceptance criteria (with done flags) / open questions, plus the raw markdown. Returns null when no pad exists.",
    inputSchema: { project: z.string(), ticket: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, ticket }) => getRequirements(getBoard(), project, ticket))
);

server.registerTool(
  "check_acceptance",
  {
    title: "Check an acceptance criterion",
    description:
      "Toggle the checkbox on acceptance criterion #index (1-based) of a ticket's requirements pad. Hand-added sections are preserved. done defaults to true.",
    inputSchema: {
      project: z.string(),
      ticket: z.string(),
      index: z.number().int().min(1).describe("1-based position of the acceptance criterion."),
      done: z.boolean().optional().describe("Checked (true, default) or unchecked (false)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  writeTool(({ project, ticket, index, done }) =>
    checkAcceptance(getBoard(), project, ticket, index, done !== false))
);

server.registerTool(
  "notify_slack",
  {
    title: "Notify Slack",
    description:
      "Post a message to THIS project's user-configured Slack incoming webhook. This is deliberate outbound egress: the board is otherwise local-only, and this sends to the https://hooks.slack.com/... URL the user set in project config (slackWebhook) — nowhere else. No-ops with sent:false when Slack is unconfigured or the event isn't in the project's slackEvents allow-list; failures return a warning and never throw.",
    inputSchema: {
      project: z.string(),
      text: z.string().describe("Message to post (Slack mrkdwn)."),
      event: z.enum(["done", "review", "summary"]).optional().default("summary").describe("Event class; must be in the project's slackEvents to actually send."),
    },
    annotations: { openWorldHint: true, readOnlyHint: false, destructiveHint: false },
  },
  tryTool(({ project, text, event }) => notifySlack(getBoard(), project, { text, event }))
);

server.registerTool(
  "add_decision",
  {
    title: "Add an architecture decision record",
    description:
      "Append a new ADR to a project's decision log (decisions.md): context, decision, consequences, and any tickets it relates to. Auto-numbers ADR-<n>. Append-only — never rewrites prior ADRs. Relevant ADRs surface automatically in ticket work packets.",
    inputSchema: {
      project: z.string(),
      title: z.string().describe("Short title for the decision."),
      context: z.string().optional().describe("What prompted this decision."),
      decision: z.string().describe("The choice that was made."),
      consequences: z.string().optional().describe("Tradeoffs / follow-on effects."),
      tickets: z.array(z.string()).optional().describe("Ticket ids this decision relates to."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, title, context, decision, consequences, tickets }) =>
    addDecision(getBoard(), project, { title, context, decision, consequences, tickets }))
);

server.registerTool(
  "list_decisions",
  {
    title: "List architecture decision records",
    description:
      "Read a project's ADR log as structured entries: id, title, date, context, decision, consequences, tickets. Pass ticket to filter to decisions relevant to that ticket.",
    inputSchema: {
      project: z.string(),
      ticket: z.string().optional().describe("Filter to decisions relevant to this ticket id."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, ticket }) =>
    ticket ? decisionsForTicket(getBoard(), project, ticket) : listDecisions(getBoard(), project))
);

server.registerTool(
  "set_handoff",
  {
    title: "Set ticket handoff note",
    description:
      "Write a ticket's handoff note (handoffs/<TICKET>.md): free-form markdown for whatever a successor ticket needs to know. Overwrites any existing note. Surfaces automatically in the work packets of tickets blockedBy this one; read it via get_work_packet.",
    inputSchema: {
      project: z.string(),
      ticket: z.string(),
      note: z.string().describe("Free-form markdown handoff note for successor tickets."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  writeTool(({ project, ticket, note }) => writeHandoff(getBoard(), project, ticket, note))
);

// audit timeline (FBMCPF-142) ------------------------------------------------
server.registerTool(
  "get_ticket_history",
  {
    title: "Get ticket history",
    description:
      "Full audit timeline for one ticket: recorded field-change events (status moves, priority moves, label/sprint changes, due-date edits — captured automatically by set_status/update_task/assign_sprint) merged in chronological order with that ticket's work-log entries (tokens/additions/deletions per work session). Tolerates tickets with no recorded events yet (pre-FBMCPF-142 tickets still show their work-log history).",
    inputSchema: {
      project: z.string(),
      ticket: z.string(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, ticket }) => getTicketHistory(getBoard(), project, ticket))
);

// piano-roll timeline data (FBMCPF-158) --------------------------------------
server.registerTool(
  "get_timeline_data",
  {
    title: "Get timeline data (piano-roll)",
    description:
      "Per-ticket worked spans for the board's piano-roll Timeline view, in one read pass. For every ticket returns: created date, startedAt (first status→In Progress audit event, falling back to its earliest work-log entry, then createdDate — startedSource says which), completedAt (completionDate or last status→Done event), lastActivity, status/product/type/sprint/priority/model for lane grouping and colour, cumulative tokens/additions/deletions/cost, and per-day work rollups (days[]) for clip intensity. Also returns a board-wide byDate[] rollup (tokens/additions/deletions/cost per day) for the datastream overlay strip. Optional from/to (ISO date or datetime) keep only spans whose worked window overlaps that range. Read-only.",
    inputSchema: {
      project: z.string(),
      from: z.string().optional().describe("ISO date/datetime lower bound; only spans overlapping [from,to] are returned."),
      to: z.string().optional().describe("ISO date/datetime upper bound; only spans overlapping [from,to] are returned."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, from, to }) => getTimelineData(getBoard(), project, { from, to }))
);

// per-ticket diff capture + PR-style review comments (FBMCPF-135) ------------
server.registerTool(
  "get_ticket_diff",
  {
    title: "Get ticket diff",
    description:
      "Capture the code changes made for a ticket: find commits in the project's code repo (codeLocation / gitTargets.codeRepo) whose message mentions the ticket id and return, per commit, a summary (hash/author/date/subject) plus a size-capped unified diff (git show). Read-only — never writes or fetches. `context` sets the unified context-line count; `maxBytes` caps the total diff bytes returned (over-cap diffs are truncated with a notice, later commits omitted). Returns a warning (not an error) when the project has no codeLocation, the path is not a git repo, or no commits mention the ticket. Pass semantic:true to also get a deterministic semantic view (no LLM): formatting-only hunks stripped, files ordered core \u2192 tests \u2192 docs/config, mechanical renames flagged, plus a ready-to-use review-summary prompt \u2014 assistive, verify against the raw diff.",
    inputSchema: {
      project: z.string(),
      ticket: z.string(),
      maxCommits: z.coerce.number().int().min(1).max(100).optional().describe("Max commits to inspect (default 20)."),
      context: z.coerce.number().int().min(0).max(20).optional().describe("Unified diff context lines (default 3)."),
      maxBytes: z.coerce.number().int().min(1000).max(500000).optional().describe("Total diff byte cap across commits (default 60000)."),
      semantic: z.coerce.boolean().optional().describe("Add a deterministic semantic view: formatting-only hunks stripped, files ordered core \u2192 tests \u2192 docs/config, mechanical renames flagged, plus a review-summary prompt (assistive \u2014 verify against the raw diff)."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, ticket, maxCommits, context, maxBytes, semantic }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return getTicketDiff(board, project, ticket, { maxCommits, context, maxBytes, semantic });
  })
);

server.registerTool(
  "add_review_comment",
  {
    title: "Add review comment",
    description:
      "Attach a PR-style review comment to a ticket (optionally anchored to a file and line). Unresolved review comments surface in the ticket's next work packet (get_work_packet.reviewComments) so the next agent acts on the feedback, and — when the ticket is in Review — a comment sends it back into next_task's queue. Also recorded on the ticket's audit history.",
    inputSchema: {
      project: z.string(),
      ticket: z.string(),
      comment: z.string().describe("The review feedback."),
      author: z.string().optional().describe("Who left the comment."),
      file: z.string().optional().describe("File the comment refers to."),
      line: z.coerce.number().int().optional().describe("Line number the comment refers to."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, ticket, comment, author, file, line }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    const rec = addReviewComment(board, project, ticket, { comment, author, file, line });
    try {
      appendEvent(board, project, { ticket, field: "review_comment", from: null, to: `${rec.id}: ${rec.comment.slice(0, 80)}`, source: "add_review_comment" });
    } catch {}
    return rec;
  })
);

server.registerTool(
  "list_review_comments",
  {
    title: "List review comments",
    description:
      "List review comments for a project, optionally scoped to one ticket, with their resolved state. Set includeResolved:false to see only open feedback.",
    inputSchema: {
      project: z.string(),
      ticket: z.string().optional().describe("Scope to one ticket (omit for the whole project)."),
      includeResolved: z.boolean().optional().describe("Include resolved comments (default true)."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, ticket, includeResolved }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    const comments = listReviewComments(board, project, ticket || null, { includeResolved: includeResolved !== false });
    return { project, ticket: ticket || null, count: comments.length, unresolved: comments.filter((c) => !c.resolved).length, comments };
  })
);

server.registerTool(
  "resolve_review_comment",
  {
    title: "Resolve review comment",
    description:
      "Mark a review comment resolved by its id (RC-<n>). Idempotent. Once every comment on a ticket is resolved it stops surfacing in the work packet and (if in Review) leaves next_task's queue.",
    inputSchema: {
      project: z.string(),
      id: z.string().describe("The review comment id, e.g. RC-3."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  writeTool(({ project, id }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    const rec = resolveReviewComment(board, project, id);
    try {
      appendEvent(board, project, { ticket: rec.ticket, field: "review_comment_resolved", from: rec.id, to: "resolved", source: "resolve_review_comment" });
    } catch {}
    return rec;
  })
);

}
