// Auto-extracted from server/index.js (FBMCPF-224). Registration blocks moved verbatim.
export function registerAnalyticsTools(server, ctx) {
  const { Board, addKbDoc, agentMonitorV2, appendEvent, appendHeartbeat, applyDriftRemediation, driftReport, existsSync, getBoard, getGitConfig, getHistoryMap, getKbDoc, getLiveActivity, getLatestUpdate, getPricing, getVoiceProfile, lastDispatchForTicket, lintVoice, listKbDocs, listSprints, maybeLint, meta, nodePath, postProjectUpdate, predictDueDates, reconcileChurn, recordDriftScore, rollupCost, prepareResearch, ragSearch, searchKb, setSite, startDriftRun, suggestHistoricalFiles, tryTool, writeTool, z } = ctx;

// analytics & metadata (v0.3) ----------------------------------------------

server.registerTool(
  "get_metrics",
  {
    title: "Get metrics",
    description:
      "Read-only snapshot: feature/bug counts by status, completions by date, and velocity from the work log (tokens, additions/deletions, active days, recent tokens, and $ cost by model — see project config \"pricing\" to override the default Anthropic API rates).",
    inputSchema: { project: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project }) => {
    const board = getBoard();
    const base = board.getMetrics(project);
    const entries = meta.readWorkLog(board, project);
    const v = meta.velocity(entries);
    const sp = listSprints(board, project);
    // FBMCPF-157: cost rollup by model, using project-config-overridable pricing.
    const pricing = getPricing(board, project);
    const costRollup = rollupCost(entries, pricing);
    // FBMCPF-199: surface the latest narrative project update (+ staleness hint).
    let projectUpdate = null;
    try { projectUpdate = getLatestUpdate(board, project); } catch { projectUpdate = null; }
    return {
      ...base,
      ...(sp.sprints.length ? { sprints: sp.sprints, backlogOpen: sp.backlogOpen } : {}),
      velocity: {
        totals: { ...v.totals, cost: costRollup.totalCost },
        tokensLast7Days: v.tokensLast7Days,
        tokensLast30Days: v.tokensLast30Days,
        tokensByDate: v.byDate,
        byModel: costRollup.byModel,
        totalCost: costRollup.totalCost,
      },
      ...(projectUpdate && projectUpdate.latest ? { projectUpdate } : {}),
    };
  })
);

server.registerTool(
  "post_project_update",
  {
    title: "Post project update",
    description:
      "Append a dated narrative status update (Linear-style) to the project's updates.md pad — a lightweight health check-in that lives between the heavier sprint close-out reports. Takes a health flag (on-track | at-risk | off-track) and a free-text narrative. The latest update (and a staleness hint when it's more than 7 days old) is surfaced on get_metrics and get_health. When the project config voiceLint is on, the narrative is scored for AI-writing tells and the result is attached as `voice` (warn-only, never blocks the update).",
    inputSchema: {
      project: z.string(),
      health: z.enum(["on-track", "at-risk", "off-track"]),
      narrative: z.string().describe("Free-text status narrative for this update."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, health, narrative }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    const result = postProjectUpdate(board, project, { health, narrative });
    // FBMCPF-268: warn-only voice-lint self-check (opt-in via project config voiceLint).
    const voice = maybeLint(board, project, narrative);
    if (voice) result.voice = voice;
    return result;
  })
);

server.registerTool(
  "predict_due_dates",
  {
    title: "Predict due dates",
    description:
      "Estimate when open work will complete by dividing the backlog by the board's observed throughput " +
      "(tickets closed per active day). Walks the priority-ordered queue to give each open ticket a projected " +
      "completion date, suggests a due date for tickets that don't have one, and flags tickets whose existing " +
      "due date is likely to slip. Read-only — apply a suggestion with update_task if you want it stuck.",
    inputSchema: {
      project: z.string(),
      type: z.enum(["all", "feature", "bug"]).optional().default("all"),
      asOf: z.string().optional().describe("Reference date (YYYY-MM-DD) to predict from; defaults to today."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, type, asOf }) => predictDueDates(getBoard(), project, { type, asOf }))
);

server.registerTool(
  "get_project_config",
  {
    title: "Get project config",
    description:
      "Read a board's settings: products, code location, agent model, prefixes, website, description, pricing overrides. Merges MCP-managed config over the legacy project_config.json.",
    inputSchema: { project: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project }) => meta.getProjectConfig(getBoard(), project))
);

server.registerTool(
  "set_project_config",
  {
    title: "Set project config",
    description:
      "Update a board's settings (only provided fields change). Writes to the MCP-managed config; never mutates legacy project_config.json. codeLocation points the code tools at the project's source repo; websiteLocation points the website tools (get_site/set_site/add_page/deploy_site/scaffold_site/...) at the project's SHIPPED site, which may live outside the pad in its own repo (absolute path to the assets dir) — leave it unset to keep the site under <project>/site/.",
    inputSchema: {
      project: z.string(),
      products: z.array(z.string()).optional(),
      codeLocation: z.string().optional(),
      websiteLocation: z.string().optional().describe("Absolute path to the project's SHIPPED website assets dir (may be outside the pad, in its own git repo). When set, all website tools operate there instead of <project>/site/ (FBMCPF-249)."),
      agentModel: z.string().optional(),
      description: z.string().optional(),
      website: z.string().optional(),
      customPrompt: z.string().optional().describe("Project-specific guidance injected into every work packet."),
      brandTitle: z.string().optional().describe("Board display title (branding)."),
      brandSubtitle: z.string().optional().describe("Board subtitle / byline (branding)."),
      brandWords: z.array(z.string()).optional().describe("Brand / trial words woven into generated media (e.g. product name, taglines, campaign phrases)."),
      brandVoice: z.string().optional().describe("Brand voice/tone for generated media, e.g. 'confident, playful, plain-spoken'."),
      imageTool: z.string().optional().describe("Preferred image-generation tool/connector/skill name for generate_image (e.g. an image MCP or an 'imagegen' skill). If unset, generate_image uses any available image generator, else falls back to SVG."),
      requireReview: z.boolean().optional(),
      sprintAutoAssign: z.enum(["off", "priority", "all"]).optional().describe("FBMCPF-219: auto-assign un-slotted new tickets to the active sprint — off (default), priority (priority <= 2 only), or all. An explicit sprint: label always wins."),
      doneGates: z.object({
        requireResolvedReview: z.boolean().optional(),
        requirePassingTest: z.boolean().optional(),
        requireWorkLog: z.boolean().optional(),
        requirePullRequest: z.boolean().optional(),
      }).optional().describe("FBMCPF-215: per-project preconditions on → Done — require no unresolved review comments, a passing logged test run, and/or a work-log entry for the ticket. Each toggle independent, all off by default; approve:true overrides."),
      requireCommitOnDone: z.boolean().optional().describe("When on and git is enabled for the project, set_status refuses to move a ticket to Done unless a commit references it (recorded via commit_feature or found via git log --grep); approve:true overrides. Default false — a plain non-blocking uncommitted/commitReminder warning otherwise."),
      requireChecksOnDone: z.boolean().optional().describe("FBMCPF-261: when on, set_status refuses to move a ticket to Done if its latest background static-check run FAILED (approve:true overrides). A still-running run does not block — it just adds a note. Default false."),
      researchOnIntake: z.boolean().optional().describe("FBMCPF-263: run an optional research phase before implementing a ticket — cheap haiku/sonnet sub-agents collate approaches/prior-art/comparables/risks into a brief for the implementing model. Defaults ON when unset (resolved in code, not force-written). Per-ticket escape hatch: a research:off label skips it, research:on forces it."),
      ragInPackets: z.boolean().optional().describe("FBMCPF-264: attach top-k local lexical RAG chunks (BM25 over KB/docs/ticket-history) to every work packet as ragChunks. Zero tokens, zero network. Default true."),
      ragK: z.coerce.number().int().min(1).max(20).optional().describe("FBMCPF-264: how many RAG chunks to attach to a work packet (default 5)."),
      checks: z.object({
        autoOnCommit: z.boolean().optional().describe("Start checks automatically after every commit_feature (default true)."),
        syntaxCheckChangedFiles: z.boolean().optional().describe("node --check each changed .js/.mjs/.cjs file (default true)."),
        commands: z.array(z.object({
          name: z.string(),
          command: z.string().describe("Shell command run in the code repo cwd."),
          timeoutMinutes: z.number().optional().describe("Per-command timeout in minutes (default 5)."),
        })).optional().describe("Configured static-check commands (lint, a fast test subset, impact scan, ...)."),
      }).optional().describe("FBMCPF-261: async background static-check config. Checks run DETACHED on every commit (pure CPU, zero model tokens) so the orchestrator can commit and immediately keep working, then collect results with get_check_results. When absent but the code repo has a package.json, a cheap syntax-only default applies."),
      slackWebhook: z.string().url().optional().nullable().describe("Project's https://hooks.slack.com/... webhook; null clears. Opt-in egress."),
      slackEvents: z.array(z.enum(["done", "review", "summary"])).optional().describe("Which events may post to Slack (default all three).").describe("When on, a ticket must pass through Review before it can be marked Done (set_status enforces the gate; approve:true overrides)."),
      stage: z.enum(["incubating", "graduated"]).optional().describe("Project lifecycle stage (FBMCPF-149)."),
      gitTargets: z.object({
        codeRepo: z.object({ path: z.string().optional(), remote: z.string().optional(), branch: z.string().optional() }).optional(),
        padRepo: z.object({ path: z.string().optional(), remote: z.string().optional(), branch: z.string().optional() }).optional(),
        websiteRepo: z.object({ path: z.string().optional(), remote: z.string().optional(), branch: z.string().optional() }).optional(),
      }).optional().describe("Explicit commit destinations: code, projectpad, and the shipped website can each live in different repos (FBMCPF-149, FBMCPF-249). websiteRepo is otherwise inferred by walking up from websiteLocation to its .git root."),
      pricing: z.record(
        z.string(),
        z.object({
          inputPerMTok: z.number().optional(),
          outputPerMTok: z.number().optional(),
          blendedPerMTok: z.number().optional(),
        })
      ).optional().describe(
        "FBMCPF-157: per-model $/MTok overrides merged over the built-in defaults (server/pricing.js DEFAULT_PRICING, sourced from current Anthropic API pricing). Keyed by model tier (\"fable\" | \"opus\" | \"sonnet\" | \"haiku\" | \"default\"); only the fields you provide change, the rest keep their default. blendedPerMTok is used as a fallback rate for work-log entries that only logged a single total token count (no input/output split)."
      ),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  writeTool(({ project, ...patch }) => meta.setProjectConfig(getBoard(), project, patch))
);

server.registerTool(
  "set_branding",
  {
    title: "Set project branding",
    description:
      "Set the project's brand kit in one place — name, tagline, brand words, voice/tone, primary & accent colors, logo, and font — so every generated asset (media, website, campaigns) stays consistent. Stored on the board config; retrieve it with get_branding. By default also applies colors/font to the project website if one exists.",
    inputSchema: {
      project: z.string(),
      name: z.string().optional().describe("Brand / product name (brandTitle)."),
      tagline: z.string().optional().describe("Brand tagline / byline (brandSubtitle)."),
      words: z.array(z.string()).optional().describe("Brand words/phrases to weave into copy."),
      voice: z.string().optional().describe("Voice/tone, e.g. 'confident, playful, plain-spoken'."),
      primaryColor: z.string().optional().describe("Primary brand color (hex, rgb(), hsl(), or CSS name)."),
      accentColor: z.string().optional().describe("Accent brand color."),
      logo: z.string().optional().describe("Logo URL or assets/<file> reference."),
      font: z.string().optional().describe("Brand font-family, e.g. \"Inter, system-ui, sans-serif\"."),
      applyToSite: z.boolean().optional().default(true).describe("Also apply colors/font to the project website if it exists."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  writeTool(({ project, name, tagline, words, voice, primaryColor, accentColor, logo, font, applyToSite }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    const patch = {};
    if (name != null) patch.brandTitle = name;
    if (tagline != null) patch.brandSubtitle = tagline;
    if (words != null) patch.brandWords = words;
    if (voice != null) patch.brandVoice = voice;
    if (primaryColor != null) patch.brandPrimary = primaryColor;
    if (accentColor != null) patch.brandAccent = accentColor;
    if (logo != null) patch.brandLogo = logo;
    if (font != null) patch.brandFont = font;
    meta.setProjectConfig(board, project, patch);
    const brand = meta.brandContext(board, project);
    let siteApplied = false;
    if (applyToSite !== false && (primaryColor != null || accentColor != null || font != null)) {
      const sitePath = nodePath.join(board.projectDir(project), "site", "site.json");
      if (existsSync(sitePath)) {
        setSite(board, project, {
          colors: { primary: brand.primary || undefined, accent: brand.accent || undefined },
          font: brand.font || undefined,
        });
        siteApplied = true;
      }
    }
    return { project, brand, siteApplied };
  })
);

server.registerTool(
  "get_branding",
  {
    title: "Get project branding",
    description:
      "Return the project's brand kit — name, tagline, words, voice, colors, logo, font — plus a ready-to-inject generation instruction, a CSS :root cssVars snippet for web, and which fields are still missing. Call this before generating any branded asset to stay consistent.",
    inputSchema: { project: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    const brand = meta.brandContext(board, project);
    const fields = ["title", "subtitle", "words", "voice", "primary", "accent", "logo", "font"];
    const missing = fields.filter((f) => (Array.isArray(brand[f]) ? brand[f].length === 0 : !brand[f]));
    return { project, ...brand, missing };
  })
);

server.registerTool(
  "add_product",
  {
    title: "Add product",
    description: "Add a product to a board's product list (used for tagging tickets via [Product: …]).",
    inputSchema: { project: z.string(), name: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  writeTool(({ project, name }) => meta.addProduct(getBoard(), project, name))
);

server.registerTool(
  "remove_product",
  {
    title: "Remove product",
    description: "Remove a product from a board's product list (existing ticket tags are left as-is).",
    inputSchema: { project: z.string(), name: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  writeTool(({ project, name }) => meta.removeProduct(getBoard(), project, name))
);

server.registerTool(
  "get_scratchpad",
  {
    title: "Get scratchpad",
    description:
      "Read a board's freeform scratchpad.md - a per-project notes surface for context, decisions, and reminders that Claude and the board share. Returns the raw markdown.",
    inputSchema: { project: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project }) => meta.getScratchpad(getBoard(), project))
);

server.registerTool(
  "set_scratchpad",
  {
    title: "Set scratchpad",
    description:
      "Overwrite a board's scratchpad.md with new content. Use append_scratchpad to add a note without replacing existing content.",
    inputSchema: { project: z.string(), content: z.string().describe("Full new scratchpad markdown.") },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  writeTool(({ project, content }) => meta.setScratchpad(getBoard(), project, content))
);

server.registerTool(
  "append_scratchpad",
  {
    title: "Append to scratchpad",
    description:
      "Append a line or block to a board's scratchpad.md, preserving existing notes. Mention a ticket id (e.g. FBF-12) to have it surface in that ticket's work packet.",
    inputSchema: { project: z.string(), text: z.string().describe("Text to append.") },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, text }) => meta.appendScratchpad(getBoard(), project, text))
);

/* ---------- project knowledge base (FBMCPF-141) ---------- */

server.registerTool(
  "add_kb_doc",
  {
    title: "Add/update a kb doc",
    description:
      "Write a markdown doc into a board's kb/ folder (a per-project knowledge base beyond the scratchpad): title + markdown body, stored as kb/<slugified-title>.md. Calling again with the SAME title updates that doc in place; a different title that slugifies to the same filename gets a numeric suffix instead of clobbering the original. Docs are keyword-matched into work packets automatically via get_work_packet.",
    inputSchema: {
      project: z.string(),
      title: z.string().describe("Doc title; slugified to the filename."),
      content: z.string().describe("Markdown body."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  writeTool(({ project, title, content }) => addKbDoc(getBoard(), project, title, content))
);

server.registerTool(
  "list_kb_docs",
  {
    title: "List kb docs",
    description: "List a board's kb/ docs: slug, title, updatedAt, size, and a short excerpt of each (not the full body — use get_kb_doc for that).",
    inputSchema: { project: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project }) => ({ docs: listKbDocs(getBoard(), project) }))
);

server.registerTool(
  "get_kb_doc",
  {
    title: "Get a kb doc",
    description: "Read one kb doc's full markdown content by slug (or title — it gets slugified). Returns null-ish (not found) when no such doc exists.",
    inputSchema: { project: z.string(), slug: z.string().describe("Doc slug or title.") },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, slug }) => getKbDoc(getBoard(), project, slug))
);

server.registerTool(
  "search_kb",
  {
    title: "Search kb docs",
    description:
      "Keyword search across a board's kb doc titles + content, ranked (title hits weighted above content hits). Returns matches with a short excerpt around the first hit and the doc's path. This is the same matcher get_work_packet uses to inject relevant docs into a ticket's packet (kbMatches).",
    inputSchema: {
      project: z.string(),
      query: z.string().describe("Keywords to search for."),
      limit: z.coerce.number().int().optional().default(10).describe("Max results to return."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, query, limit }) => ({ results: searchKb(getBoard(), project, query, { limit }) }))
);


/* ---------- agentic drift evaluation (FBMCPF-108) ---------- */
server.registerTool(
  "drift_start",
  {
    title: "Start a drift evaluation",
    description:
      "Begin a drift-evaluation run over a board's Done tickets. mode 'sample' evaluates a seeded random subset (fast statistical estimate); mode 'full' evaluates every Done ticket. Returns a runId + the tickets to score. Then, for each ticket, compare its scope/description/DoD + work log against the actual code it touched (use get_work_packet and the project's codeLocation) and call drift_record with a 0–100 fidelity score; finish with drift_report. Use the evaluate_drift prompt to run the whole loop.",
    inputSchema: {
      project: z.string(),
      mode: z.enum(["sample", "full"]).optional().default("sample"),
      sampleSize: z.coerce.number().int().optional().default(10).describe("How many Done tickets to sample (mode 'sample')."),
      seed: z.coerce.number().int().optional().describe("Seed for reproducible sampling; one is chosen + returned if omitted."),
      type: z.enum(["all", "feature", "bug"]).optional().default("all"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, mode, sampleSize, seed, type }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return startDriftRun(board, project, { mode, sampleSize, seed, type });
  })
);

server.registerTool(
  "drift_record",
  {
    title: "Record a drift score",
    description:
      "Record a 0–100 fidelity score for one ticket in a drift run (verdict is derived: >=80 aligned, 50–79 partial, <50 drift — or pass your own). Provide a short gap explaining any shortfall, and optionally the files you checked. Upserts by ticket.",
    inputSchema: {
      project: z.string(),
      runId: z.string().optional().describe("Drift run id (defaults to the latest run)."),
      ticket: z.string(),
      score: z.coerce.number().describe("Fidelity 0–100 of implementation vs the ticket's intent."),
      verdict: z.enum(["aligned", "partial", "drift"]).optional(),
      gap: z.string().optional().describe("What drifted / what's missing (for partial/drift)."),
      files: z.array(z.string()).optional().describe("Files/paths inspected for this ticket."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, runId, ticket, score, verdict, gap, files }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return recordDriftScore(board, project, runId, { ticket, score, verdict, gap, files });
  })
);

server.registerTool(
  "drift_report",
  {
    title: "Drift evaluation report",
    description:
      "Aggregate a drift run: per-ticket scores, mean fidelity, verdict counts, drift rate, and — for sampling — a 95% Wilson confidence interval on the true drift fraction extrapolated to the whole Done population. Lists the flagged (partial/drift) tickets worst-first with their gaps, and any pending (unscored) tickets.",
    inputSchema: { project: z.string(), runId: z.string().optional().describe("Defaults to the latest run.") },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, runId }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return driftReport(board, project, runId);
  })
);

server.registerTool(
  "drift_remediate",
  {
    title: "Apply drift remediation",
    description:
      "One-click remediation across a run's flagged tickets: action 'file_bugs' files a linked, drift-labeled bug per gap; 'reopen' moves them back to Todo; 'relabel' adds a 'drift' label. verdicts selects the bands to act on (default ['drift']). Pass dryRun:true to preview. Records what it did on the run.",
    inputSchema: {
      project: z.string(),
      runId: z.string().optional().describe("Defaults to the latest run."),
      action: z.enum(["file_bugs", "reopen", "relabel"]),
      verdicts: z.array(z.enum(["aligned", "partial", "drift"])).optional().describe("Which verdict bands to act on (default ['drift'])."),
      dryRun: z.boolean().optional().default(false),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, runId, action, verdicts, dryRun }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return applyDriftRemediation(board, project, runId, { action, verdicts, dryRun });
  })
);

server.registerPrompt(
  "evaluate_drift",
  {
    title: "Evaluate implementation drift",
    description:
      "Run a full agentic-drift evaluation: sample (or fully check) Done tickets, score how faithfully each was implemented vs its intent, report an aggregate drift rate with confidence, and offer one-click remediation.",
    argsSchema: {
      project: z.string().optional(),
      mode: z.string().optional().describe("'sample' (default, fast) or 'full'."),
      sampleSize: z.string().optional().describe("How many tickets to sample."),
    },
  },
  ({ project, mode, sampleSize } = {}) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            `Run an agentic drift evaluation${project ? ` on project "${project}"` : ""}.\n\n` +
            "Steps:\n" +
            `- Call drift_start (${mode ? `mode: ${mode}` : "mode: sample"}${sampleSize ? `, sampleSize: ${sampleSize}` : ""}) to pick the Done tickets to check. Note the runId.\n` +
            "- For EACH returned ticket, assemble the evidence: get_work_packet for its scope + definition-of-done, read its work-log entries (get_work_log), and inspect what actually changed in the project's codeLocation — prefer `git log`/`git diff` for that ticket id, and read the files it touched. Do NOT rely on the completion summary alone.\n" +
            "- Judge fidelity of the implementation vs the ticket's intent and call drift_record with a 0–100 score and, when it's not a clean match, a one-line gap explaining what's missing/wrong (and the files you checked). Bands: >=80 aligned, 50–79 partial, <50 drift.\n" +
            "- When every ticket is scored, call drift_report and present it: mean fidelity, verdict counts, the drift rate (with the confidence interval + population estimate for a sample), and the flagged tickets worst-first with their gaps.\n" +
            "- Then offer remediation and, if the user picks one, run it automatically via drift_remediate: 'file_bugs' (a linked bug per gap), 'reopen' (send drifted tickets back to Todo), or 'relabel'. Default to acting on the 'drift' band; confirm scope before writing.",
        },
      },
    ],
  })
);

server.registerTool(
  "log_work",
  {
    title: "Log work",
    description:
      "Append a work event to the board's work log: a summary plus optional tokens, additions/deletions, and model, tied to a ticket. Feeds velocity and health.",
    inputSchema: {
      project: z.string(),
      summary: z.string(),
      ticket: z.string().optional(),
      tokens: z.number().int().optional(),
      inputTokens: z.number().int().optional(),
      outputTokens: z.number().int().optional(),
      additions: z.number().int().optional(),
      deletions: z.number().int().optional(),
      model: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, ...entry }) => {
    const board = getBoard();
    // FBMCPB-21: warn (never block) when this looks like a double-count of a
    // set_status Done metrics line — same ticket, same day, same +/- lines.
    const dup = meta.findDuplicateWorkEntry(board, project, entry);
    const result = meta.logWork(board, project, entry);
    // FBMCPF-190: nudge for token telemetry when this event omits a token count.
    if (entry.tokens == null) result.telemetryHint = "tokens not recorded — pass tokens for accurate velocity/eval";
    if (dup) {
      result.duplicateSuspected = true;
      result.warning =
        `A work-log entry for ${entry.ticket} already recorded +${dup.additions ?? 0}/\u2212${dup.deletions ?? 0} today` +
        ` (likely from set_status Done metrics) — velocity may double-count this event. Not blocked; ignore if this was a separate work session.`;
    }
    return result;
  })
);

server.registerTool(
  "get_work_log",
  {
    title: "Get work log",
    description:
      "Read work-log entries, most-recent first. Optionally filter to one ticket. Returns entries plus a velocity rollup.",
    inputSchema: {
      project: z.string(),
      ticket: z.string().optional(),
      limit: z.number().int().min(1).max(500).optional().default(50),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, ticket, limit }) => {
    const board = getBoard();
    let entries = meta.readWorkLog(board, project);
    if (ticket) entries = entries.filter((e) => e.ticket === ticket);
    const v = meta.velocity(entries);
    entries = entries.slice().reverse().slice(0, limit);
    return { project, ticket: ticket || null, count: entries.length, velocity: v.totals, entries };
  })
);

server.registerTool(
  "get_agent_monitor",
  {
    title: "Agent monitor v2 (live sessions, stalls, spend)",
    description:
      "Live snapshot of the board's currently-running work: every In Progress ticket with elapsed time since it went " +
      "In Progress (from the ticket_events.jsonl audit log, falling back to its earliest work-log entry or createdDate " +
      "when there's no recorded status event), its last event (most recent audit event or work-log entry, whichever is " +
      "newer) with age, token spend so far vs its cap:<tokens> label and the resulting spend ratio, and a stalled flag " +
      "(no event/work-log activity within stallMinutes, default 30). Also reports costSoFar and capCost in dollars " +
      "(via project-config-overridable pricing; capCost is null when no model can be inferred for the ticket). Each " +
      "ticket also carries lastDispatch ({worker, model, parallel, note, ageMinutes}, null if record_dispatch was " +
      "never called for it) — who's actively working it, a sub-agent or the orchestrator — so the board can render an " +
      "orchestration chip without a separate call. Sorted most-recently-active first, with a top-level summary (count, " +
      "stalledCount, subAgentCount, parallelCount, totalSpend, totalCap, totalCostSoFar, totalCapCost, stalledTickets). " +
      "Pairs with churn mode: a stalled ticket mid-churn usually means the agent is stuck or has gone quiet. Use it to " +
      "see what's underway, who/what is running it, and catch stuck tickets.",
    inputSchema: {
      project: z.string(),
      stallMinutes: z.number().min(0).optional().describe("Inactivity minutes after which an In Progress ticket is flagged stalled. Defaults to 30."),
      stallHours: z.number().min(0).optional().describe("Deprecated alias for stallMinutes (converted to minutes); ignored if stallMinutes is given."),
      asOf: z.string().optional().describe("Reference time (ISO) to measure elapsed/idle against; defaults to now."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, stallMinutes, stallHours, asOf }) => agentMonitorV2(getBoard(), project, { stallMinutes, stallHours, asOf }))
);

// heartbeats (FBMCPB-15) -----------------------------------------------------
server.registerTool(
  "log_heartbeat",
  {
    title: "Log a dispatch heartbeat",
    description:
      "Append a lightweight in-flight progress ping for a ticket a sub-agent is actively working: a phase/milestone " +
      "note, and optionally the model, elapsed minutes, and tokens spent so far. Distinct from log_work (which records " +
      "a completed unit of work at the end of a session) — heartbeats are informational pings emitted DURING a long " +
      "(5-13min) dispatch, so get_agent_monitor and the board's live/stall banners have something to show besides a " +
      "generic \"multitasking\" indicator until the sub-agent returns. Call it at a few natural milestones (e.g. " +
      "\"read the ticket + adjacent code\", \"wrote the fix\", \"tests passing, writing report\") rather than on every " +
      "tool call. Sub-agents may call this directly — it is informational only and does not move the ticket's status.",
    inputSchema: {
      project: z.string(),
      ticket: z.string(),
      note: z.string().describe("Short phase/milestone description, e.g. \"reading affected files\" or \"tests passing, writing report\"."),
      model: z.string().optional().describe("Model doing the work (sonnet/opus/haiku/fable, or a full model id)."),
      elapsedMinutes: z.number().min(0).optional().describe("Minutes elapsed in this dispatch so far, if known."),
      spend: z.number().min(0).optional().describe("Tokens spent so far in this dispatch, if known."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, ticket, note, model, elapsedMinutes, spend }) => {
    const board = getBoard();
    const task = board.getTask(project, ticket);
    if (!task) throw new Error(`Ticket ${ticket} not found in "${project}".`);
    return appendHeartbeat(board, project, { ticket, note, model, elapsedMinutes, spend });
  })
);

// dispatch handoffs (FBMCPF-256) ---------------------------------------------
server.registerTool(
  "record_dispatch",
  {
    title: "Record a dispatch handoff",
    description:
      "Record who is actively working an In Progress ticket: appended as a 'dispatch' audit event " +
      "(ticket_events.jsonl), so get_agent_monitor's lastDispatch and the board UI's orchestration chip can show " +
      "whether a ticket is running on a sub-agent or back with the orchestrator. Call this right after set_status " +
      "\"In Progress\" when handing a ticket off to a fresh sub-agent — worker:\"sub-agent\", with model (sonnet/opus/" +
      "haiku/fable) and parallel:true when it's running alongside other sub-agent dispatches. Call it again with " +
      "worker:\"orchestrator\" when you take the ticket back (e.g. for review before commit) — the newest call always " +
      "wins as the ticket's current lastDispatch. Informational only: it never moves the ticket's status.",
    inputSchema: {
      project: z.string(),
      ticket: z.string(),
      worker: z.enum(["sub-agent", "orchestrator"]).describe("Who is now actively working the ticket."),
      model: z.string().optional().describe("Model doing the work (sonnet/opus/haiku/fable, or a full model id), when worker is sub-agent."),
      parallel: z.coerce.boolean().optional().describe("Whether this dispatch is running alongside other parallel sub-agent dispatches."),
      note: z.string().optional().describe("Short context, e.g. \"parity + docs\" or \"taking back for review\"."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, ticket, worker, model, parallel, note }) => {
    const board = getBoard();
    const task = board.getTask(project, ticket);
    if (!task) throw new Error(`Ticket ${ticket} not found in "${project}".`);
    appendEvent(board, project, { ticket, field: "dispatch", from: null, to: worker, source: "record_dispatch", worker, model, parallel, note });
    return { project, ticket, dispatch: lastDispatchForTicket(board, project, ticket) };
  })
);

server.registerTool(
  "get_health",
  {
    title: "Get project health",
    description:
      "Composite 0-100 health score with grade and breakdown: bug pressure, feature progress, momentum (recent tokens), and freshness (staleness of open work).",
    inputSchema: { project: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project }) => {
    const board = getBoard();
    const health = meta.computeHealth(board, project);
    // FBMCPF-191: churn accuracy — how closely logged churn matched git-actual
    // churn across Done tickets. allowGit:false keeps this read cheap (recorded
    // commit stats only, zero git shell-outs); the churn_reconcile tool does the
    // deep, live-git view. Never let reconciliation break the health read.
    try {
      const churn = reconcileChurn(board, project, { allowGit: false });
      health.churnAccuracy = churn.totals.churnAccuracy;
    } catch { /* churn reconciliation is best-effort on the health path */ }
    // FBMCPF-199: surface the latest narrative project update (+ staleness hint).
    try {
      const pu = getLatestUpdate(board, project);
      if (pu && pu.latest) health.projectUpdate = pu;
    } catch { /* project-update surfacing is best-effort */ }
    return health;
  })
);

server.registerTool(
  "churn_reconcile",
  {
    title: "Reconcile logged vs git churn",
    description:
      "For Done tickets with tagged commits, compare the additions/deletions logged in the work log against the git-actual numstat of their commits. Git-actual comes from recorded commit events (FBMCPF-188) or, failing that, a live git log --grep + numstat cached by hash. Reports per-ticket loggedAdd/loggedDel vs gitAdd/gitDel with a drift ratio (worst first), plus an overall churnAccuracy also surfaced on get_health.",
    inputSchema: { project: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project }) => reconcileChurn(getBoard(), project))
);

// FBMCPF-267: voice_lint — score text for AI-writing tells (research-backed
// ruleset in docs/VOICE-RESEARCH.md, FBMCPF-266) so an agent can self-edit its
// own outbound drafts (project updates, docs, customer replies) before
// sending. `project` is optional; when given, its voiceProfile config
// (extraBannedPhrases / allowedTells / samplesNote) is applied on top of the
// base ruleset. Never a judgment about whether someone else's writing was
// AI-authored — see the Limitations section of the research doc.
server.registerTool(
  "voice_lint",
  {
    title: "Voice lint (AI-writing-tell scorer)",
    description:
      "Score text for AI-writing tells (overused lexical items like \"delve\"/\"tapestry\", contrastive-pivot rhetoric like \"not just X, but Y\", sycophantic openers, tidy-summary closers, and rhythm/density metrics: sentence-length burstiness, tricolon density, em-dash density, bolded-list density) using the research-backed ruleset in docs/VOICE-RESEARCH.md. Intended for editing YOUR OWN outbound drafts before sending them (project updates, docs, customer replies) — not for judging whether someone else's writing was AI-written. Pass `project` to apply that project's voiceProfile config (extraBannedPhrases, allowedTells, samplesNote) on top of the base ruleset; `threshold` (default 30) only changes the summary wording, not which findings fire.",
    inputSchema: {
      project: z.string().optional(),
      text: z.string(),
      threshold: z.number().optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, text, threshold }) => {
    let profile = { extraBannedPhrases: [], allowedTells: [], samplesNote: "" };
    if (project) {
      const board = getBoard();
      if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
      profile = getVoiceProfile(board, project);
    }
    return lintVoice(text, {
      extraBannedPhrases: profile.extraBannedPhrases,
      allowedTells: profile.allowedTells,
      samplesNote: profile.samplesNote,
      threshold,
    });
  })
);

server.registerTool(
  "get_work_packet",
  {
    title: "Get work packet",
    description:
      "Assemble a focused brief for one ticket before you work it: scope, linked-issue details, code location + custom project prompt, scratchpad mentions, the ticket's recent work log, files to read, and a definition of done. Read the files it points to rather than dumping them.",
    inputSchema: { project: z.string(), ticket: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, ticket }) => {
    const board = getBoard();
    // FBMCPF-192: history-driven filesToRead hints (best-effort). The git scan
    // lives in git.js; gate on git being enabled so a non-git project does zero
    // git work, and swallow any failure so a git hiccup never breaks packet
    // assembly (the packet is returned without hints).
    let historicalFiles = [];
    try {
      if (getGitConfig(board, project).enabled) {
        const task = board.getTask(project, ticket);
        historicalFiles = suggestHistoricalFiles(getHistoryMap(board, project), task, { limit: 5 });
      }
    } catch {
      historicalFiles = [];
    }
    return meta.getWorkPacket(board, project, ticket, { historicalFiles });
  })
);

server.registerTool(
  "prepare_research",
  {
    title: "Prepare research request",
    description:
      "FBMCPF-263: deterministically assemble a research REQUEST packet for a ticket BEFORE implementation (no model calls). Returns the questions to answer — how to execute (approaches + tradeoffs), prior art IN THIS repo (files/tickets), comparables/competitors, risks/invariants — plus local sources to seed from (matching KB docs, docs/ paths, code hints, and prior-art hits from the local lexical RAG, FBMCPF-264), a deliverable spec (a collated markdown brief ≤ ~150 lines), a saveInstruction (orchestrator saves the returned brief via add_kb_doc as research/<ticket> so getWorkPacket auto-attaches it as researchBrief), and a suggested cheap model (haiku for effort:low/medium, else sonnet). When the research phase resolves OFF (config researchOnIntake:false or a research:off label) returns { skip:true, reason }; a research:on label forces it on.",
    inputSchema: { project: z.string(), ticket: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, ticket }) => prepareResearch(getBoard(), project, ticket))
);

server.registerTool(
  "rag_search",
  {
    title: "Local lexical RAG search",
    description:
      "FBMCPF-264: local lexical retrieval (BM25) over this board's KB docs (incl. research briefs), the code repo's docs/ + root README, and Done tickets' title+completionSummary — zero tokens, zero network. Returns top-k [{score, source, heading, text}]. Use it to ground research and find prior art in the repo. Honest scope: this is KEYWORD matching (shared vocabulary), not semantic/embedding search.",
    inputSchema: {
      project: z.string(),
      query: z.string().describe("What to retrieve context for."),
      k: z.coerce.number().int().min(1).max(20).optional().default(5).describe("How many chunks to return (default 5, max 20)."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, query, k }) => ({ results: ragSearch(getBoard(), project, query, { k }) }))
);

server.registerTool(
  "get_live_activity",
  {
    title: "Get live activity (sub-agent visibility)",
    description:
      "Read-only git/filesystem ground truth about what coding sub-agents are doing RIGHT NOW, for one project or " +
      "(omit project) a rollup across every project with a codeLocation configured. Sub-agents deliberately never " +
      "write the board mid-flight (only the orchestrator sets status/logs work/commits), so between a ticket going " +
      "In Progress and coming back Done, the board itself has nothing new to say — the filesystem is the only " +
      "truth. Per repo (code + website, when configured): dirty files (capped list + total count) and pending " +
      "additions/deletions, commits in the last sinceMinutes, and OTHER git worktrees (a live sub-agent edit " +
      "surface) with their branch + dirty-file count. Also surfaces each repo's (and each worktree's) `.fb-progress` " +
      "file — the sanctioned sub-agent progress channel: tell sub-agents in their brief to append one-line " +
      "timestamped notes there at each major step (created → tests written → suite green, etc.) — " +
      "plus recently-modified files and the cheap board-side signals (In Progress count, last work-log age). Use " +
      "this for stalled-ticket triage (get_agent_monitor flags a stall from board events; this answers 'but is " +
      "anything actually moving?') and for a cross-project 'what's live right now' rollup on Mission Control. " +
      "In all-projects mode, quiet projects (nothing within sinceMinutes) are returned as plain name strings " +
      "instead of full objects, appended after the active ones.",
    inputSchema: {
      project: z.string().optional().describe("Limit to one project; omit for an all-projects rollup."),
      sinceMinutes: z.coerce.number().int().min(1).max(1440).optional().default(30).describe("Activity window in minutes (commits, recently-modified files, freshness checks). Default 30."),
      maxFiles: z.coerce.number().int().min(1).max(200).optional().default(15).describe("Cap on dirty-file and recently-modified-file lists per repo."),
      maxCommits: z.coerce.number().int().min(1).max(200).optional().default(10).describe("Cap on recent commits returned per repo."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, sinceMinutes, maxFiles, maxCommits }) =>
    getLiveActivity(getBoard(), project || null, { sinceMinutes, maxFiles, maxCommits })
  )
);

}
