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
} from "./media.js";
import { draftShare, listShares, removeShare, platformLimit } from "./social.js";
import {
  addCompany, listCompanies, getCompany, addContact,
  addInboxMessage, listInbox, reviewInboxMessage,
  linkTicket, unlinkTicket, companiesForTicket,
} from "./crm.js";
import { addLead, listLeads, setLeadStatus, leadsMap } from "./leads.js";
import { buildCustomerPortal } from "./portal.js";
import { listTemplates, generateContract } from "./contracts.js";
import { draftEmail, listMail, getEmail, markSent } from "./mail.js";
import { createCampaign, listCampaigns, getCampaign, recordOpen } from "./campaigns.js";
import {
  getSite, setSite, editSection, setLoginGate, addPage, listPages, removePage,
  renderSite, siteRoot, saveAsset, listAssets, setSiteAnalytics,
} from "./website.js";
import { getGitConfig, setGitConfig, commitFeature } from "./git.js";

const DATA_DIR = process.env.FEATUREBOARD_DATA_DIR;

function getBoard() {
  if (!DATA_DIR) {
    throw new Error(
      "No boards folder configured. Set the 'Boards folder' in the FeatureBoard extension settings."
    );
  }
  return new Board(DATA_DIR);
}

const INSTRUCTIONS = `FeatureBoard is your task board for the user's projects. Treat it as the place you plan and track work, not just a store you touch when asked.

When the user gives you a substantive, multi-step request (build X, fix these bugs, ship a feature):
1. Pick or create the board. Call list_projects; if nothing fits, create_project.
2. Break the request down onto the board. Use plan_work once to create the project (if needed) plus the initial features and bugs in a single step. Features are units of new work (FBF-###); bugs are defects (FBB-###).
3. Work one ticket at a time. Call next_task to pull the next open item (it honours manual priority). set_status <ticket> "In Progress" BEFORE you start. Call get_work_packet to assemble a focused brief (scope, linked issue, code location, custom prompt, definition of done) and read the files it points to rather than dumping them. For a substantial or code ticket, dispatch it to a fresh sub-agent with that packet so it works in isolated context; do trivial tickets inline. Only you (the orchestrator) write to the board. When finished, set_status "Done" with a one-line completionSummary AND log_work with additions/deletions (and model) so progress is recorded. Then pull the next. (The process_next prompt runs this loop for you.)
4. Log new issues as you find them with log_bug, and split anything too big with decompose_feature.
5. When the user asks how things are going, use get_metrics and list_tasks rather than guessing.

Keep the board honest: a ticket should be In Progress only while you are actively working it, and Done only when it is genuinely finished. The board is scaffolding around the real work — it does not replace writing the code, running the tests, etc. Do not create boards or tickets for trivial one-shot chores that don't benefit from tracking.`;

const server = new McpServer(
  { name: "featureboard", version: "0.1.0" },
  { instructions: INSTRUCTIONS }
);

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
            priority: z.number().int().optional(),
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
            priority: z.number().int().optional(),
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
            priority: z.number().int().optional(),
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
      priority: z.number().int().nullable().optional().describe("Manual priority rank (1 = highest), or null to clear."),
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
      "List a project's media gallery: images and shareable HTML reports in its media/ folder, with creation date, size, kind (image/report/other), and any sidecar metadata (title, tags, linked ticket) from <asset>.meta.json. Read-only; returns an empty gallery if the project has no media/ folder yet. Optionally filter by kind.",
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
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, name, content, encoding, title, prompt, tags, ticket }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return saveMedia(board, project, { name, content, encoding, title, prompt, tags, ticket });
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
    description: "List the project's CRM companies (id, name, domain, contact count), alphabetical by name.",
    inputSchema: { project: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return listCompanies(board, project);
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
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, subject, body, from, company }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return addInboxMessage(board, project, { subject, body, from, company });
  })
);

server.registerTool(
  "list_crm_inbox",
  {
    title: "List CRM inbox",
    description: "List CRM inbox messages (newest-first), optionally filtered by status (pending/approved/rejected) and/or company.",
    inputSchema: {
      project: z.string(),
      status: z.enum(["pending", "approved", "rejected"]).optional(),
      company: z.string().optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, status, company }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return listInbox(board, project, { status, company });
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
  ({ project, goal } = {}) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            `Generate a shareable asset${project ? ` for project "${project}"` : ""} and save it to the media gallery.\n\n` +
            (goal ? `Goal: ${goal}\n\n` : "1. Ask me what the asset should show if it isn't clear.\n") +
            "Steps:\n" +
            "- Produce a self-contained, shareable HTML report (inline CSS, no external assets) — or an image if that fits better.\n" +
            "- Call save_media with a descriptive filename (e.g. q3-summary.html), the content, a title, the prompt/goal, any tags, and the related ticket if there is one. Use encoding:'base64' for image bytes.\n" +
            "- Confirm what was saved and its media/ path, and mention it will now appear in list_media.",
        },
      },
    ],
  })
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
