// Auto-extracted from server/index.js (FBMCPF-224). Registration blocks moved verbatim.
export function registerTestingTools(server, ctx) {
  const { appendEvidence, bugImpactScan, existsSync, fail, formatEvidenceSection, generateMultiModelTests, generateTestFromPrompt, getBoard, getPricing, getTestPage, listTestPages, listVariants, meta, nodePath, readdirSync, removeTestPage, runVariantMatrix, saveGeneratedTests, saveTestPage, suggestTestStub, tryTool, writeTool, z } = ctx;

// testing (FBMCPF-63/34/35/36) ---------------------------------------------

server.registerTool(
  "suggest_test_stub",
  {
    title: "Suggest test stub",
    description:
      "Generate a boilerplate test file (path + node:test content) for a ticket, derived from its title/description and the board's code location. Agent-native 'fixtest': call it when creating or starting a ticket, then write the returned file. Read-only — it returns the stub, it does not create the file.",
    inputSchema: { project: z.string(), ticket: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, ticket }) => {
    const board = getBoard();
    const task = board.getTask(project, ticket);
    if (!task) throw new Error(`Ticket ${ticket} not found in "${project}".`);
    const cfg = meta.getProjectConfig(board, project);
    return suggestTestStub(task, cfg.codeLocation);
  })
);

server.registerTool(
  "generate_test",
  {
    title: "Generate a test from a prompt",
    description: "Generate a FULL node:test file (path + content) from a prompt and/or a ticket — one test() block per described behaviour, not just the single boilerplate stub. Optionally imports a target module. Read-only: returns the file for you to write under test/.",
    inputSchema: {
      project: z.string(),
      prompt: z.string().optional().describe("Plain-English behaviours to test (one per line or 'and'-separated). Optional if ticket is given."),
      ticket: z.string().optional().describe("Seed title/description/filename from this ticket."),
      module: z.string().optional().describe("Import specifier for the module under test, e.g. ../server/crm.js."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, prompt, ticket, module }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    const cfg = meta.getProjectConfig(board, project);
    let title, ticketNo, promptText = prompt;
    if (ticket) {
      const t = board.getTask(project, ticket);
      if (!t) throw new Error(`Ticket ${ticket} not found in "${project}".`);
      title = t.title; ticketNo = t.ticketNumber;
      if (!promptText) promptText = [t.title, t.description].filter(Boolean).join(". ");
    }
    if (!promptText) throw new Error("provide a prompt or a ticket to generate a test");
    return generateTestFromPrompt({ prompt: promptText, ticket: ticketNo, title, module, codeLocation: cfg.codeLocation });
  })
);

server.registerTool(
  "bug_impact_scan",
  {
    title: "Bug impact scan",
    description:
      "Given a bug (by ticket, or an ad-hoc title/description), rank the existing features most likely affected, by keyword overlap and shared product. Use it when logging a bug to spot regressions and linkage candidates.",
    inputSchema: {
      project: z.string(),
      ticket: z.string().optional().describe("Bug ticket to scan; or pass title/description directly."),
      title: z.string().optional(),
      description: z.string().optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, ticket, title, description }) => {
    const board = getBoard();
    let bug = { title, description };
    if (ticket) {
      const t = board.getTask(project, ticket);
      if (!t) throw new Error(`Ticket ${ticket} not found in "${project}".`);
      bug = t;
    }
    if (!bug.title && !bug.description) throw new Error("Provide a ticket, or a title/description to scan.");
    const features = board.listTasks(project, { type: "feature" });
    return { bug: bug.ticketNumber || bug.title, likelyAffected: bugImpactScan(bug, features) };
  })
);

server.registerTool(
  "log_test_run",
  {
    title: "Log test run",
    description:
      "Record a test run's result (passed/failed/skipped, optional suite + ticket + summary) to the board's test_runs.md. You run the tests (e.g. via the shell); this stores the report so the board can surface pass/fail over time.",
    inputSchema: {
      project: z.string(),
      passed: z.number().int().optional(),
      failed: z.number().int().optional(),
      skipped: z.number().int().optional(),
      suite: z.string().optional().describe("Suite/product name, e.g. 'server' or 'unit'."),
      ticket: z.string().optional(),
      summary: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, passed, failed, skipped, suite, ticket, summary }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return meta.logTestRun(board, project, { passed, failed, skipped, suite, ticket, summary });
  })
);

server.registerTool(
  "get_test_runs",
  {
    title: "Get test runs",
    description: "Read recorded test runs (most-recent first) plus a summary: total runs, latest result, and whether the latest is passing.",
    inputSchema: { project: z.string(), limit: z.number().int().min(1).max(200).optional().default(50) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, limit }) => {
    const board = getBoard();
    const runs = meta.readTestRuns(board, project).slice().reverse().slice(0, limit);
    return { project, summary: meta.testSummary(board, project), runs };
  })
);

server.registerTool(
  "save_test_page",
  {
    title: "Save a test page",
    description: "Create/overwrite a standalone HTML test/QA page under the project's test-pages/ folder.",
    inputSchema: {
      project: z.string(),
      name: z.string().describe("Page filename; .html is added if missing."),
      html: z.string(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  writeTool(({ project, name, html }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return saveTestPage(board, project, { name, html });
  })
);

server.registerTool(
  "list_test_pages",
  {
    title: "List test pages",
    description: "List the standalone HTML test pages under test-pages/.",
    inputSchema: { project: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return listTestPages(board, project);
  })
);

server.registerTool(
  "get_test_page",
  {
    title: "Get a test page",
    description: "Read one test page's HTML by name.",
    inputSchema: { project: z.string(), name: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, name }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return getTestPage(board, project, name);
  })
);

server.registerTool(
  "remove_test_page",
  {
    title: "Remove a test page",
    description: "Delete a test page by name.",
    inputSchema: { project: z.string(), name: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, name }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return removeTestPage(board, project, name);
  })
);

server.registerTool(
  "test_runs_by_suite",
  {
    title: "Test runs grouped by suite",
    description:
      "Organize recorded test runs (from log_test_run) by suite: each suite's latest result, run count, cumulative pass/fail, and pass-rate, plus the list of currently-failing suites. Surfaces coverage/health per suite instead of a flat list.",
    inputSchema: { project: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return { project, ...groupBySuite(meta.readTestRuns(board, project)) };
  })
);

server.registerTool(
  "coverage_by_product",
  {
    title: "Test coverage by product",
    description: "Roll up, per product, how many of its tickets have at least one recorded test run vs none, so testing gaps are visible on the board. Includes an overall rollup and the untested tickets per product.",
    inputSchema: { project: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return { project, ...coverageByProduct(board.listTasks(project, {}), meta.readTestRuns(board, project)) };
  })
);

// multi-model test generation (FBMCPF-147) -----------------------------------

server.registerTool(
  "generate_multi_model_tests",
  {
    title: "Generate multi-model test variants",
    description:
      "For a bug/ticket, fan one generation prompt out across model tiers (default fable, opus, sonnet) — each surfaces different failure concepts. Returns the SAME prompt once per tier plus a per-tier storage path (test/<ticket>.<model>.test.js) and instruction. Read-only: run each tier yourself, then submit results to save_generated_test. Builds on suggest_test_stub / generate_test (FBMCPF-102).",
    inputSchema: {
      project: z.string(),
      ticket: z.string().describe("Bug/ticket to generate variants for; seeds the prompt from its title/description."),
      prompt: z.string().optional().describe("Override the generation prompt (else derived from the ticket)."),
      module: z.string().optional().describe("Import specifier for the module under test, e.g. ../server/crm.js."),
      models: z.array(z.string()).optional().describe("Model tiers to fan across; defaults to [fable, opus, sonnet]."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, ticket, prompt, module, models }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    const t = board.getTask(project, ticket);
    if (!t) throw new Error(`Ticket ${ticket} not found in "${project}".`);
    const cfg = meta.getProjectConfig(board, project);
    let promptText = prompt;
    if (!promptText) promptText = [t.title, t.description].filter(Boolean).join(". ");
    if (!promptText) throw new Error("provide a prompt or a ticket with title/description");
    return generateMultiModelTests({
      prompt: promptText, ticket: t.ticketNumber, title: t.title, module, codeLocation: cfg.codeLocation, models,
    });
  })
);

server.registerTool(
  "save_generated_test",
  {
    title: "Save generated test variants",
    description:
      "Ingest the model-generated test variants for a ticket (submit them as variants: [{model, content}]). Tags each with its model, dedupes identical/near-identical assertions across variants (whitespace + variable names normalized; a fully-duplicate test block is dropped and noted), and returns the runnable files to write (test/<ticket>.<model>.test.js) plus a queryable manifest (test/<ticket>.variants.json). Read-only: it returns file contents for you to write.",
    inputSchema: {
      project: z.string(),
      ticket: z.string(),
      variants: z.array(z.object({
        model: z.string().describe("Model tier this variant came from (fable/opus/sonnet/...)."),
        content: z.string().describe("The generated node:test file content."),
        path: z.string().optional(),
      })).min(1).describe("One entry per model variant."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, ticket, variants }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    const cfg = meta.getProjectConfig(board, project);
    return saveGeneratedTests({ ticket, project, codeLocation: cfg.codeLocation, variants });
  })
);

server.registerTool(
  "list_test_variants",
  {
    title: "List multi-model test variants",
    description:
      "List the per-model test variants present for a ticket (test/<ticket>.<model>.test.js) and which model tiers cover it. Reads the project's test/ dir under its code location; feeds the multi-model eval (FBMCPF-148).",
    inputSchema: { project: z.string(), ticket: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, ticket }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    const cfg = meta.getProjectConfig(board, project);
    const base = cfg.codeLocation ? String(cfg.codeLocation).replace(/[\\/]+$/, "") : ".";
    const dir = nodePath.join(base, "test");
    let files = [];
    try { if (existsSync(dir)) files = readdirSync(dir); } catch { files = []; }
    return listVariants(files, ticket);
  })
);

server.registerTool(
  "eval_model_matrix",
  {
    title: "Eval: model up/downgrade effectiveness at test time",
    description:
      "FBMCPF-148 — run a ticket's per-model test variants (test/<ticket>.<model>.test.js, from generate_multi_model_tests / save_generated_test) against seeded regressions to see which tier's tests actually catch bugs. Seeds deterministic textual mutations (a built-in set, or caller-supplied find/replace patch specs) into a COPY of targetFile inside a fresh temp dir — the repo is never touched — runs each model's variant file with node --test before and after, and reports per-model defects caught, unique-catch rate (defects only that tier's tests caught), an overlap matrix, and cost per caught defect (tokensByModel × pricing.js rates). Omit targetFile to just run the baseline pass/fail matrix (no seeded mutations). Writes nothing to the repo unless writeEvidence:true, which appends the formatted readout to docs/EVIDENCE.md under codeLocation — mode is required so a demo run can never be silently mistaken for real defect data.",
    inputSchema: {
      project: z.string(),
      ticket: z.string().describe("Ticket whose test/<ticket>.<model>.test.js variants to run."),
      targetFile: z.string().optional().describe("Path (relative to codeLocation) of the source module the variants exercise, e.g. server/pricing.js. Required to run seeded mutations; omit to run the baseline matrix only."),
      mutations: z.array(z.object({
        id: z.string().optional(),
        description: z.string().optional(),
        find: z.string().describe("Literal substring (or regex source, if regex:true) to replace the first occurrence of."),
        replace: z.string(),
        regex: z.boolean().optional(),
        flags: z.string().optional(),
      })).optional().describe("Custom seeded-regression patch specs; defaults to a built-in deterministic mutation set (flip ===, flip &&/||, negate boolean return, off-by-one literal, flip </>)."),
      tokensByModel: z.record(z.number()).optional().describe("Generation token counts per model tier, e.g. {sonnet: 12000, opus: 40000}, used for cost-per-caught-defect."),
      mode: z.enum(["real", "harness-validation"]).describe("Label the readout honestly: 'real' for actual ticket variants against real seeded defects, 'harness-validation' for a demo fixture proving the harness works end-to-end."),
      writeEvidence: z.boolean().optional().default(false).describe("Append the formatted readout to docs/EVIDENCE.md under codeLocation."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  tryTool(({ project, ticket, targetFile, mutations, tokensByModel, mode, writeEvidence }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    const cfg = meta.getProjectConfig(board, project);
    const dir = cfg.codeLocation ? String(cfg.codeLocation).replace(/[\\/]+$/, "") : ".";
    const pricing = getPricing(board, project);
    const result = runVariantMatrix(dir, ticket, { targetFile, mutations, tokensByModel, pricing, mode });
    if (writeEvidence) {
      const evidencePath = nodePath.join(dir, "docs", "EVIDENCE.md");
      appendEvidence(evidencePath, formatEvidenceSection(result));
      result.evidenceAppended = evidencePath;
    }
    return result;
  })
);

server.registerTool(
  "get_regressions",
  {
    title: "Get regressions",
    description:
      "Regression view: bugs grouped under the feature they're linked to (sorted by open-bug count), plus unlinked bugs. Surfaces which shipped features are at risk. Link bugs to features (link_tasks) to populate it.",
    inputSchema: { project: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project }) => {
    const board = getBoard();
    const bugs = board.listTasks(project, { type: "bug" });
    const features = board.listTasks(project, { type: "feature" });
    return { project, ...computeRegressions(bugs, features) };
  })
);

}
