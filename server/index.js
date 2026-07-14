#!/usr/bin/env node
/**
 * FeatureBoard MCP server (stdio).
 *
 * Exposes a markdown-backed feature/bug board as MCP tools. The board data lives
 * on disk in the folder given by FEATUREBOARD_DATA_DIR (set from user_config in
 * the .mcpb manifest). Because Claude is the agent here, the "brainstorm" and
 * "decompose" workflows are just bulk persistence tools: Claude generates the
 * ideas, these tools write them to the board.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Board, parseImport, suggestTestStub, bugImpactScan, computeRegressions } from "./storage.js";
import * as license from "./license.js";
import * as meta from "./metadata.js";
import { predictDueDates } from "./predictive.js";
import {
  listMedia, saveMedia, getMedia, revertMedia,
  tagMedia, annotateMedia, removeAnnotation, searchMedia,
  saveUpload, listUploads, editMediaText, listVariations,
  addComment, listComments, removeComment,
} from "./media.js";
import { startDriftRun, recordDriftScore, driftReport, applyDriftRemediation } from "./drift.js";
import { scanBoardCleanup, pruneBoard } from "./cleanup.js";
import { listCodeTree, readCodeFile, codeFileMap } from "./explorer.js";
import { saveTestPage, listTestPages, getTestPage, removeTestPage } from "./testpages.js";
import { groupBySuite } from "./testing.js";
import { draftShare, listShares, removeShare, platformLimit } from "./social.js";
import {
  addCompany, listCompanies, getCompany, setCompanyProducts, addContact, updateContact, removeContact,
  addInboxMessage, listInbox, reviewInboxMessage, submitIntake,
  linkTicket, unlinkTicket, companiesForTicket, companyPriorityTickets,
  addAgreement, updateAgreement, removeAgreement,
} from "./crm.js";
import { book, cancelBooking, listBookings } from "./bookings.js";
import { addLead, listLeads, setLeadStatus, leadsMap, enrichLead, convertLead, addLeadArea, listLeadAreas, addInteraction, updateLeadLocation } from "./leads.js";
import { buildCustomerPortal } from "./portal.js";
import { listTemplates, generateContract } from "./contracts.js";
import { draftEmail, listMail, getEmail, markSent } from "./mail.js";
import { createCampaign, listCampaigns, getCampaign, recordOpen } from "./campaigns.js";
import {
  getSite, setSite, editSection, setLoginGate, addPage, listPages, removePage,
  renderSite, siteRoot, saveAsset, listAssets, setSiteAnalytics, addRawPage,
} from "./website.js";
import { getGitConfig, setGitConfig, commitFeature } from "./git.js";
import { scaffoldSite } from "./sitegen.js";
import { setAnalyticsConfig, autoConfigureAnalytics, getSiteTraffic } from "./analytics.js";
import { suggestPackaging, savePackagingConfig, getPackagingConfig, validatePackaging } from "./packaging.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import nodePath from "node:path";

const DATA_DIR = process.env.FEATUREBOARD_DATA_DIR;

// Absolute path to the shipped board UI. index.js lives in server/, the UI in
// artifact/board.html — so the packaged install always resolves it, regardless
// of cwd. Exposed to agents via the get_board tool (see below).
const SERVER_DIR = nodePath.dirname(fileURLToPath(import.meta.url));
const BOARD_HTML_PATH = nodePath.join(SERVER_DIR, "..", "artifact", "board.html");

function getBoard() {
  if (!DATA_DIR) {
    throw new Error(
      "No boards folder configured. Set the 'Boards folder' in the FeatureBoard extension settings."
    );
  }
  return new Board(DATA_DIR);
}

/** Safe brand-context lookup for generation prompts; null if unavailable. */
function tryBrand(project) {
  try {
    const board = getBoard();
    if (!board.projectExists(project)) return null;
    return meta.brandContext(board, project);
  } catch {
    return null;
  }
}

/** The project's configured preferred image tool/connector, or null. */
function tryImageTool(project) {
  try {
    const board = getBoard();
    if (!board.projectExists(project)) return null;
    const cfg = meta.getProjectConfig(board, project);
    return cfg && cfg.imageTool ? String(cfg.imageTool) : null;
  } catch {
    return null;
  }
}

const INSTRUCTIONS = `FeatureBoard is your task board for the user's projects. Treat it as the place you plan and track work, not just a store you touch when asked.

When the user gives you a substantive, multi-step request (build X, fix these bugs, ship a feature):
1. Pick or create the board. Call list_projects; if nothing fits, create_project.
2. Break the request down onto the board. Use plan_work once to create the project (if needed) plus the initial features and bugs in a single step. Features are units of new work (FBF-###); bugs are defects (FBB-###).
3. Work one ticket at a time. Call next_task to pull the next open item (it honours manual priority). set_status <ticket> "In Progress" BEFORE you start. Call get_work_packet to assemble a focused brief (scope, linked issue, code location, custom prompt, definition of done) and read the files it points to rather than dumping them. For a substantial or code ticket, dispatch it to a fresh sub-agent with that packet so it works in isolated context; do trivial tickets inline. Only you (the orchestrator) write to the board. When finished, set_status "Done" with a one-line completionSummary AND log_work with additions/deletions (and model) so progress is recorded. Then pull the next. (The process_next prompt runs this loop for you.)
4. Log new issues as you find them with log_bug, and split anything too big with decompose_feature.
5. When the user asks how things are going, use get_metrics and list_tasks rather than guessing.

Keep the board honest: a ticket should be In Progress only while you are actively working it, and Done only when it is genuinely finished. The board is scaffolding around the real work — it does not replace writing the code, running the tests, etc. Do not create boards or tickets for trivial one-shot chores that don't benefit from tracking.

Showing the board: when the user asks to see, open, or check on the board in natural language — e.g. "show me the board", "show the featureboard", "open the board", "let's see the tasks/queue", "what's on my plate", "how's it going / how are we looking", "give me a status", or "show velocity/analytics" — call the get_board tool and render the HTML it returns as a Cowork artifact (create_artifact with id "featureboard-board", or update_artifact if one is already open — reuse it, don't create duplicates). Do NOT hand-write your own board or reply only in text: get_board returns the shipped UI, which already has the Todo / In Progress / Done columns, the product filter, the dark/light theme toggle, and the 📊 Analytics dashboard (velocity, timeline, bug health, and the work-log feed) — tasks + analytics + everything in one place. List this server's tools in the artifact's mcp_tools so its buttons and charts work. Pair the artifact with a one- or two-line text summary of where things stand.`;

const server = new McpServer(
  { name: "featureboard", version: "0.3.2" },
  { instructions: INSTRUCTIONS }
);

// tool gating --------------------------------------------------------------
// The server can expose its full surface (130+ tools across CRM, media,
// website, campaigns, etc.) or just the essential board experience. Packaged
// installs default to "core" (see manifest user_config) for a clean first-run;
// the raw server default is "all" so tests and existing configs are unchanged.
// Set FEATUREBOARD_TOOLS=core to expose only the board/task tools below.
const CORE_TOOLS = new Set([
  "get_board",
  "list_projects", "create_project", "get_project_config", "set_project_config",
  "add_product", "remove_product", "plan_work", "add_feature", "add_features_bulk",
  "decompose_feature", "log_bug", "list_tasks", "get_task", "get_metrics",
  "get_health", "get_work_log", "get_scratchpad", "set_scratchpad", "next_task",
  "set_status", "get_work_packet", "log_work", "update_task", "delete_task",
  "link_tasks", "license_status", "activate_license", "request_commercial_license",
  "set_usage_type",
  // used by the board UI artifact (keep the panels working in core mode)
  "import_tasks", "get_regressions", "get_test_runs", "append_scratchpad",
]);
const TOOLSET = (process.env.FEATUREBOARD_TOOLS || "all").toLowerCase();
const CORE_ONLY = TOOLSET === "core"
  || /^(1|true|yes|on)$/.test((process.env.FEATUREBOARD_CORE_ONLY || "").toLowerCase());
if (CORE_ONLY) {
  const _registerTool = server.registerTool.bind(server);
  server.registerTool = (name, ...rest) => {
    if (!CORE_TOOLS.has(name)) return undefined;
    return _registerTool(name, ...rest);
  };
}

// helpers ------------------------------------------------------------------

const ok = (obj) => ({
  content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }],
});
const fail = (msg) => ({ content: [{ type: "text", text: `Error: ${msg}` }], isError: true });

function tryTool(fn) {
  return async (args) => {
    try {
      return ok(await fn(args));
    } catch (e) {
      return fail(e.message);
    }
  };
}

// Wrap a mutating tool: block writes when the license state disallows them
// (e.g. commercial trial expired). Reads never pass through here.
function writeTool(fn) {
  return async (args) => {
    try {
      const ev = license.evaluate(DATA_DIR);
      if (!ev.allowWrites) {
        return {
          content: [
            {
              type: "text",
              text:
                `Write blocked — ${ev.message}\n\n` +
                `License status: ${ev.status}. Reads still work. ` +
                `Enter a key with activate_license, or start licensing with request_commercial_license.`,
            },
          ],
          isError: true,
        };
      }
      return ok(await fn(args));
    } catch (e) {
      return fail(e.message);
    }
  };
}

// omit undefined/empty keys to keep payloads small
function trim(o) {
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out;
}

// compact one-line-ish view for list output (no _raw, no long description)
function compactView(t) {
  return trim({
    ticket: t.ticketNumber,
    type: t.type,
    status: t.status,
    title: t.title,
    due: t.dueDate,
    created: t.createdDate,
    completed: t.completionDate,
    product: t.product,
    labels: t.labels,
    ref: t.ref,
    priority: t.priority,
    linked: t.linkedIssue,
    attachments: t.attachments,
    newFile: t.newFile,
    website: t.website,
  });
}

// full view, minus the internal _raw field
function fullView(t) {
  const { _raw, source, ...rest } = t;
  return trim(rest);
}

const StatusEnum = z.enum(["Todo", "In Progress", "Done"]);

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
      "List this server's tools in the artifact's mcp_tools so the columns, product filter, and analytics dashboard work.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(() => {
    const html = readFileSync(BOARD_HTML_PATH, "utf8");
    return {
      artifactId: "featureboard-board",
      filename: "board.html",
      bytes: Buffer.byteLength(html, "utf8"),
      render:
        "Write `html` to a file, then call create_artifact with id \"featureboard-board\" " +
        "(or update_artifact if a board artifact is already open). Include the FeatureBoard tools in mcp_tools " +
        "so the board's buttons and analytics can call back into this server.",
      html,
    };
  })
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
      search: z.string().optional(),
      ref: z.string().optional().describe("Filter to tickets carrying this external reference id."),
      limit: z.number().int().min(1).max(500).optional().default(50),
      offset: z.number().int().min(0).optional().default(0),
      compact: z.boolean().optional().default(true).describe("One-line summaries; set false for full task objects."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, limit, offset, compact, ref, ...filters }) => {
    let all = getBoard().listTasks(project, filters);
    if (ref) all = all.filter((t) => (t.ref || "") === ref);
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
    const t = getBoard().getTask(project, ticket);
    if (!t) throw new Error(`Task ${ticket} not found in "${project}".`);
    return fullView(t);
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
  writeTool(({ project, ...f }) => getBoard().addTask(project, "feature", f))
);

server.registerTool(
  "log_bug",
  {
    title: "Log bug",
    description: "Log a bug to a board's buglist.md. Returns the new ticket (FBB-###).",
    inputSchema: addFields,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, ...f }) => getBoard().addTask(project, "bug", f))
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
    const created = features.map((f) => board.addTask(project, "feature", f));
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
      format: z.enum(["auto", "markdown", "csv", "json"]).optional().default("auto"),
      defaultType: z.enum(["feature", "bug"]).optional().default("feature").describe("Type for rows that don't specify one."),
      dryRun: z.boolean().optional().default(false).describe("Parse and return the tasks without creating them."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, content, format, defaultType, dryRun }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    const parsed = parseImport(content, format);
    if (!parsed.length) throw new Error("No tasks found in the provided content.");
    if (dryRun) return { project, dryRun: true, parsed: parsed.length, tasks: parsed };
    const created = parsed.map((t) => {
      const { type, status, ...fields } = t;
      const task = board.addTask(project, type === "bug" ? "bug" : defaultType || "feature", fields);
      if (status && status !== "Todo") {
        try { return board.setStatus(project, task.ticketNumber, status); } catch { return task; }
      }
      return task;
    });
    return { project, imported: created.length, created };
  })
);

server.registerTool(
  "plan_work",
  {
    title: "Plan work (break a request onto the board)",
    description:
      "Turn a user request into board items in one step. Optionally creates the project, then adds the features and bugs you list. Use this as the FIRST step when starting a substantive request, then work the tickets one at a time. Returns all created tickets.",
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
    const createdFeatures = features.map((f) => board.addTask(project, "feature", f));
    const createdBugs = bugs.map((b) => board.addTask(project, "bug", b));
    return { project, created_project, features: createdFeatures, bugs: createdBugs };
  })
);

server.registerTool(
  "next_task",
  {
    title: "Next task to work",
    description:
      "Return the next open ticket to work (status Todo or In Progress), so you can pull work one item at a time. Prefers In Progress, then earliest due date, then oldest ticket. Returns null when the board is clear.",
    inputSchema: {
      project: z.string(),
      type: z.enum(["all", "feature", "bug"]).optional().default("all"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, type }) => {
    const open = getBoard()
      .listTasks(project, { type })
      .filter((t) => t.status !== "Done");
    if (!open.length) return { next: null, remaining: 0 };
    const rank = (t) => (t.status === "In Progress" ? 0 : 1);
    const prio = (t) => (t.priority != null ? t.priority : Infinity);
    const dueVal = (t) => (t.dueDate ? Date.parse(t.dueDate) || Infinity : Infinity);
    const num = (t) => parseInt((t.ticketNumber || "").replace(/\D+/g, ""), 10) || 0;
    open.sort((a, b) => rank(a) - rank(b) || prio(a) - prio(b) || dueVal(a) - dueVal(b) || num(a) - num(b));
    return { next: fullView(open[0]), remaining: open.length };
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
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  writeTool(({ project, ticket, ...fields }) => getBoard().updateTask(project, ticket, fields))
);

server.registerTool(
  "set_status",
  {
    title: "Set status",
    description:
      "Move a task between Todo / In Progress / Done. When moving to Done you can also record structured completion metadata (model, tokens, additions, deletions) — these are written to the work log and roll up into velocity/metrics.",
    inputSchema: {
      project: z.string(),
      ticket: z.string(),
      status: StatusEnum,
      completionSummary: z.string().optional().describe("Recommended when moving to Done."),
      model: z.string().optional().describe("Model that did the work (Done only)."),
      tokens: z.number().int().optional().describe("Total tokens used (Done only)."),
      inputTokens: z.number().int().optional(),
      outputTokens: z.number().int().optional(),
      additions: z.number().int().optional().describe("Lines added (Done only)."),
      deletions: z.number().int().optional().describe("Lines deleted (Done only)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  writeTool(({ project, ticket, status, completionSummary, model, tokens, inputTokens, outputTokens, additions, deletions }) => {
    const board = getBoard();
    const result = board.setStatus(project, ticket, status, completionSummary);
    // On completion, log structured metrics so they roll up into velocity.
    if (status === "Done" && (model || tokens != null || additions != null || deletions != null)) {
      meta.logWork(board, project, {
        ticket,
        summary: completionSummary || `Completed ${ticket}`,
        model, tokens, inputTokens, outputTokens, additions, deletions,
      });
      result.metrics = meta.ticketMetrics(board, project, ticket);
    }
    // Close-out discipline: a Done ticket should always carry a summary.
    if (status === "Done" && !completionSummary) {
      result.warning =
        "Closed without a completionSummary — pass one so the board records what was done. Also consider log_work with additions/deletions.";
    }
    return result;
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
    description: "Set the linked issue on a task (e.g. link a bug to the feature it affects).",
    inputSchema: {
      project: z.string(),
      ticket: z.string(),
      linkedIssue: z.string(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  writeTool(({ project, ticket, linkedIssue }) => getBoard().linkTasks(project, ticket, linkedIssue))
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
      "Read-only deep-clean scan: finds likely-duplicate tickets (grouped by title similarity, each group nominating a keeper + removal candidates) and stale/placeholder tickets (old Todo items, placeholder titles). Returns a suggested removal set to feed prune_board. Never deletes.",
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
  "code_file_map",
  {
    title: "Map the codebase",
    description:
      "Recursively map the project's codeLocation: total file count + bytes, counts by extension, and the files that exceed the split thresholds (lines/bytes) as split candidates (worst first) — useful for spotting oversized modules to decompose.",
    inputSchema: {
      project: z.string(),
      splitLines: z.coerce.number().int().optional().default(400),
      splitBytes: z.coerce.number().int().optional().default(32768),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, splitLines, splitBytes }) => codeFileMap(codeRoot(project), { splitLines, splitBytes }))
);

// analytics & metadata (v0.3) ----------------------------------------------

server.registerTool(
  "get_metrics",
  {
    title: "Get metrics",
    description:
      "Read-only snapshot: feature/bug counts by status, completions by date, and velocity from the work log (tokens, additions/deletions, active days, recent tokens).",
    inputSchema: { project: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project }) => {
    const board = getBoard();
    const base = board.getMetrics(project);
    const v = meta.velocity(meta.readWorkLog(board, project));
    return { ...base, velocity: { totals: v.totals, tokensLast7Days: v.tokensLast7Days, tokensLast30Days: v.tokensLast30Days, tokensByDate: v.byDate } };
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
      "Read a board's settings: products, code location, agent model, prefixes, website, description. Merges MCP-managed config over the legacy project_config.json.",
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
      "Update a board's settings (only provided fields change). Writes to the MCP-managed config; never mutates legacy project_config.json.",
    inputSchema: {
      project: z.string(),
      products: z.array(z.string()).optional(),
      codeLocation: z.string().optional(),
      agentModel: z.string().optional(),
      description: z.string().optional(),
      website: z.string().optional(),
      customPrompt: z.string().optional().describe("Project-specific guidance injected into every work packet."),
      brandTitle: z.string().optional().describe("Board display title (branding)."),
      brandSubtitle: z.string().optional().describe("Board subtitle / byline (branding)."),
      brandWords: z.array(z.string()).optional().describe("Brand / trial words woven into generated media (e.g. product name, taglines, campaign phrases)."),
      brandVoice: z.string().optional().describe("Brand voice/tone for generated media, e.g. 'confident, playful, plain-spoken'."),
      imageTool: z.string().optional().describe("Preferred image-generation tool/connector/skill name for generate_image (e.g. an image MCP or an 'imagegen' skill). If unset, generate_image uses any available image generator, else falls back to SVG."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  writeTool(({ project, ...patch }) => meta.setProjectConfig(getBoard(), project, patch))
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
  writeTool(({ project, ...entry }) => meta.logWork(getBoard(), project, entry))
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
    title: "Agent monitor (currently-running work)",
    description:
      "Snapshot of the board's currently-running work: every In Progress ticket with its latest work-log activity, " +
      "cumulative additions/deletions/tokens, idle time since last activity, and a stalled flag (In Progress but no " +
      "recent progress). Sorted most-recently-active first. Use it to see what's underway and catch stuck tickets.",
    inputSchema: {
      project: z.string(),
      stallHours: z.number().min(0).optional().default(24).describe("Idle hours after which an In Progress ticket is flagged stalled."),
      asOf: z.string().optional().describe("Reference time (ISO) to measure idle against; defaults to now."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, stallHours, asOf }) => meta.agentMonitor(getBoard(), project, { stallHours, asOf }))
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
  tryTool(({ project }) => meta.computeHealth(getBoard(), project))
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
  tryTool(({ project, ticket }) => meta.getWorkPacket(getBoard(), project, ticket))
);

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

server.registerTool(
  "list_media",
  {
    title: "List media assets",
    description:
      "List a project's media gallery: images and shareable HTML reports in its media/ folder. Each asset carries enough to render a visual grid — kind, mimeType, sizeBytes + sizeLabel + sizeBucket, image dimensions (width/height, parsed from file headers), a preview reference (inline text snippet for reports, a get_media src for images), plus sidecar metadata (title, tags, brandWords, linked ticket). Read-only; returns an empty gallery if the project has no media/ folder yet. Optionally filter by kind.",
    inputSchema: {
      project: z.string(),
      kind: z.enum(["image", "report", "other"]).optional().describe("Filter to one media kind."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, kind }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return listMedia(board, project, { kind });
  })
);

server.registerTool(
  "save_media",
  {
    title: "Save media asset",
    description:
      "Save a generated asset into a project's media/ folder — a shareable HTML report (or SVG) as UTF-8 text, or an image as base64 (encoding:'base64'). You generate the content; this persists the bytes plus a <name>.meta.json sidecar (title, prompt, tags, linked ticket, generatedAt) that list_media reads back. Name must be a plain filename with an extension, e.g. q3-report.html.",
    inputSchema: {
      project: z.string(),
      name: z.string().describe("Plain filename with extension, e.g. launch-report.html or chart.png."),
      content: z.string().describe("Asset contents: UTF-8 text, or base64 when encoding is 'base64'."),
      encoding: z.enum(["utf8", "base64"]).optional().default("utf8"),
      title: z.string().optional().describe("Human title for the gallery."),
      prompt: z.string().optional().describe("The prompt/goal this asset was generated from."),
      tags: z.array(z.string()).optional(),
      ticket: z.string().optional().describe("Board ticket this asset relates to, e.g. FBMCPF-39."),
      group: z.string().optional().describe("Variation group id — save siblings under one group for side-by-side review (list_variations)."),
      brandWords: z.array(z.string()).optional().describe("Brand/trial words woven into this asset. If omitted, the project's configured brandWords are recorded automatically."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, name, content, encoding, title, prompt, tags, ticket, group, brandWords }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    // Default the recorded brand words to the project's configured set so generated assets carry their branding.
    const bw = brandWords && brandWords.length ? brandWords : meta.brandContext(board, project).words;
    return saveMedia(board, project, { name, content, encoding, title, prompt, tags, ticket, group, brandWords: bw });
  })
);

server.registerTool(
  "list_variations",
  {
    title: "List a variation group",
    description: "List the gallery assets that share a variation group id (alternatives generated from one prompt), for side-by-side review.",
    inputSchema: { project: z.string(), group: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, group }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return listVariations(board, project, group);
  })
);

server.registerTool(
  "get_media",
  {
    title: "View a media asset",
    description:
      "View one media asset: its metadata, size, and (by default) content — UTF-8 for text/report assets, base64 for images — plus its revision history (prior versions with the prompts used). Pass a version id to view an archived revision instead of the current one; set withContent:false for metadata + history only.",
    inputSchema: {
      project: z.string(),
      name: z.string().describe("Asset filename, e.g. q3-report.html."),
      version: z.string().optional().describe("Archived version id (from the versions list) to view instead of current."),
      withContent: z.boolean().optional().default(true),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, name, version, withContent }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return getMedia(board, project, name, { version, withContent });
  })
);

server.registerTool(
  "revert_media",
  {
    title: "Revert a media asset",
    description:
      "Restore a prior version of an asset as the current one. The current copy is archived first, so the revert is itself undoable. Use get_media to find the version id.",
    inputSchema: {
      project: z.string(),
      name: z.string(),
      version: z.string().describe("Version id to restore (from get_media's versions list)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, name, version }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return revertMedia(board, project, name, version);
  })
);

server.registerTool(
  "tag_media",
  {
    title: "Tag a media asset",
    description:
      "Add and/or remove custom tags on a media asset (updates the sidecar only — the asset bytes and version history are untouched). Tags are de-duplicated. Returns the asset's new tag list.",
    inputSchema: {
      project: z.string(),
      name: z.string(),
      add: z.array(z.string()).optional(),
      remove: z.array(z.string()).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, name, add, remove }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return tagMedia(board, project, name, { add, remove });
  })
);

server.registerTool(
  "annotate_media",
  {
    title: "Annotate a media asset",
    description:
      "Add a pin-based comment/annotation to an asset. Optional x/y locate the pin (e.g. 0-1 relative coordinates on an image or report). Returns the new annotation (with a stable id) and the total count.",
    inputSchema: {
      project: z.string(),
      name: z.string(),
      text: z.string().describe("Annotation/comment body."),
      x: z.number().optional().describe("Pin x (e.g. 0-1 relative)."),
      y: z.number().optional().describe("Pin y (e.g. 0-1 relative)."),
      author: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, name, text, x, y, author }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return annotateMedia(board, project, name, { text, x, y, author });
  })
);

server.registerTool(
  "remove_annotation",
  {
    title: "Remove a media annotation",
    description: "Remove an annotation from an asset by its id (from get_media). Returns the remaining count.",
    inputSchema: { project: z.string(), name: z.string(), id: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, name, id }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return removeAnnotation(board, project, name, id);
  })
);

server.registerTool(
  "add_media_comment",
  {
    title: "Comment on a media asset",
    description:
      "Add a threaded comment to a gallery asset (a discussion thread, distinct from pin annotations). Pass parentId (a comment id from get_media / list_media_comments) to reply to an existing comment. Returns the new comment and total count.",
    inputSchema: {
      project: z.string(),
      name: z.string().describe("Asset filename, e.g. launch-report.html."),
      body: z.string().describe("Comment text."),
      author: z.string().optional().describe("Who is commenting."),
      parentId: z.string().optional().describe("Comment id to reply to (omit for a top-level comment)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, name, body, author, parentId }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return addComment(board, project, name, { body, author, parentId });
  })
);

server.registerTool(
  "list_media_comments",
  {
    title: "List media comments",
    description: "List an asset's comments, both as a flat array and as a threaded tree (root comments with nested replies).",
    inputSchema: { project: z.string(), name: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, name }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return listComments(board, project, name);
  })
);

server.registerTool(
  "remove_media_comment",
  {
    title: "Remove a media comment",
    description:
      "Remove a comment by id (from get_media / list_media_comments). By default its reply subtree is removed too; set cascade:false to refuse when it still has replies. Returns the ids removed.",
    inputSchema: {
      project: z.string(),
      name: z.string(),
      id: z.string(),
      cascade: z.boolean().optional().default(true).describe("Remove the comment's replies too (default true)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, name, id, cascade }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return removeComment(board, project, name, id, { cascade });
  })
);

server.registerTool(
  "search_media",
  {
    title: "Search media assets",
    description:
      "Search/filter a project's media gallery by kind, by exact tag, and/or a free-text query matched across asset name, title, tags, and the generation prompt. Returns matching assets with metadata.",
    inputSchema: {
      project: z.string(),
      query: z.string().optional(),
      tag: z.string().optional(),
      kind: z.enum(["image", "report", "other"]).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, query, tag, kind }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return searchMedia(board, project, { query, tag, kind });
  })
);

server.registerTool(
  "upload_reference",
  {
    title: "Upload a reference image",
    description:
      "Save a reference/source image under media/uploads/ (base64) to use as input for media generation — kept separate from the gallery. Reference it in a generate/refine prompt so Claude or an image model can work from it.",
    inputSchema: {
      project: z.string(),
      name: z.string().describe("Filename with extension, e.g. moodboard.png."),
      content: z.string().describe("Base64 image bytes (or utf8 text with encoding:'utf8')."),
      encoding: z.enum(["base64", "utf8"]).optional().default("base64"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, name, content, encoding }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return saveUpload(board, project, { name, content, encoding });
  })
);

server.registerTool(
  "list_references",
  {
    title: "List reference uploads",
    description: "List the reference/source images under media/uploads/ (inputs for generation).",
    inputSchema: { project: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return listUploads(board, project);
  })
);

server.registerTool(
  "edit_media",
  {
    title: "Edit a text media asset",
    description:
      "Directly edit an existing text/report asset (find/replace, append, or prepend) and save the result as a new version — the prior copy is archived (edit-media). For images, use refine_media or image generation instead.",
    inputSchema: {
      project: z.string(),
      name: z.string().describe("Gallery asset (a text/report asset: .html/.svg/.txt/.md…)."),
      find: z.string().optional().describe("Text to replace (all occurrences)."),
      replace: z.string().optional().describe("Replacement for 'find' (default: remove)."),
      append: z.string().optional(),
      prepend: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, name, find, replace, append, prepend }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return editMediaText(board, project, name, { find, replace, append, prepend });
  })
);

server.registerTool(
  "draft_share",
  {
    title: "Draft a social share",
    description:
      "Save a reviewable social-share draft for a gallery item — you write the copy, this persists it (never posts). Platform 'x' (≤280 chars) or 'linkedin' (longer); over-limit copy is rejected. There is no live-publish connector: drafts are for the user to review and post. Use list_shares to review.",
    inputSchema: {
      project: z.string(),
      platform: z.enum(["x", "linkedin"]),
      text: z.string().describe("The suggested post copy (short for X, longer for LinkedIn)."),
      asset: z.string().optional().describe("Gallery asset this share is for, e.g. q3-report.html."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, platform, text, asset }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return draftShare(board, project, { platform, text, asset });
  })
);

server.registerTool(
  "list_shares",
  {
    title: "List social share drafts",
    description: "List saved share drafts (newest-first), optionally filtered by asset and/or platform.",
    inputSchema: {
      project: z.string(),
      asset: z.string().optional(),
      platform: z.enum(["x", "linkedin"]).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, asset, platform }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return listShares(board, project, { asset, platform });
  })
);

server.registerTool(
  "remove_share",
  {
    title: "Remove a social share draft",
    description: "Delete a share draft by its id (from list_shares).",
    inputSchema: { project: z.string(), id: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, id }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return removeShare(board, project, id);
  })
);

// CRM ----------------------------------------------------------------------

server.registerTool(
  "add_company",
  {
    title: "Add a CRM company",
    description:
      "Create a company in the project's CRM (crm/companies/<slug>.json). Slug is derived from the name and de-duplicated. Returns the new company record.",
    inputSchema: {
      project: z.string(),
      name: z.string(),
      domain: z.string().optional(),
      notes: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, name, domain, notes }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return addCompany(board, project, { name, domain, notes });
  })
);

server.registerTool(
  "list_companies",
  {
    title: "List CRM companies",
    description: "List the project's CRM companies (id, name, domain, contact count, products), alphabetical by name. Pass product to show only companies associated with that product.",
    inputSchema: { project: z.string(), product: z.string().optional().describe("Filter to companies associated with this product.") },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, product }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return listCompanies(board, project, { product });
  })
);

server.registerTool(
  "set_company_products",
  {
    title: "Set a company's products",
    description: "Record which products a company uses/owns (replaces the list; de-duplicated). Surfaced on the company record and usable via list_companies(product=...).",
    inputSchema: {
      project: z.string(),
      company: z.string().describe("Company id (slug)."),
      products: z.array(z.string()).describe("Full product list for the company (replaces any existing)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  writeTool(({ project, company, products }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return setCompanyProducts(board, project, company, products);
  })
);

server.registerTool(
  "get_company",
  {
    title: "Get a CRM company",
    description: "Full company record including its contacts. Throws if the company id isn't found.",
    inputSchema: { project: z.string(), id: z.string().describe("Company id (slug) from list_companies.") },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, id }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return getCompany(board, project, id);
  })
);

server.registerTool(
  "add_contact",
  {
    title: "Add a CRM contact",
    description: "Add a contact (name, email, role, phone) to a company. Contact ids are unique within the company.",
    inputSchema: {
      project: z.string(),
      company: z.string().describe("Company id (slug)."),
      name: z.string(),
      email: z.string().optional(),
      role: z.string().optional(),
      phone: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, company, name, email, role, phone }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return addContact(board, project, company, { name, email, role, phone });
  })
);

server.registerTool(
  "update_contact",
  {
    title: "Update a CRM contact",
    description: "Edit a contact on a company (only provided fields change). Pass an empty string to clear email/role/phone.",
    inputSchema: {
      project: z.string(),
      company: z.string().describe("Company id (slug)."),
      contact: z.string().describe("Contact id within the company (e.g. c1)."),
      name: z.string().optional(),
      email: z.string().optional(),
      role: z.string().optional(),
      phone: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  writeTool(({ project, company, contact, name, email, role, phone }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return updateContact(board, project, company, contact, { name, email, role, phone });
  })
);

server.registerTool(
  "remove_contact",
  {
    title: "Remove a CRM contact",
    description: "Remove a contact from a company by its contact id (e.g. c1).",
    inputSchema: {
      project: z.string(),
      company: z.string().describe("Company id (slug)."),
      contact: z.string().describe("Contact id within the company (e.g. c1)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, company, contact }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return removeContact(board, project, company, contact);
  })
);

server.registerTool(
  "add_crm_message",
  {
    title: "Add a CRM inbox message",
    description:
      "Add an incoming message to the CRM inbox (starts pending review). Useful for logging inbound emails/leads that need triage and approval.",
    inputSchema: {
      project: z.string(),
      subject: z.string().optional(),
      body: z.string().optional(),
      from: z.string().optional(),
      company: z.string().optional().describe("Related company id, if known."),
      type: z.enum(["support", "sales", "contact", "feedback", "other"]).optional().describe("Submission category."),
      email: z.string().optional().describe("Requester email."),
      name: z.string().optional().describe("Requester name."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, subject, body, from, company, type, email, name }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return addInboxMessage(board, project, { subject, body, from, company, type, email, name });
  })
);

server.registerTool(
  "submit_crm_intake",
  {
    title: "Submit a support/contact request",
    description:
      "Capture an inbound support or contact submission (support-info / crm-submit) into the CRM inbox, pending review. Records the requester (name/email), a category (support/sales/contact/feedback/other), an optional related company, and the message; synthesizes a subject if none is given.",
    inputSchema: {
      project: z.string(),
      type: z.enum(["support", "sales", "contact", "feedback", "other"]).optional().default("contact"),
      name: z.string().optional().describe("Requester name."),
      email: z.string().optional().describe("Requester email."),
      company: z.string().optional().describe("Related company id, if known."),
      subject: z.string().optional(),
      message: z.string().describe("The submission body."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, type, name, email, company, subject, message }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return submitIntake(board, project, { type, name, email, company, subject, message });
  })
);

server.registerTool(
  "list_crm_inbox",
  {
    title: "List CRM inbox",
    description: "List CRM inbox messages (newest-first), optionally filtered by status (pending/approved/rejected), company, and/or type (support/sales/contact/feedback/other).",
    inputSchema: {
      project: z.string(),
      status: z.enum(["pending", "approved", "rejected"]).optional(),
      company: z.string().optional(),
      type: z.enum(["support", "sales", "contact", "feedback", "other"]).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, status, company, type }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return listInbox(board, project, { status, company, type });
  })
);

server.registerTool(
  "review_crm_message",
  {
    title: "Review a CRM inbox message",
    description: "Approve or reject a pending CRM inbox message by id. Records the decision and timestamp.",
    inputSchema: {
      project: z.string(),
      id: z.string(),
      decision: z.enum(["approve", "reject"]),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  writeTool(({ project, id, decision }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return reviewInboxMessage(board, project, id, decision);
  })
);

server.registerTool(
  "add_lead",
  {
    title: "Add a lead",
    description:
      "Add a sales lead to the project's leads store (crm/leads.json). Status defaults to 'new' (pipeline: new → contacted → qualified → won/lost). Optional value and lat/lng power the pipeline value and the leads map.",
    inputSchema: {
      project: z.string(),
      name: z.string(),
      company: z.string().optional(),
      email: z.string().optional(),
      source: z.string().optional(),
      value: z.number().optional().describe("Estimated deal value."),
      city: z.string().optional(),
      lat: z.number().optional(),
      lng: z.number().optional(),
      status: z.enum(["new", "contacted", "qualified", "won", "lost"]).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, name, company, email, source, value, city, lat, lng, status }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return addLead(board, project, { name, company, email, source, value, city, lat, lng, status });
  })
);

server.registerTool(
  "list_leads",
  {
    title: "List leads",
    description: "List leads (newest-first), optionally filtered by pipeline status and/or company.",
    inputSchema: {
      project: z.string(),
      status: z.enum(["new", "contacted", "qualified", "won", "lost"]).optional(),
      company: z.string().optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, status, company }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return listLeads(board, project, { status, company });
  })
);

server.registerTool(
  "set_lead_status",
  {
    title: "Set lead status",
    description: "Move a lead along the pipeline (new/contacted/qualified/won/lost). Records the update time.",
    inputSchema: {
      project: z.string(),
      id: z.string(),
      status: z.enum(["new", "contacted", "qualified", "won", "lost"]),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  writeTool(({ project, id, status }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return setLeadStatus(board, project, id, status);
  })
);

server.registerTool(
  "enrich_lead",
  {
    title: "Enrich a lead",
    description:
      "Record website-sourced details on a lead (only provided fields are set): website, domain, phone, industry, description, contactName, employees, email, city, source, value. Use the pull_lead_website prompt to fetch + extract these from the lead's site first, then persist them here.",
    inputSchema: {
      project: z.string(),
      id: z.string().describe("Lead id, e.g. L3."),
      website: z.string().optional(),
      domain: z.string().optional(),
      phone: z.string().optional(),
      industry: z.string().optional(),
      description: z.string().optional(),
      contactName: z.string().optional(),
      employees: z.string().optional(),
      email: z.string().optional(),
      city: z.string().optional(),
      source: z.string().optional(),
      value: z.coerce.number().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  writeTool(({ project, id, ...fields }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return enrichLead(board, project, id, fields);
  })
);

server.registerTool(
  "convert_lead",
  {
    title: "Convert a lead to a company",
    description:
      "Convert a qualified lead into a CRM company, carrying over its fields (name, website→domain, a notes summary) and optionally seeding a contact from the lead's person/email/phone. Marks the lead won and records the company it became. Errors if already converted.",
    inputSchema: {
      project: z.string(),
      id: z.string().describe("Lead id, e.g. L3."),
      companyName: z.string().optional().describe("Override the company name (defaults to the lead's company or name)."),
      createContact: z.boolean().optional().default(true).describe("Seed a company contact from the lead."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, id, companyName, createContact }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return convertLead(board, project, id, { companyName, createContact }, { crm: { addCompany, addContact } });
  })
);

server.registerPrompt(
  "pull_lead_website",
  {
    title: "Enrich a lead from its website",
    description: "Fetch a lead's website, extract company details, and save them onto the lead via enrich_lead.",
    argsSchema: {
      project: z.string().optional(),
      id: z.string().optional().describe("Lead id to enrich."),
      url: z.string().optional().describe("Website URL (defaults to the lead's website field)."),
    },
  },
  ({ project, id, url } = {}) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            `Enrich lead${id ? ` ${id}` : ""}${project ? ` in project "${project}"` : ""} from its website.\n\n` +
            "Steps:\n" +
            (id ? "" : "- Ask which lead (or list_leads to find it).\n") +
            `- Determine the URL${url ? ` (${url})` : " (use the provided url, or the lead's existing website field — list_leads shows it)"}. If there's no URL, ask for one.\n` +
            "- Fetch the site (web_fetch) and read the home/about/contact pages.\n" +
            "- Extract what you can: a one-line description, industry, headquarters city, a phone, a general contact name/email, rough employee count, and the canonical domain.\n" +
            "- Call enrich_lead with the fields you found (leave unknowns out — don't guess).\n" +
            "- Confirm what was added, and offer to convert_lead it into a company if it looks qualified.",
        },
      },
    ],
  })
);

server.registerTool(
  "leads_map",
  {
    title: "Leads map",
    description:
      "Geographic + pipeline rollup for the leads map: mappable points (leads with lat/lng), counts by status and by city, geocoded/ungeocoded tally, and total pipeline value. Rendering is left to the board or a generated report.",
    inputSchema: { project: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return leadsMap(board, project);
  })
);

server.registerTool(
  "add_lead_area",
  {
    title: "Add a lead area",
    description:
      "Define a circular geographic area (name + centre lat/lng + radius km) for the leads map. leads_map then tags each mapped lead with the areas it falls in and rolls up lead counts + pipeline value per area.",
    inputSchema: {
      project: z.string(),
      name: z.string(),
      lat: z.coerce.number(),
      lng: z.coerce.number(),
      radiusKm: z.coerce.number().describe("Area radius in kilometres (positive)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, name, lat, lng, radiusKm }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return addLeadArea(board, project, { name, lat, lng, radiusKm });
  })
);

server.registerTool(
  "list_lead_areas",
  {
    title: "List lead areas",
    description: "List the defined geographic lead areas (id, name, centre, radius).",
    inputSchema: { project: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return listLeadAreas(board, project);
  })
);

server.registerTool(
  "add_lead_interaction",
  {
    title: "Log a lead interaction",
    description:
      "Append a touchpoint to a lead's interaction log: kind (call/email/meeting/note/visit/other) + a note, timestamped. Builds the per-lead history.",
    inputSchema: {
      project: z.string(),
      id: z.string().describe("Lead id, e.g. L3."),
      kind: z.enum(["call", "email", "meeting", "note", "visit", "other"]).optional().default("note"),
      note: z.string(),
      at: z.string().optional().describe("ISO timestamp (defaults to now)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, id, kind, note, at }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return addInteraction(board, project, id, { kind, note, at });
  })
);

server.registerTool(
  "update_lead_location",
  {
    title: "Update a lead's location",
    description: "Set a lead's coordinates (lat/lng) and/or city, so it maps correctly and falls into the right areas.",
    inputSchema: {
      project: z.string(),
      id: z.string().describe("Lead id, e.g. L3."),
      lat: z.coerce.number().optional(),
      lng: z.coerce.number().optional(),
      city: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  writeTool(({ project, id, lat, lng, city }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return updateLeadLocation(board, project, id, { lat, lng, city });
  })
);

server.registerTool(
  "customer_portal",
  {
    title: "Customer portal",
    description:
      "Build a per-customer portal page for a CRM company: their contacts plus the board tickets linked to them (link tickets with link_customer_ticket). Returns self-contained HTML; with save:true it also writes the page into the media gallery as portal-<company>.html and returns its path.",
    inputSchema: {
      project: z.string(),
      company: z.string().describe("Company id (slug) from list_companies."),
      save: z.boolean().optional().default(false).describe("Also save the page to the media gallery."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  tryTool(({ project, company, save }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    const r = buildCustomerPortal(board, project, company, (id) => board.getTask(project, id));
    if (save) {
      const saved = saveMedia(board, project, {
        name: `portal-${company}.html`,
        content: r.html,
        title: `${r.name} — Customer Portal`,
        tags: ["portal"],
      });
      const { html, ...summary } = r;
      return { ...summary, saved: saved.relPath };
    }
    return r;
  })
);

server.registerTool(
  "list_contract_templates",
  {
    title: "List contract templates",
    description: "List the standard contract templates (NDA, MSA, SOW, commercial license) with their required fields.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(() => listTemplates())
);

server.registerTool(
  "generate_contract",
  {
    title: "Generate a contract",
    description:
      "Fill a standard contract template with the given fields and return the draft markdown. Optionally auto-fills customer_name from a CRM company, and with save:true writes the draft into the media gallery. Drafts are stamped to review with counsel — not legal advice.",
    inputSchema: {
      project: z.string(),
      template: z.enum(["nda", "msa", "sow", "license"]),
      vars: z.record(z.string()).optional().describe("Template fields, e.g. { provider, effective_date, term }."),
      company: z.string().optional().describe("CRM company id to auto-fill customer_name."),
      save: z.boolean().optional().default(false),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, template, vars, company, save }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return generateContract(board, project, { template, vars, company, save });
  })
);

server.registerTool(
  "link_customer_ticket",
  {
    title: "Link a ticket to a customer",
    description:
      "Link a board ticket (feature/bug) to a CRM company, stored on the company so it shows in its customer_portal. De-duplicated.",
    inputSchema: {
      project: z.string(),
      company: z.string().describe("Company id (slug)."),
      ticket: z.string().describe("Board ticket id, e.g. FBMCPF-47."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  writeTool(({ project, company, ticket }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return linkTicket(board, project, company, ticket);
  })
);

server.registerTool(
  "unlink_customer_ticket",
  {
    title: "Unlink a ticket from a customer",
    description: "Remove a ticket link from a CRM company.",
    inputSchema: { project: z.string(), company: z.string(), ticket: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, company, ticket }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return unlinkTicket(board, project, company, ticket);
  })
);

server.registerTool(
  "ticket_customers",
  {
    title: "Customers linked to a ticket",
    description: "Reverse lookup: which CRM companies a board ticket is linked to (surfaces the ticket↔customer relationship).",
    inputSchema: { project: z.string(), ticket: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, ticket }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return companiesForTicket(board, project, ticket);
  })
);

server.registerTool(
  "company_priority_tickets",
  {
    title: "A company's tickets by priority",
    description: "List a company's linked board tickets, split into features and bugs and ranked by priority (highest first, i.e. lowest number). Uses the ticket\u2194customer links; reports any linked ids no longer on the board as missing.",
    inputSchema: { project: z.string(), company: z.string().describe("Company id (slug).") },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, company }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return companyPriorityTickets(board, project, company, (id) => board.getTask(project, id));
  })
);

server.registerTool(
  "add_company_agreement",
  {
    title: "Add a company contract/license",
    description:
      "Record a contract or license on a CRM company (stored on the company, alongside contacts). kind 'contract' or 'license'; optional template (from generate_contract), title, value, seats, term, expiresAt, status, notes. Returns the new agreement.",
    inputSchema: {
      project: z.string(),
      company: z.string().describe("Company id (slug)."),
      kind: z.enum(["contract", "license"]),
      template: z.string().optional(),
      title: z.string().optional(),
      value: z.number().optional(),
      seats: z.number().optional(),
      term: z.string().optional(),
      expiresAt: z.string().optional().describe("YYYY-MM-DD"),
      status: z.string().optional(),
      notes: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, company, kind, template, title, value, seats, term, expiresAt, status, notes }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return addAgreement(board, project, company, { kind, template, title, value, seats, term, expiresAt, status, notes });
  })
);

server.registerTool(
  "update_company_agreement",
  {
    title: "Update/extend a company agreement",
    description: "Update a company contract/license by id — e.g. extend a license (new expiresAt), change status ('signed'/'renewed'/'expired'), seats, term, or value.",
    inputSchema: {
      project: z.string(),
      company: z.string(),
      id: z.string().describe("Agreement id (from get_company)."),
      status: z.string().optional(),
      expiresAt: z.string().optional(),
      seats: z.number().optional(),
      term: z.string().optional(),
      value: z.number().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  writeTool(({ project, company, id, status, expiresAt, seats, term, value }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return updateAgreement(board, project, company, id, { status, expiresAt, seats, term, value });
  })
);

server.registerTool(
  "remove_company_agreement",
  {
    title: "Remove a company agreement",
    description: "Delete a contract/license from a company by id.",
    inputSchema: { project: z.string(), company: z.string(), id: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, company, id }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return removeAgreement(board, project, company, id);
  })
);

// Bookings / scheduling against CRM contacts (FBMCPF-84) --------------------

server.registerTool(
  "book_meeting",
  {
    title: "Book a call/demo with a CRM contact",
    description:
      "Schedule a call, demo, or meeting with a CRM company (and optionally a specific contact within it). Validates the company exists (list_companies) and the contact belongs to it. Time is an ISO timestamp; stored under crm/bookings.json with status 'scheduled'.",
    inputSchema: {
      project: z.string(),
      company: z.string().describe("CRM company id (from list_companies)."),
      at: z.string().describe("Start time as an ISO timestamp, e.g. 2026-08-01T17:00:00Z."),
      contact: z.string().optional().describe("A contact id (c1) or name within the company."),
      type: z.enum(["call", "demo", "meeting", "onboarding", "other"]).optional(),
      durationMins: z.number().optional().describe("Length in minutes (default 30)."),
      subject: z.string().optional(),
      notes: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, company, at, contact, type, durationMins, subject, notes }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return book(board, project, { company, at, contact, type, durationMins, subject, notes });
  })
);

server.registerTool(
  "cancel_booking",
  {
    title: "Cancel a booking",
    description: "Cancel a scheduled booking by id (from list_bookings), optionally with a reason. Idempotent: cancelling an already-cancelled booking is a no-op.",
    inputSchema: {
      project: z.string(),
      id: z.string().describe("Booking id, e.g. b1."),
      reason: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  writeTool(({ project, id, reason }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return cancelBooking(board, project, id, { reason });
  })
);

server.registerTool(
  "list_bookings",
  {
    title: "List bookings",
    description: "List bookings for the board, newest-first. Filter by company or status ('scheduled'/'cancelled'), or pass upcoming:true for scheduled future bookings sorted soonest-first.",
    inputSchema: {
      project: z.string(),
      company: z.string().optional(),
      status: z.enum(["scheduled", "cancelled"]).optional(),
      upcoming: z.boolean().optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  tryTool(({ project, company, status, upcoming }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return listBookings(board, project, { company, status, upcoming });
  })
);

// Mail ---------------------------------------------------------------------

server.registerTool(
  "draft_email",
  {
    title: "Draft an email",
    description:
      "Compose and save an email draft in the project mail center (does not send — there is no mail connector; the user or a future connector sends). Recipients are validated. Optionally tie it to a CRM company.",
    inputSchema: {
      project: z.string(),
      to: z.union([z.string(), z.array(z.string())]).describe("Recipient address(es)."),
      subject: z.string().optional(),
      body: z.string().optional(),
      cc: z.union([z.string(), z.array(z.string())]).optional(),
      company: z.string().optional().describe("Related CRM company id."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, to, subject, body, cc, company }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return draftEmail(board, project, { to, subject, body, cc, company });
  })
);

server.registerTool(
  "list_mail",
  {
    title: "List mail",
    description: "List mail (newest-first), optionally filtered by status (draft/sent) and/or company. Sent items form the mail history.",
    inputSchema: {
      project: z.string(),
      status: z.enum(["draft", "sent"]).optional(),
      company: z.string().optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, status, company }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return listMail(board, project, { status, company });
  })
);

server.registerTool(
  "get_email",
  {
    title: "Get an email",
    description: "Full email message by id (from list_mail).",
    inputSchema: { project: z.string(), id: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, id }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return getEmail(board, project, id);
  })
);

server.registerTool(
  "mark_email_sent",
  {
    title: "Mark an email sent",
    description:
      "Record that a draft was sent (moves it into mail history with a sentAt timestamp). Does not actually send — tracking only.",
    inputSchema: { project: z.string(), id: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, id }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return markSent(board, project, id);
  })
);

// Marketing campaigns ------------------------------------------------------

server.registerTool(
  "create_campaign",
  {
    title: "Create a marketing campaign",
    description:
      "Create a marketing campaign with a recipient list and a send batch size. Recipients are validated + de-duplicated; sending is left to the user/a connector (this tracks the campaign and computes send batches). Returns the campaign + stats.",
    inputSchema: {
      project: z.string(),
      name: z.string(),
      recipients: z.array(z.string()).describe("Recipient email addresses."),
      subject: z.string().optional(),
      body: z.string().optional(),
      batchSize: z.number().int().min(1).optional().describe("Max recipients per send batch (default 50)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, name, recipients, subject, body, batchSize }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return createCampaign(board, project, { name, recipients, subject, body, batchSize });
  })
);

server.registerTool(
  "list_campaigns",
  {
    title: "List campaigns",
    description: "List marketing campaigns (newest-first) with summary stats (recipients, opens, open rate, batch count).",
    inputSchema: { project: z.string(), status: z.enum(["draft", "scheduled", "sent"]).optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, status }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return listCampaigns(board, project, { status });
  })
);

server.registerTool(
  "get_campaign",
  {
    title: "Get a campaign",
    description: "Full campaign incl. recipients, open stats, and the send-batch sizes.",
    inputSchema: { project: z.string(), id: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, id }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return getCampaign(board, project, id);
  })
);

server.registerTool(
  "record_campaign_open",
  {
    title: "Record a campaign open",
    description:
      "Record that a recipient opened a campaign (idempotent per recipient) — for when a mail connector or manual entry reports opens. Updates open-rate stats.",
    inputSchema: { project: z.string(), id: z.string(), email: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  writeTool(({ project, id, email }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return recordOpen(board, project, id, email);
  })
);

// Website ------------------------------------------------------------------

server.registerTool(
  "get_site",
  {
    title: "Get the project website",
    description: "Read the project's splash/website config (title, tagline, theme, sections, login gate). Returns defaults if none built yet.",
    inputSchema: { project: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return getSite(board, project);
  })
);

server.registerTool(
  "set_site",
  {
    title: "Build/update the project website",
    description:
      "Set the project's splash site (title, tagline, theme light/dark, and sections). Re-renders site/index.html. Only provided fields change.",
    inputSchema: {
      project: z.string(),
      title: z.string().optional(),
      tagline: z.string().optional(),
      theme: z.enum(["light", "dark"]).optional(),
      sections: z.array(z.object({ heading: z.string(), body: z.string() })).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, title, tagline, theme, sections }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return setSite(board, project, { title, tagline, theme, sections });
  })
);

server.registerTool(
  "scaffold_site",
  {
    title: "Scaffold a whole website from one spec",
    description:
      "Generate a whole site in one shot from a single spec instead of set_site field-by-field: sets the home page (title, tagline, theme, sections) and creates each initial sub-page. Persisted through the website store and rendered to site/. Pair with the generate_site prompt, which has Claude produce the spec.",
    inputSchema: {
      project: z.string(),
      title: z.string().describe("Site / home page title."),
      tagline: z.string().optional(),
      theme: z.enum(["light", "dark"]).optional(),
      sections: z.array(z.object({ heading: z.string(), body: z.string() })).optional().describe("Home page sections."),
      pages: z
        .array(
          z.object({
            slug: z.string(),
            title: z.string().optional(),
            sections: z.array(z.object({ heading: z.string(), body: z.string() })).optional(),
          })
        )
        .optional()
        .describe("Initial sub-pages to create."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, title, tagline, theme, sections, pages }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return scaffoldSite(board, project, { title, tagline, theme, sections, pages });
  })
);

server.registerTool(
  "edit_site_section",
  {
    title: "Edit a website section",
    description:
      "Live editor: patch one website section by index (heading and/or body), or append a new section when index is omitted. Re-renders the page.",
    inputSchema: {
      project: z.string(),
      index: z.number().int().optional().describe("Section index to patch; omit to append."),
      heading: z.string().optional(),
      body: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, index, heading, body }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return editSection(board, project, { index, heading, body });
  })
);

server.registerTool(
  "add_page",
  {
    title: "Add/update a website page",
    description:
      "Add or update a sub-page of the project site (rendered to site/<slug>.html), with its own title and sections. The home page stays managed by set_site. Re-renders all pages so theme/gate stay consistent.",
    inputSchema: {
      project: z.string(),
      slug: z.string().describe("URL slug for the page, e.g. 'about' → site/about.html."),
      title: z.string().optional(),
      sections: z.array(z.object({ heading: z.string(), body: z.string() })).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, slug, title, sections }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return addPage(board, project, { slug, title, sections });
  })
);

server.registerTool(
  "list_pages",
  {
    title: "List website pages",
    description: "List the site's pages: the home page (site/index.html) plus each sub-page with its slug, title, and file.",
    inputSchema: { project: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return listPages(board, project);
  })
);

server.registerTool(
  "remove_page",
  {
    title: "Remove a website page",
    description: "Delete a sub-page (by slug) and its rendered file. The home page can't be removed this way.",
    inputSchema: { project: z.string(), slug: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, slug }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return removePage(board, project, slug);
  })
);

server.registerTool(
  "deploy_site",
  {
    title: "Deploy the website",
    description:
      "Re-render the project's site and publish it by committing (and optionally pushing) its site/ folder through the git integration — the MCP equivalent of the old website deploy. Requires git integration enabled (set_git_config) with the site folder as a git repo; no-ops with a reason otherwise. Runs on this machine using its git credentials.",
    inputSchema: {
      project: z.string(),
      message: z.string().optional().describe("Custom deploy commit message."),
      push: z.boolean().optional().describe("Override the git config's push setting."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  writeTool(({ project, message, push }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    const rendered = renderSite(board, project);
    const deploy = commitFeature(
      board,
      project,
      { title: `Deploy ${project} site`, message, push },
      { cwd: siteRoot(board, project) }
    );
    return { rendered, deploy };
  })
);

server.registerTool(
  "upload_site_asset",
  {
    title: "Upload a website asset",
    description:
      "Store an image/asset under the site's assets/ folder (base64 by default, or utf8 text). Returns a ref like 'assets/logo.png' to use in page sections. Name must be a plain filename with an extension.",
    inputSchema: {
      project: z.string(),
      name: z.string().describe("Filename with extension, e.g. logo.png."),
      content: z.string().describe("Asset bytes: base64 (default) or utf8 text."),
      encoding: z.enum(["base64", "utf8"]).optional().default("base64"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, name, content, encoding }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return saveAsset(board, project, { name, content, encoding });
  })
);

server.registerTool(
  "list_site_assets",
  {
    title: "List website assets",
    description: "List the assets stored under the site's assets/ folder (name, ref, size).",
    inputSchema: { project: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return listAssets(board, project);
  })
);

server.registerTool(
  "set_site_analytics",
  {
    title: "Configure site analytics",
    description:
      "Add an analytics snippet to every page of the site's <head>: Plausible or Google Analytics by id, or a raw custom <script>. Re-renders the site. Set enabled:false to remove it.",
    inputSchema: {
      project: z.string(),
      provider: z.enum(["plausible", "ga", "ga4", "custom"]).optional(),
      id: z.string().optional().describe("Plausible domain or GA measurement id (e.g. G-XXXX)."),
      snippet: z.string().optional().describe("Raw <script> for provider 'custom'."),
      enabled: z.boolean().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  writeTool(({ project, provider, id, snippet, enabled }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return setSiteAnalytics(board, project, { provider, id, snippet, enabled });
  })
);

// external site analytics: config + auto-configure + read proxy (FBMCPF-83) -----

server.registerTool(
  "set_analytics_config",
  {
    title: "Configure external analytics",
    description:
      "Configure which external analytics provider to READ site traffic from (distinct from set_site_analytics, which injects tracking). Provider is plausible/umami/custom (Google Analytics needs an OAuth connector). No API key is stored — the read proxy reads it from the FEATUREBOARD_ANALYTICS_KEY env var. Set enabled:false to turn the proxy off.",
    inputSchema: {
      project: z.string(),
      provider: z.enum(["plausible", "umami", "ga", "custom"]).optional(),
      siteId: z.string().optional().describe("Plausible domain, umami website id, etc."),
      host: z.string().optional().describe("API host (e.g. plausible.io, or your self-hosted umami URL)."),
      statsUrl: z.string().optional().describe("For provider 'custom': the full stats endpoint ({period} is substituted)."),
      metrics: z.array(z.string()).optional().describe("Metrics to request, e.g. visitors, pageviews, bounce_rate."),
      period: z.string().optional().describe("Default window, e.g. 7d, 30d, month."),
      enabled: z.boolean().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  writeTool(({ project, provider, siteId, host, statsUrl, metrics, period, enabled }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return setAnalyticsConfig(board, project, { provider, siteId, host, statsUrl, metrics, period, enabled });
  })
);

server.registerTool(
  "auto_configure_analytics",
  {
    title: "Auto-configure external analytics",
    description:
      "Derive the external analytics read config from the site's existing tracking settings (set_site_analytics), so you don't retype the domain/property, and enable the proxy. Errors if the site has no analytics configured yet.",
    inputSchema: { project: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  writeTool(({ project }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return autoConfigureAnalytics(board, project);
  })
);

server.registerTool(
  "get_site_traffic",
  {
    title: "Get site traffic (analytics proxy)",
    description:
      "Read proxy for site traffic: fetch the configured provider's stats (Plausible/umami) using the FEATUREBOARD_ANALYTICS_KEY env var and return normalised numbers so the board can show traffic. Degrades gracefully — when disabled, unconfigured, or missing a key it returns the exact request URL so you can fetch it yourself.",
    inputSchema: {
      project: z.string(),
      period: z.string().optional().describe("Override the configured window, e.g. 7d, 30d."),
      metrics: z.array(z.string()).optional().describe("Override the configured metrics list."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  tryTool(async ({ project, period, metrics }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return getSiteTraffic(board, project, { period, metrics });
  })
);

// AI-assisted packaging config (FBMCPF-85) ---------------------------------

server.registerTool(
  "suggest_packaging",
  {
    title: "Suggest packaging metadata",
    description:
      "AI-gen seed: derive a draft of the .mcpb packaging metadata (name, displayName, description, keywords) from the project's config, brand, and products. Returns a draft to refine — it does NOT save. Refine it, then persist with save_packaging_config.",
    inputSchema: { project: z.string() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  tryTool(({ project }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return suggestPackaging(board, project);
  })
);

server.registerTool(
  "save_packaging_config",
  {
    title: "Save packaging config",
    description:
      "Persist the .mcpb packaging metadata for a project (packaging.json): name (slugified), displayName, description, longDescription, keywords, version. Validated by the same rules the build preflight uses; rejects hard errors (missing name/description). Only provided fields change.",
    inputSchema: {
      project: z.string(),
      name: z.string().optional(),
      displayName: z.string().optional(),
      description: z.string().optional(),
      longDescription: z.string().optional(),
      keywords: z.array(z.string()).optional(),
      version: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  writeTool(({ project, name, displayName, description, longDescription, keywords, version }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return savePackagingConfig(board, project, { name, displayName, description, longDescription, keywords, version });
  })
);

server.registerTool(
  "validate_packaging",
  {
    title: "Validate packaging metadata",
    description:
      "Run the build-preflight packaging checks against the project's saved packaging.json: reports hard errors (missing/invalid name or description) and advisory warnings (no keywords, missing displayName/longDescription).",
    inputSchema: { project: z.string() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  tryTool(({ project }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    const config = getPackagingConfig(board, project);
    return { project, config, validation: validatePackaging(config) };
  })
);

server.registerTool(
  "publish_media_to_site",
  {
    title: "Publish a media asset to the site",
    description:
      "Publish a gallery asset as a page on the project site (media/push-to-blog). A report/HTML/text asset becomes the page's content; an image is copied to site/assets and shown on the page. Returns the new page. Links media → website.",
    inputSchema: {
      project: z.string(),
      name: z.string().describe("Gallery asset filename (from list_media)."),
      slug: z.string().optional().describe("Page slug; defaults to the asset name."),
      title: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, name, slug, title }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    const et = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    const asset = getMedia(board, project, name, { withContent: true });
    const pageSlug = slug || name.replace(/\.[^.]+$/, "");
    const pageTitle = title || asset.title || name;
    let html;
    if (asset.kind === "image") {
      const saved = saveAsset(board, project, { name, content: asset.content, encoding: "base64" });
      html =
        `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
        `<meta name="viewport" content="width=device-width, initial-scale=1"><title>${et(pageTitle)}</title></head>` +
        `<body style="margin:0;text-align:center;background:#faf9f5"><img src="${saved.ref}" alt="${et(pageTitle)}" style="max-width:100%;height:auto"></body></html>`;
    } else {
      const c = String(asset.content || "");
      html = /<!doctype|<html/i.test(c)
        ? c
        : `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
          `<meta name="viewport" content="width=device-width, initial-scale=1"><title>${et(pageTitle)}</title></head><body>${c}</body></html>`;
    }
    const page = addRawPage(board, project, { slug: pageSlug, title: pageTitle, html });
    return { published: page.slug, path: page.path, from: name, kind: asset.kind };
  })
);

server.registerTool(
  "enable_login_gate",
  {
    title: "Enable the site login gate",
    description:
      "Turn on an optional passcode gate for the project's hosted site. NOTE: this is a soft client-side gate (the passcode ships in the page) — casual gating, NOT real authentication; real auth needs a hosting layer. Requires a passcode.",
    inputSchema: {
      project: z.string(),
      passcode: z.string().describe("Passcode visitors must enter."),
      message: z.string().optional().describe("Prompt shown to visitors."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  writeTool(({ project, passcode, message }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return setLoginGate(board, project, { enabled: true, passcode, message });
  })
);

server.registerTool(
  "disable_login_gate",
  {
    title: "Disable the site login gate",
    description: "Turn off the project site's passcode gate and re-render the page without it.",
    inputSchema: { project: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  writeTool(({ project }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return setLoginGate(board, project, { enabled: false });
  })
);

// Git integration (optional, opt-in) ---------------------------------------

server.registerTool(
  "get_git_config",
  {
    title: "Get git integration config",
    description: "Read the project's optional git integration settings (enabled, remote, branch, push, messagePrefix). Disabled by default.",
    inputSchema: { project: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return getGitConfig(board, project);
  })
);

server.registerTool(
  "set_git_config",
  {
    title: "Configure git integration",
    description:
      "Enable/configure optional per-project git integration so finished tickets can be committed (and optionally pushed) to the project's code repo. No secrets are stored — push uses the machine's own git credentials. Set codeLocation in project config to point at the repo.",
    inputSchema: {
      project: z.string(),
      enabled: z.boolean().optional(),
      remote: z.string().optional(),
      branch: z.string().optional(),
      push: z.boolean().optional().describe("Also push after committing."),
      messagePrefix: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  writeTool(({ project, enabled, remote, branch, push, messagePrefix }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return setGitConfig(board, project, { enabled, remote, branch, push, messagePrefix });
  })
);

server.registerTool(
  "commit_feature",
  {
    title: "Commit a finished feature",
    description:
      "If git integration is enabled for the project, commit (and optionally push) the current changes in the project's code repo with a message like 'FBMCPF-##: title' — mirroring the original OpenClaw git flow. No-ops with a reason when disabled. Runs on this machine using its git credentials.",
    inputSchema: {
      project: z.string(),
      ticket: z.string().optional(),
      title: z.string().optional(),
      message: z.string().optional().describe("Explicit commit message (overrides ticket/title)."),
      push: z.boolean().optional().describe("Override the config's push setting for this commit."),
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

// licensing ----------------------------------------------------------------

server.registerTool(
  "license_status",
  {
    title: "License status",
    description:
      "Report the current licensing state: usage tier, whether writes are allowed, and (for a commercial trial) time remaining. Call this if a write was blocked, or during onboarding.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(() => {
    const ev = license.evaluate(DATA_DIR);
    return { ...ev, contact: { url: license.LICENSE_CONTACT_URL, email: license.LICENSE_CONTACT_EMAIL } };
  })
);

server.registerTool(
  "set_usage_type",
  {
    title: "Set usage type (onboarding)",
    description:
      "Record how FeatureBoard is being used. 'personal' = private non-commercial (free). 'public' = public/open-source/nonprofit non-commercial (free). 'commercial-trial' = start a free 24-hour commercial evaluation (writes freeze after 24h). 'commercial' = commercial use (requires a license key via activate_license). Ask the user which applies before setting.",
    inputSchema: {
      type: z.enum(["personal", "public", "commercial-trial", "commercial"]),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  tryTool(({ type }) => {
    license.setUsageType(DATA_DIR, type);
    return license.evaluate(DATA_DIR);
  })
);

server.registerTool(
  "activate_license",
  {
    title: "Activate license key",
    description: "Activate a commercial license key received from the licensor. Verified offline. Unblocks writes for commercial use.",
    inputSchema: { key: z.string().describe("The signed license key string.") },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  tryTool(({ key }) => {
    license.activate(DATA_DIR, key);
    const ev = license.evaluate(DATA_DIR);
    return { activated: true, ...ev };
  })
);

server.registerTool(
  "request_commercial_license",
  {
    title: "Request a commercial license",
    description:
      "Start the commercial licensing process. Records the request locally (for the licensor's CRM) and returns the licensing URL and email to complete a signed agreement. After the licensor issues a key, use activate_license.",
    inputSchema: {
      name: z.string().describe("Your name / point of contact."),
      email: z.string().describe("Contact email."),
      company: z.string().describe("Company / organization name."),
      seats: z.number().int().optional().describe("Approximate number of seats needed."),
      notes: z.string().optional().describe("Anything else the licensor should know."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  tryTool(({ name, email, company, seats, notes }) => {
    const entry = license.recordRequest(DATA_DIR, { name, email, company, seats, notes });
    const subject = encodeURIComponent(`FeatureBoard commercial license — ${company}`);
    const body = encodeURIComponent(
      `Company: ${company}\nContact: ${name} <${email}>\nSeats: ${seats || "?"}\nRequest id: ${entry.id}\n\n${notes || ""}`
    );
    return {
      recorded: entry,
      next_steps:
        "Your request was recorded. Complete a signed agreement via the URL or email below; the licensor will issue a key you can activate with activate_license.",
      licensing_url: license.LICENSE_CONTACT_URL,
      email_to: license.LICENSE_CONTACT_EMAIL,
      mailto: `mailto:${license.LICENSE_CONTACT_EMAIL}?subject=${subject}&body=${body}`,
    };
  })
);

// prompts -------------------------------------------------------------------

// A one-click "turn this chat into a project". Claude already has the whole
// conversation in context, so the prompt just directs it to mine the chat and
// persist the result via plan_work.
server.registerPrompt(
  "project_from_chat",
  {
    title: "Turn this chat into a project",
    description:
      "Analyze the current conversation and create a FeatureBoard project from it — a project name plus features (new work) and bugs (issues raised).",
    argsSchema: {
      name: z
        .string()
        .optional()
        .describe("Optional project name. If omitted, propose one from the chat."),
    },
  },
  ({ name } = {}) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            "Turn our conversation so far into a FeatureBoard project.\n\n" +
            (name
              ? `Use the project name: "${name}".\n`
              : "1. Propose a short, clear project name based on what we discussed.\n") +
            "2. Read back through this chat and extract the concrete work:\n" +
            "   - features = new capabilities, tasks, or ideas to build\n" +
            "   - bugs = problems, defects, regressions, or issues raised\n" +
            "3. Call plan_work once with createProject:true to create the project and add those features and bugs. Keep titles short; put detail in each description. Where a chat item maps to an outside id, set its ref.\n" +
            "4. Show me the created tickets grouped by feature/bug.\n\n" +
            "If the scope is large or ambiguous, show me the proposed name and breakdown and let me adjust before you create anything.",
        },
      },
    ],
  })
);

server.registerPrompt(
  "process_next",
  {
    title: "Process the next ticket",
    description:
      "Pull the top ticket off the board's priority queue and work it end-to-end with the FeatureBoard work-packet loop.",
    argsSchema: {
      project: z.string().optional().describe("Board to work. If omitted, ask or infer."),
      continuous: z.string().optional().describe("'yes' to keep going through the queue until it's empty."),
    },
  },
  ({ project, continuous } = {}) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            `Work the FeatureBoard queue${project ? ` for project "${project}"` : ""} using the work-packet loop:\n` +
            "1. Call next_task to get the top open ticket (honours priority). If none, tell me the queue is clear and stop.\n" +
            "2. set_status the ticket to \"In Progress\".\n" +
            "3. Call get_work_packet for it. Read the files it points to at the code location — do not dump whole files into context.\n" +
            "4. Do the work. If it's a substantial or code ticket, dispatch it to a fresh sub-agent with the packet so it gets isolated context; do trivial tickets inline. Only you (the orchestrator) write to the board, and work one ticket at a time.\n" +
            "5. Verify the change — run it or its tests where relevant.\n" +
            "6. set_status Done with a one-line completionSummary, and log_work with additions/deletions (and the model used).\n" +
            (continuous === "yes"
              ? "7. Repeat from step 1 until the queue is empty, but pause to check in with me on anything ambiguous, risky, or destructive before proceeding."
              : "7. Then stop and report what you did and what's next in the queue."),
        },
      },
    ],
  })
);

server.registerPrompt(
  "generate_media",
  {
    title: "Generate a shareable report/image",
    description:
      "Generate a shareable web report (or image) for a goal and save it into the project's media/ gallery via save_media.",
    argsSchema: {
      project: z.string().optional().describe("Board whose media/ folder to save into."),
      goal: z.string().optional().describe("What the report/image should show."),
    },
  },
  ({ project, goal } = {}) => {
    const brand = project ? tryBrand(project) : null;
    return {
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            `Generate a shareable asset${project ? ` for project "${project}"` : ""} and save it to the media gallery.\n\n` +
            (goal ? `Goal: ${goal}\n\n` : "1. Ask me what the asset should show if it isn't clear.\n") +
            (brand && brand.hasBrand ? brand.instruction + "\n\n" : "") +
            "Steps:\n" +
            "- Check list_references for any uploaded reference images (media/uploads/) and work from them if present.\n" +
            "- Produce a self-contained, shareable HTML report (inline CSS, no external assets) — or an image if that fits better.\n" +
            "- For a real photographic/raster image, prefer the generate_image prompt (it routes through an image tool/connector and falls back to SVG).\n" +
            "- Call save_media with a descriptive filename (e.g. q3-summary.html), the content, a title, the prompt/goal, any tags, and the related ticket if there is one. Use encoding:'base64' for image bytes.\n" +
            "- Confirm what was saved and its media/ path, and mention it will now appear in list_media.",
        },
      },
    ],
    };
  }
);

server.registerPrompt(
  "generate_image",
  {
    title: "Generate a real image into the gallery",
    description:
      "Produce an actual raster image (via an image-generation tool/connector, if one is available) and save it to the project's media/ gallery as base64 — falling back to a self-contained SVG when no image generator is connected.",
    argsSchema: {
      project: z.string().optional().describe("Board whose media/ folder to save into."),
      goal: z.string().optional().describe("What the image should depict."),
      name: z.string().optional().describe("Filename to save as (e.g. hero.png). Defaults from the goal."),
      aspect: z.string().optional().describe("Optional aspect/size hint, e.g. '16:9', '1024x1024'."),
    },
  },
  ({ project, goal, name, aspect } = {}) => {
    const brand = project ? tryBrand(project) : null;
    const imageTool = project ? tryImageTool(project) : null;
    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Generate a real image${goal ? ` of: ${goal}` : ""}${project ? ` for project "${project}"` : ""} and save it to the media gallery.\n\n` +
              (goal ? "" : "1. Ask me what the image should depict if it isn't clear.\n") +
              (aspect ? `Aspect/size: ${aspect}\n` : "") +
              (brand && brand.hasBrand ? brand.instruction + "\n\n" : "") +
              "Steps:\n" +
              (imageTool
                ? `- Use the project's configured image tool "${imageTool}" to generate the image. If it isn't available, fall back to any other connected image-generation tool/connector/skill.\n`
                : "- Look for an available image-generation capability — a connected image MCP/connector or an image-gen skill (e.g. 'imagegen'). Use it to generate the image.\n") +
              "- Check list_references first for any uploaded reference images to guide style/subject.\n" +
              "- When you have the image bytes, call save_media with a .png/.jpg name" + (name ? ` (use "${name}")` : "") + ", encoding:'base64', a title, prompt set to the goal, and the related ticket if any. The project's brand words are recorded automatically.\n" +
              "- If NO image generator is available, do NOT fake a raster: instead produce a crisp, self-contained SVG that depicts the goal, save it as a .svg (encoding:'utf8'), and tell me it's a vector fallback — and that real raster generation needs an image tool (set one via set_project_config imageTool, or connect an image generator).\n" +
              "- Confirm what was saved, its media/ path, and that it now appears in list_media.",
          },
        },
      ],
    };
  }
);

server.registerPrompt(
  "generate_variations",
  {
    title: "Generate media variations",
    description:
      "Produce several alternative versions of an asset from one prompt/goal, saved as a group for side-by-side review.",
    argsSchema: {
      project: z.string().optional(),
      goal: z.string().optional().describe("What the asset should show."),
      count: z.string().optional().describe("How many variations (default 3)."),
    },
  },
  ({ project, goal, count } = {}) => {
    const brand = project ? tryBrand(project) : null;
    return {
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            `Generate ${count || "3"} variations${goal ? ` for: ${goal}` : ""}${project ? ` in project "${project}"` : ""}.\n\n` +
            (brand && brand.hasBrand ? brand.instruction + "\n\n" : "") +
            "Steps:\n" +
            "- Pick a short group id (e.g. a slug of the goal).\n" +
            `- Produce ${count || "3"} distinct takes on the goal (vary layout/tone/style).\n` +
            "- Save each with save_media using distinct names (e.g. <group>-1.html, <group>-2.html) and the SAME group id so they're siblings.\n" +
            "- Then call list_variations with that group id and show them side-by-side for the user to pick.",
        },
      },
    ],
    };
  }
);

server.registerPrompt(
  "refine_media",
  {
    title: "Refine a media asset",
    description:
      "Iterate on an existing gallery asset with a follow-up instruction, saving the result as a new version (its history is preserved).",
    argsSchema: {
      project: z.string().optional(),
      name: z.string().optional().describe("Gallery asset to refine."),
      instruction: z.string().optional().describe("How to change/improve it."),
    },
  },
  ({ project, name, instruction } = {}) => {
    const brand = project ? tryBrand(project) : null;
    return {
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            `Refine a media asset${name ? ` ("${name}")` : ""}${project ? ` in project "${project}"` : ""}.\n\n` +
            (instruction ? `Refinement: ${instruction}\n\n` : "1. Ask what to change if it isn't clear.\n") +
            (brand && brand.hasBrand ? brand.instruction + "\n\n" : "") +
            "Steps:\n" +
            "- get_media the asset (and note its existing versions) to see the current content + the prompt it came from.\n" +
            "- Produce the improved version applying the refinement, keeping the original intent.\n" +
            "- Call save_media with the SAME name (this archives the current copy as a prior version automatically) and set prompt to the refinement instruction so the chain is recorded.\n" +
            "- Confirm, and show the version list from get_media so the refinement chain is visible.",
        },
      },
    ],
    };
  }
);

server.registerPrompt(
  "share_media",
  {
    title: "Draft social share copy",
    description:
      "Draft suggested X and LinkedIn copy for a gallery item and save them as reviewable drafts (does not post).",
    argsSchema: {
      project: z.string().optional(),
      asset: z.string().optional().describe("Gallery asset to promote."),
    },
  },
  ({ project, asset } = {}) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            `Draft social share copy${asset ? ` for "${asset}"` : ""}${project ? ` in project "${project}"` : ""}.\n\n` +
            "Steps:\n" +
            `- Write a short, punchy X post (≤${platformLimit("x")} chars) and a longer, more detailed LinkedIn post.\n` +
            "- Save each with draft_share (platform 'x' and 'linkedin', with the asset).\n" +
            "- Show me both drafts for review. Do NOT post anything — there is no publishing connector; I'll post them myself or wire a connector later.",
        },
      },
    ],
  })
);

server.registerPrompt(
  "generate_site",
  {
    title: "Generate a whole website from one prompt",
    description:
      "From a single description, generate a complete site (title, tagline, theme, home sections, and initial sub-pages) and scaffold it in one shot with scaffold_site, instead of building it field-by-field.",
    argsSchema: {
      project: z.string().optional(),
      brief: z.string().optional().describe("What the site is for (audience, tone, what to include)."),
    },
  },
  ({ project, brief } = {}) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            `Generate a complete website${project ? ` for project "${project}"` : ""}.\n\n` +
            (brief ? `Brief: ${brief}\n\n` : "1. If the brief isn't clear, ask me a couple of quick questions first (audience, tone, pages).\n\n") +
            "Steps:\n" +
            "- Optionally call get_project_config to reuse the project's brand (title/voice) and products.\n" +
            "- Draft the full spec: a title and tagline, a theme (light/dark), 2–4 home-page sections (heading + a short paragraph each), and 1–3 initial sub-pages (e.g. pricing, about, contact) each with their own sections. Write real copy, not placeholders.\n" +
            "- Persist it in ONE call with scaffold_site (project, title, tagline, theme, sections, pages). Do not build it field-by-field.\n" +
            "- Then report the created home page + pages and note they were rendered to site/. Offer to tweak_site or add_page for follow-ups.",
        },
      },
    ],
  })
);

server.registerPrompt(
  "tweak_site",
  {
    title: "Tweak the website in natural language",
    description:
      "Apply a plain-English change to the project's website (e.g. 'make the tagline punchier', 'add a pricing section', 'switch to dark mode') and re-render.",
    argsSchema: {
      project: z.string().optional(),
      instruction: z.string().optional().describe("What to change on the site."),
    },
  },
  ({ project, instruction } = {}) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            `Tweak the website${project ? ` for project "${project}"` : ""}.\n\n` +
            (instruction ? `Change: ${instruction}\n\n` : "1. Ask me what to change if it isn't clear.\n") +
            "Steps:\n" +
            "- Call get_site (and list_pages if the change targets a sub-page) to see the current site.\n" +
            "- Apply the change with the smallest fitting tool: set_site (title/tagline/theme/sections), edit_site_section (one section), or add_page/remove_page (a page). Preserve everything you're not changing.\n" +
            "- Confirm what changed and note that the page(s) were re-rendered.",
        },
      },
    ],
  })
);

server.registerPrompt(
  "run_tests",
  {
    title: "Run the project's tests and record results",
    description:
      "Run the project's test suite(s), record each result with log_test_run, then show the consolidated per-suite view.",
    argsSchema: {
      project: z.string().optional(),
      suite: z.string().optional().describe("Limit to one suite/command, or omit to run them all."),
    },
  },
  ({ project, suite } = {}) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            `Run the tests${project ? ` for project "${project}"` : ""}${suite ? ` (suite: ${suite})` : ""} and record the results.\n\n` +
            "Steps:\n" +
            "- Find the test command from the project's codeLocation (get_project_config) — e.g. `npm test` / `node --test` — and run it in a shell.\n" +
            "- Parse the output for passed / failed / skipped counts" +
            (suite ? " for that suite." : ", per suite if the runner separates them.") +
            "\n- Record each with log_test_run (project, passed, failed, skipped, suite, and the related ticket if any).\n" +
            "- Then call test_runs_by_suite and summarize the latest status per suite, calling out any failing suites.",
        },
      },
    ],
  })
);

// boot ---------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdio server: keep process alive; errors go to stderr so they don't corrupt stdio JSON-RPC
}

main().catch((e) => {
  process.stderr.write(`FeatureBoard MCP failed to start: ${e.stack || e}\n`);
  process.exit(1);
});
