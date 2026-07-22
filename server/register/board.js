// Auto-extracted from server/index.js (FBMCPF-224). Registration blocks moved verbatim.
export function registerBoardTools(server, ctx) {
  const { BOARD_HTML_PATH, RAG_EXPLORER_HTML_PATH, Board, applyStandard, steerProject, getSteeringStatus, resolveStandard, standardPacketBlock, StatusEnum, applyTriage, autoAssignSprintFields, blendStatus, compactView, completedAtForTask, computeWaves, createFeedbackTickets, estimateTicketMinutes, evaluateRules, extractBoardToolNames, fail, fullView, getBoard, getGlobalConfig, isBlocked, meta, notifySlack, parseFeedback, parseImport, parsePmImport, readFileSync, sprintOfTask, suggestModel, ticketsWithUnresolvedReviews, tryTool, withOrchestrationLabels, writeTool, z } = ctx;

// projects -----------------------------------------------------------------

server.registerTool(
  "list_projects",
  {
    title: "List projects",
    description: "List all boards (projects) under the configured boards folder.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(() => ({ projects: getBoard().listProjects() }))
);

server.registerTool(
  "get_board",
  {
    title: "Open the board (UI)",
    description:
      "Return the FeatureBoard board UI as a self-contained HTML document, ready to render as a Cowork artifact. " +
      "This is THE way to satisfy any natural-language request to see the board — \"open/show the board\", \"show the featureboard\", " +
      "\"what's on my plate\", \"how are we looking\", \"give me a status\", \"show velocity/analytics\". " +
      "Do NOT hand-write your own board: take the returned `html`, write it to a file, and pass it to create_artifact " +
      "(use artifact id \"featureboard-board\"; if a board artifact is already open, reuse it via update_artifact instead of creating a duplicate). " +
      "Use the `mcp_tools` array in this response VERBATIM as the artifact's mcp_tools (do not hand-pick tools from memory — " +
      "the board's buttons and analytics dashboard call back into exactly these tools, and any you omit will fail with " +
      "\"not in this artifact's mcp_tools allowlist\").",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(() => {
    const html = readFileSync(BOARD_HTML_PATH, "utf8");
    const mcp_tools = extractBoardToolNames(html).map((name) => "mcp__FeatureBoard__" + name);
    return {
      artifactId: "featureboard-board",
      filename: "board.html",
      bytes: Buffer.byteLength(html, "utf8"),
      mcp_tools,
      render:
        "Write `html` to a file, then call create_artifact with id \"featureboard-board\" " +
        "(or update_artifact if a board artifact is already open), passing this response's `mcp_tools` array verbatim " +
        "as the artifact's mcp_tools param so the board's buttons and analytics can call back into this server.",
      html,
    };
  })
);

server.registerTool(
  "get_rag_explorer",
  {
    title: "Open the research RAG explorer (UI)",
    description:
      "Return the Research RAG Explorer UI as a self-contained HTML document, ready to render as a Cowork artifact — " +
      "the visual front door to the local research RAG (FBMCPF-263/264). It lets the user browse a board's kb/ docs " +
      "(including per-ticket research briefs), add new docs (add_kb_doc), and query the BM25 index (rag_search over kb + " +
      "repo docs/ + Done-ticket summaries, with a search_kb fallback). Use this for natural-language asks like " +
      "\"show/open the RAG\", \"what's in the knowledge base\", \"let me query the research index\". Do NOT hand-write " +
      "your own explorer: take the returned `html`, write it to a file, and pass it to create_artifact (use artifact id " +
      "\"featureboard-rag-explorer\"; if one is already open, reuse it via update_artifact). Use the `mcp_tools` array in " +
      "this response VERBATIM as the artifact's mcp_tools — any tool you omit fails with \"not in this artifact's " +
      "mcp_tools allowlist\".",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(() => {
    const html = readFileSync(RAG_EXPLORER_HTML_PATH, "utf8");
    const mcp_tools = extractBoardToolNames(html).map((name) => "mcp__FeatureBoard__" + name);
    return {
      artifactId: "featureboard-rag-explorer",
      filename: "rag-explorer.html",
      bytes: Buffer.byteLength(html, "utf8"),
      mcp_tools,
      render:
        "Write `html` to a file, then call create_artifact with id \"featureboard-rag-explorer\" " +
        "(or update_artifact if it is already open), passing this response's `mcp_tools` array verbatim " +
        "as the artifact's mcp_tools param so the explorer's panels can call back into this server.",
      html,
    };
  })
);

server.registerTool(
  "set_standard",
  {
    title: "Set the project standard (rigor profile)",
    description:
      "Set — and LOCK — how much rigor a project's work is held to. Levels: \"prototype\" (move fast, minimal ceremony), " +
      "\"standard\" (normal professional loop), \"polished\" (research-first: competitor teardowns, layout/IA of comparable apps, " +
      "white papers, UX/UI heuristics, automation-everywhere, high test rigor + self-review). The resolved standard is injected " +
      "into every work packet (packet.standard + extra definition-of-done items) and bends research-on-intake (polished forces " +
      "it on with expanded questions; prototype skips it). `mandate` is the project's own free-text bar, carried verbatim into packets. " +
      "INFERENCE RULE: when a project's standard is unset/unlocked, infer the level from the user's cues ONCE (pass source:\"inferred\") " +
      "and lock it. A locked standard is settled — this tool refuses to change it unless force:true, which you pass ONLY when the user " +
      "explicitly asks to change the standard. Account-wide default for unset projects: set_global_config defaultStandard.",
    inputSchema: {
      project: z.string(),
      level: z.enum(["prototype", "standard", "polished"]),
      mandate: z.string().optional().describe("Project-specific bar in the user's words, e.g. 'research competitors + whitepapers + UX guides; automate everywhere; highly polished engineering standard'."),
      source: z.enum(["user", "inferred"]).optional().describe("Who decided: the user explicitly (default), or inferred once from conversation cues."),
      force: z.boolean().optional().describe("Override a LOCKED standard. Pass ONLY when the user explicitly asked to change it."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  writeTool(({ project, level, mandate, source, force }) => {
    const board = getBoard();
    const cfg = meta.getProjectConfig(board, project);
    const result = applyStandard(cfg.standard, { level, mandate, source: source || "user", locked: true }, { force: !!force });
    if (!result.applied) {
      return { ...result, effective: standardPacketBlock(resolveStandard(cfg.standard)) };
    }
    meta.setProjectConfig(board, project, { standard: result.standard });
    return { ...result, effective: standardPacketBlock(result.standard) };
  })
);

server.registerTool(
  "steer_project",
  {
    title: "Steer the project (next wave when the queue runs dry)",
    description:
      "FBMCPF-317: the churn loop's answer to an empty queue — call this when next_task returns nothing (or the user asks to " +
      "'keep improving'). Returns ordered, executable passes that encode the owner's steering pattern: (1) REVIEW the Done " +
      "tickets completed since the last steering pass — adversarial defect hunt over their diffs (get_ticket_diff semantic:true, " +
      "churn_reconcile), file log_bug for real defects; (2) TIGHTEN — triage the attached cleanup/strengthen findings into tickets " +
      "or dismissals; (3) RESEARCH toward the project's `goal` at its locked standard (polished standards carry the " +
      "competitor/layout/whitepaper/UX question set) grounded in rag_search prior art, then add_feature the next wave; (4) RESUME " +
      "next_task. Review candidates are claimed in steering.json so the same work is never re-reviewed. If `actionable` is false " +
      "twice in a row, report to the user and stop — do not spin. Pass dryRun:true to preview without claiming.",
    inputSchema: {
      project: z.string(),
      dryRun: z.boolean().optional().describe("Preview the passes without marking the review candidates as claimed."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, dryRun }) => {
    const res = steerProject(getBoard(), project, { dryRun: !!dryRun });
    // FBMCPF-320: best-effort steering digest to Slack. notifySlack self-gates
    // on slackWebhook + slackEvents "summary", so this is a no-op unless the
    // project opted in; fire-and-forget so it never blocks or breaks the pass.
    if (!dryRun && res && res.digest) {
      Promise.resolve(notifySlack(getBoard(), project, { text: res.digest, event: "summary" })).catch(() => {});
    }
    return res;
  }),
);

server.registerTool(
  "get_steering_status",
  {
    title: "Steering status (observability, no pass)",
    description:
      "FBMCPF-319: read-only observability into the steering loop for a project — WITHOUT running or mutating a pass (unlike steer_project). " +
      "Returns the persisted steering.json state (lastSteeringAt, everSteered, how many Done tickets have been claimed/reviewed + the recent " +
      "reviewed ids, and goalOnlyStreak — the consecutive goal-only passes that gate the auto-stop) plus a live snapshot: goal/goalMissing, " +
      "open-ticket count, how many Done tickets are still unreviewed, and the tickets filed since the last steering pass (a proxy for what the " +
      "last pass produced). Use it to answer 'where is steering at?' without kicking off a new wave.",
    inputSchema: { project: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project }) => getSteeringStatus(getBoard(), project)),
);

server.registerTool(
  "create_project",
  {
    title: "Create project",
    description:
      "Create a new board folder with empty featurelist.md and buglist.md. Returns the derived ticket prefix.",
    inputSchema: {
      name: z.string().describe("Project/board name (also the folder name)."),
      description: z.string().optional().describe("Optional one-line description stored atop featurelist.md."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ name, description }) => getBoard().createProject(name, description))
);

// reading ------------------------------------------------------------------

server.registerTool(
  "list_tasks",
  {
    title: "List tasks",
    description:
      "List features and/or bugs on a board, most-recent first. Filter by type, status, product, label, or search. " +
      "Returns a compact one-line-per-ticket view by default and is paginated (limit/offset) so large boards don't blow the context budget — " +
      "set compact:false for full details, and raise limit or page with offset to see more. Use get_metrics for a pure overview.",
    inputSchema: {
      project: z.string(),
      type: z.enum(["all", "feature", "bug"]).optional().default("all"),
      status: StatusEnum.optional(),
      product: z.string().optional(),
      label: z.string().optional(),
      sprint: z.string().optional().describe('Filter to tickets in this sprint (sprint:<name> label); pass "none" for tickets not in any sprint.'),
      search: z.string().optional(),
      ref: z.string().optional().describe("Filter to tickets carrying this external reference id."),
      limit: z.number().int().min(1).max(500).optional().default(50),
      offset: z.number().int().min(0).optional().default(0),
      compact: z.boolean().optional().default(true).describe("One-line summaries; set false for full task objects."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, limit, offset, compact, ref, sprint, ...filters }) => {
    let all = getBoard().listTasks(project, filters);
    if (ref) all = all.filter((t) => (t.ref || "") === ref);
    if (sprint) {
      const want = sprint.toLowerCase();
      all = all.filter((t) => {
        const s = (sprintOfTask(t) || "").toLowerCase();
        return want === "none" ? !s : s === want;
      });
    }
    const total = all.length;
    const page = all.slice(offset, offset + limit);
    const tasks = page.map(compact ? compactView : fullView);
    return {
      project,
      total,
      returned: tasks.length,
      offset,
      limit,
      truncated: offset + limit < total,
      tasks,
    };
  })
);

server.registerTool(
  "get_task",
  {
    title: "Get task",
    description: "Get the full details of a single task by its ticket ID (e.g. FBF-12).",
    inputSchema: { project: z.string(), ticket: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, ticket }) => {
    const board = getBoard();
    const t = board.getTask(project, ticket);
    if (!t) throw new Error(`Task ${ticket} not found in "${project}".`);
    const view = fullView(t);
    // FBMCPF-164: expose the EXACT completion moment, derived from the Done
    // audit event / work log (never stored in the markdown, which keeps
    // [Completed] date-only). Lets a caller show precise done-time without a
    // full get_timeline_data pass. Omitted for tickets that aren't finished.
    if (t.status === "Done") {
      const { completedAt, completedSource } = completedAtForTask(board, project, t);
      if (completedAt) {
        view.completedAt = completedAt;
        view.completedAtSource = completedSource;
      }
    }
    return view;
  })
);

// creating -----------------------------------------------------------------

const addFields = {
  project: z.string(),
  title: z.string(),
  description: z.string().optional(),
  dueDate: z.string().optional().describe("YYYY-MM-DD"),
  product: z.string().optional(),
  labels: z.array(z.string()).optional(),
  linkedIssue: z.string().optional().describe("Ticket ID of a related task, e.g. FBB-3"),
  ref: z
    .string()
    .optional()
    .describe("External reference id this ticket maps to, e.g. a plan item WI-1.2. Stored as [Ref: …]."),
  priority: z
    .number()
    .int()
    .optional()
    .describe("Manual priority rank; 1 = highest. Lower sorts first; unset sorts last."),
  attachments: z.array(z.string()).optional().describe("File paths or URLs attached to this ticket."),
  newFile: z
    .boolean()
    .optional()
    .describe("Original 'new file' flag: build this feature in a new file. Stored as [NewFile: …]."),
  website: z
    .string()
    .optional()
    .describe("A website/URL this ticket relates to. Stored as [Website: …]."),
};

server.registerTool(
  "add_feature",
  {
    title: "Add feature",
    description: "Add a feature to a board's featurelist.md. Returns the new ticket (FBF-###).",
    inputSchema: addFields,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, ...f }) => {
    const board = getBoard();
    // FBMCPF-214: triage intelligence — fill missing product/priority from similar past tickets.
    const tri = applyTriage(board.listTasks(project, {}), f);
    const spr = autoAssignSprintFields(board, project, tri.fields); // FBMCPF-219
    const created = board.addTask(project, "feature", withOrchestrationLabels("feature", spr.fields));
    // FBMCPF-196: fire ticket-created automation rules (best-effort).
    const auto = evaluateRules(board, project, { trigger: "ticket-created", ticket: created.ticketNumber }, { notify: (text) => notifySlack(board, project, { text, event: "summary" }) });
    if (!auto.applied.length && !auto.warnings.length && !tri.triage) return created;
    const view = fullView(board.getTask(project, created.ticketNumber));
    if (auto.applied.length) view.automations = auto.applied;
    if (auto.warnings.length) view.warnings = auto.warnings;
    if (tri.triage) view.triage = tri.triage;
    return view;
  })
);

server.registerTool(
  "log_bug",
  {
    title: "Log bug",
    description: "Log a bug to a board's buglist.md. Returns the new ticket (FBB-###).",
    inputSchema: addFields,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, ...f }) => {
    const board = getBoard();
    // FBMCPF-214: triage intelligence — fill missing product/priority from similar past tickets.
    const tri = applyTriage(board.listTasks(project, {}), f);
    const spr = autoAssignSprintFields(board, project, tri.fields); // FBMCPF-219
    const created = board.addTask(project, "bug", withOrchestrationLabels("bug", spr.fields));
    // FBMCPF-196: fire ticket-created automation rules (best-effort).
    const auto = evaluateRules(board, project, { trigger: "ticket-created", ticket: created.ticketNumber }, { notify: (text) => notifySlack(board, project, { text, event: "summary" }) });
    if (!auto.applied.length && !auto.warnings.length && !tri.triage) return created;
    const view = fullView(board.getTask(project, created.ticketNumber));
    if (auto.applied.length) view.automations = auto.applied;
    if (auto.warnings.length) view.warnings = auto.warnings;
    if (tri.triage) view.triage = tri.triage;
    return view;
  })
);

server.registerTool(
  "add_features_bulk",
  {
    title: "Add features (bulk / brainstorm)",
    description:
      "Add several features at once. Use this after brainstorming: you generate the ideas, this persists them. Returns the created tickets.",
    inputSchema: {
      project: z.string(),
      features: z
        .array(
          z.object({
            title: z.string(),
            description: z.string().optional(),
            dueDate: z.string().optional(),
            product: z.string().optional(),
            labels: z.array(z.string()).optional(),
            ref: z.string().optional(),
            priority: z.coerce.number().int().optional(),
            newFile: z.boolean().optional(),
            website: z.string().optional(),
          })
        )
        .min(1),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, features }) => {
    const board = getBoard();
    const created = features.map((f) => board.addTask(project, "feature", withOrchestrationLabels("feature", f)));
    return { created };
  })
);

server.registerTool(
  "import_tasks",
  {
    title: "Import tasks",
    description:
      "Import a backlog from raw text into a board. Accepts a markdown checklist (- [ ] Title: desc), CSV (with a header row: title, description, product, priority, type, due, labels, status), or a JSON array/object ({features:[…], bugs:[…]} or a flat array). Format is auto-detected. Set dryRun to preview the parsed tasks without writing them.",
    inputSchema: {
      project: z.string(),
      content: z.string().describe("Raw backlog: markdown checklist, CSV (with header), or JSON."),
      format: z.enum(["auto", "markdown", "csv", "json", "auto-pm"]).optional().default("auto").describe('"auto-pm" maps Linear/Jira CSV exports (statuses, priorities, labels, refs).'),
      defaultType: z.enum(["feature", "bug"]).optional().default("feature").describe("Type for rows that don't specify one."),
      dryRun: z.boolean().optional().default(false).describe("Parse and return the tasks without creating them."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, content, format, defaultType, dryRun }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    const parsed = format === "auto-pm" ? parsePmImport(content) : parseImport(content, format);
    if (!parsed.length) throw new Error("No tasks found in the provided content.");
    if (dryRun) return { project, dryRun: true, parsed: parsed.length, tasks: parsed };
    const created = parsed.map((t) => {
      const { type, status, ...fields } = t;
      const resolvedType = type === "bug" ? "bug" : defaultType || "feature";
      const task = board.addTask(project, resolvedType, withOrchestrationLabels(resolvedType, fields));
      if (status && status !== "Todo") {
        try { return board.setStatus(project, task.ticketNumber, status); } catch { return task; }
      }
      return task;
    });
    return { project, imported: created.length, created };
  })
);

// FBMCPF-140: validate_feedback — raw feedback (user notes, review comments, bug
// reports) -> candidate tickets via deterministic keyword heuristics (no model
// calls in the server). Dry-run by default; apply:true bulk-creates via the same
// board.addTask() path as add_features_bulk/plan_work.
server.registerTool(
  "validate_feedback",
  {
    title: "Validate feedback (raw text -> candidate tickets)",
    description:
      "Parse unstructured feedback (user notes, review comments, bug reports) into candidate tickets, each with a suggested type (feature/bug), product, and priority from deterministic keyword heuristics only — no model calls. DRY-RUN BY DEFAULT (apply:false, the default): returns the structured candidate list for you to review/edit; creates NOTHING. Always dry-run first. When ready, call again with apply:true to bulk-create the candidates (optionally pass back an edited `candidates` array — e.g. from the dry-run response with corrected type/product/priority/title — instead of re-parsing `feedback`).",
    inputSchema: {
      project: z.string(),
      feedback: z.string().optional().describe("Raw freeform feedback text to parse (bullets, numbered items, or paragraphs). Required for a dry-run, and for apply mode unless `candidates` is supplied."),
      apply: z.boolean().optional().default(false).describe("false (default) = dry-run preview only, nothing created. true = bulk-create the candidates."),
      candidates: z
        .array(
          z.object({
            title: z.string(),
            description: z.string().optional(),
            type: z.enum(["feature", "bug"]).optional(),
            product: z.string().optional(),
            priority: z.coerce.number().int().optional(),
            labels: z.array(z.string()).optional(),
          })
        )
        .optional()
        .describe("Edited candidate list to create instead of re-parsing `feedback` (apply mode only) — typically the dry-run's `candidates` array with corrections."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, feedback, apply, candidates }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);

    if (!apply) {
      if (!feedback || !feedback.trim()) throw new Error("`feedback` text is required for a dry-run preview.");
      const cfg = meta.getProjectConfig(board, project);
      const parsed = parseFeedback(feedback, cfg.products);
      return {
        project,
        mode: "dry-run",
        parsedCount: parsed.length,
        candidates: parsed,
        note: "Nothing was created. Review/edit the candidates, then call again with apply:true (optionally passing this candidates array back, edited) to bulk-create.",
      };
    }

    const toCreate = Array.isArray(candidates) && candidates.length
      ? candidates
      : parseFeedback(feedback || "", meta.getProjectConfig(board, project).products);
    if (!toCreate.length) throw new Error("No candidates to create — provide `feedback` text or a `candidates` array.");
    const created = createFeedbackTickets(board, project, toCreate);
    return { project, mode: "apply", created: created.length, tickets: created };
  })
);

server.registerTool(
  "plan_work",
  {
    title: "Plan work (break a request onto the board)",
    description:
      "Turn a user request into board items in one step. Optionally creates the project, then adds the features and bugs you list. Use this as the FIRST step when starting a substantive request, then work the tickets one at a time. Returns all created tickets. When the project config etaHints is on (default), each created ticket carries an `eta` estimate and the response carries a `totalEta` roll-up (FBMCPF-269).",
    inputSchema: {
      project: z.string().describe("Board to add to. If it does not exist and createProject is true, it is created."),
      createProject: z.boolean().optional().default(false),
      projectDescription: z.string().optional(),
      features: z
        .array(
          z.object({
            title: z.string(),
            description: z.string().optional(),
            dueDate: z.string().optional(),
            product: z.string().optional(),
            labels: z.array(z.string()).optional(),
            ref: z.string().optional(),
            priority: z.coerce.number().int().optional(),
            newFile: z.boolean().optional(),
            website: z.string().optional(),
            dependsOn: z.array(z.number().int().min(0)).optional().describe("Indices into the COMBINED created list (features first, then bugs, in input order) that must finish before this item. Each becomes a blockedBy edge; out-of-range, self, or cycle-closing indices are skipped with a per-item warning."),
          })
        )
        .optional()
        .default([]),
      bugs: z
        .array(
          z.object({
            title: z.string(),
            description: z.string().optional(),
            dueDate: z.string().optional(),
            product: z.string().optional(),
            labels: z.array(z.string()).optional(),
            ref: z.string().optional(),
            priority: z.coerce.number().int().optional(),
            newFile: z.boolean().optional(),
            website: z.string().optional(),
            dependsOn: z.array(z.number().int().min(0)).optional().describe("Indices into the COMBINED created list (features first, then bugs, in input order) that must finish before this item. Each becomes a blockedBy edge; out-of-range, self, or cycle-closing indices are skipped with a per-item warning."),
          })
        )
        .optional()
        .default([]),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, createProject, projectDescription, features, bugs }) => {
    const board = getBoard();
    let created_project = false;
    if (!board.projectExists(project)) {
      if (!createProject) throw new Error(`Project "${project}" not found. Pass createProject:true to create it.`);
      board.createProject(project, projectDescription);
      created_project = true;
    }
    const createdFeatures = features.map((f) => board.addTask(project, "feature", withOrchestrationLabels("feature", autoAssignSprintFields(board, project, f).fields)));
    const createdBugs = bugs.map((b) => board.addTask(project, "bug", withOrchestrationLabels("bug", autoAssignSprintFields(board, project, b).fields)));
    // FBMCPF-137: wire dependsOn edges over the COMBINED created list (features
    // first, then bugs, in input order), then compute execution waves. A bad or
    // cycle-closing edge is skipped with a per-item warning, never failing the call.
    const items = [...features, ...bugs];
    const createdAll = [...createdFeatures, ...createdBugs];
    const tickets = createdAll.map((t) => t.ticketNumber);
    const edges = [];
    const warnings = [];
    for (let i = 0; i < items.length; i++) {
      const deps = items[i] && items[i].dependsOn;
      if (!Array.isArray(deps) || !deps.length) continue;
      const ticket = tickets[i];
      const blockers = [];
      for (const d of deps) {
        if (!Number.isInteger(d) || d < 0 || d >= tickets.length) {
          warnings.push(`${ticket}: dependsOn index ${d} is out of range (0..${tickets.length - 1}) — skipped.`);
          continue;
        }
        if (d === i) {
          warnings.push(`${ticket}: cannot depend on itself — skipped.`);
          continue;
        }
        const b = tickets[d];
        if (!blockers.includes(b)) blockers.push(b);
      }
      if (!blockers.length) continue;
      try {
        board.updateTask(project, ticket, { blockedBy: blockers });
        edges.push({ ticket, blockedBy: blockers });
      } catch (e) {
        warnings.push(`${ticket}: dependency edge rejected (${e.message}) — left unblocked.`);
      }
    }
    const executionPlan = { waves: computeWaves(tickets, edges), edges };
    if (warnings.length) executionPlan.warnings = warnings;

    // FBMCPF-269: etaHints defaults ON (see CONFIG_KEYS in metadata.js) — attach
    // a per-ticket eta to every newly-created ticket plus a totalEta roll-up
    // (sum of every ticket's low/high) so the human sees the size of the whole
    // batch up front, not just ticket-by-ticket as next_task serves them.
    const cfg = meta.getProjectConfig(board, project);
    let resultFeatures = createdFeatures, resultBugs = createdBugs, totalEta;
    if (cfg.etaHints !== false && createdAll.length) {
      const etaByTicket = new Map(createdAll.map((t) => [t.ticketNumber, estimateTicketMinutes(board, project, t.ticketNumber)]));
      resultFeatures = createdFeatures.map((t) => ({ ...t, eta: etaByTicket.get(t.ticketNumber) }));
      resultBugs = createdBugs.map((t) => ({ ...t, eta: etaByTicket.get(t.ticketNumber) }));
      const totals = [...etaByTicket.values()].reduce(
        (acc, e) => ({ low: acc.low + e.estimatedMinutes.low, high: acc.high + e.estimatedMinutes.high }),
        { low: 0, high: 0 }
      );
      totalEta = { estimatedMinutes: totals, ticketCount: etaByTicket.size };
    }

    return { project, created_project, features: resultFeatures, bugs: resultBugs, executionPlan, ...(totalEta ? { totalEta } : {}) };
  })
);

server.registerTool(
  "next_task",
  {
    title: "Next task to work",
    description:
      "Return the next open ticket to work (status Todo or In Progress), so you can pull work one item at a time. Prefers In Progress, then earliest due date, then oldest ticket. Returns null when the board is clear. When the project config etaHints is on (default), also carries an `eta` estimate for the returned ticket (FBMCPF-269).",
    inputSchema: {
      project: z.string(),
      type: z.enum(["all", "feature", "bug"]).optional().default("all"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, type }) => {
    const board = getBoard();
    const openAll = board.listTasks(project, { type }).filter((t) => t.status !== "Done");
    if (!openAll.length) return { next: null, remaining: 0 };
    // FBMCPF-135: tickets sitting in Review are awaiting the reviewer, not the next
    // agent — skip them, UNLESS they carry unresolved review comments, which means
    // the reviewer sent feedback back for the agent to act on (FBMCPF-134 gate).
    let reviewBacklog = new Set();
    try { reviewBacklog = ticketsWithUnresolvedReviews(board, project); } catch {}
    const awaitingReview = (t) => t.status === "Review" && !reviewBacklog.has(t.ticketNumber);
    // FBMCPF-133: blocked tickets stay in the queue but are not served.
    const open = openAll.filter((t) => !isBlocked(board, project, t) && !awaitingReview(t));
    const blockedSkipped = openAll.filter((t) => isBlocked(board, project, t)).length;
    const reviewSkipped = openAll.filter((t) => !isBlocked(board, project, t) && awaitingReview(t)).length;
    if (!open.length) {
      return { next: null, remaining: openAll.length, ...(blockedSkipped ? { blockedSkipped } : {}), ...(reviewSkipped ? { reviewSkipped } : {}) };
    }
    const rank = (t) => (t.status === "In Progress" ? 0 : 1);
    const prio = (t) => (t.priority != null ? t.priority : Infinity);
    const dueVal = (t) => (t.dueDate ? Date.parse(t.dueDate) || Infinity : Infinity);
    const num = (t) => parseInt((t.ticketNumber || "").replace(/\D+/g, ""), 10) || 0;
    open.sort((a, b) => rank(a) - rank(b) || prio(a) - prio(b) || dueVal(a) - dueVal(b) || num(a) - num(b));
    const sm = suggestModel(open[0]); // FBMCPF-125: model tiering hint
    // FBMCPF-269: etaHints defaults ON (see CONFIG_KEYS in metadata.js) —
    // resolved once here so both the dispatch instruction sentence and the
    // eta field it promises stay in sync.
    const cfg = meta.getProjectConfig(board, project);
    const etaHintsOn = cfg.etaHints !== false;
    // FBMCPF-278: account-wide plan-meter blend, when captured — steers the
    // dispatch sentence toward the hotter meter. Best-effort; never blocks.
    let blend = null;
    try { blend = blendStatus(getGlobalConfig(board), new Date()); } catch { blend = null; }
    // FBMCPF-236: dispatch directive — makes sub-agent fan-out the default
    // reading of next_task's result, same as get_work_packet.
    const dispatch = meta.buildDispatchDirective(open[0], { blocked: isBlocked(board, project, open[0]), etaHints: etaHintsOn, blend });
    const res = { next: fullView(open[0]), remaining: openAll.length, suggestedModel: sm.model, modelBasis: sm.basis, dispatch };
    if (etaHintsOn) res.eta = estimateTicketMinutes(board, project, open[0].ticketNumber);
    if (blockedSkipped) res.blockedSkipped = blockedSkipped;
    if (reviewSkipped) res.reviewSkipped = reviewSkipped;
    return res;
  })
);

// mutating -----------------------------------------------------------------

server.registerTool(
  "update_task",
  {
    title: "Update task",
    description: "Update fields on an existing task. Only provided fields change.",
    inputSchema: {
      project: z.string(),
      ticket: z.string(),
      title: z.string().optional(),
      description: z.string().optional(),
      dueDate: z.string().nullable().optional().describe("YYYY-MM-DD, or null to clear"),
      product: z.string().nullable().optional(),
      labels: z.array(z.string()).optional(),
      linkedIssue: z.string().nullable().optional(),
      ref: z.string().nullable().optional().describe("External reference id, or null to clear."),
      priority: z.coerce.number().int().nullable().optional().describe("Manual priority rank (1 = highest), or null to clear."),
      attachments: z.array(z.string()).optional().describe("Replace the attachment list on this ticket."),
      newFile: z.boolean().nullable().optional().describe("'New file' flag, or null to clear."),
      website: z.string().nullable().optional().describe("Associated website/URL, or null to clear."),
      blockedBy: z.array(z.string()).nullable().optional().describe("Ticket ids that block this one (empty array or null clears). Adding an edge that closes a loop is rejected."),
      verbose: z.boolean().optional().describe("Return the full ticket view (description, labels, attachments, dates, ...) instead of the default compact ack."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  writeTool(({ project, ticket, verbose, ...fields }) => {
    const result = getBoard().updateTask(project, ticket, fields);
    return verbose ? result : meta.compactAck(result, { updated: true });
  })
);

}
