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
import { Board, parseImport, suggestTestStub, generateTestFromPrompt, bugImpactScan, computeRegressions, isBlocked } from "./storage.js";
import * as license from "./license.js";
import * as meta from "./metadata.js";
import { predictDueDates } from "./predictive.js";
import { createSprint, listSprints, assignSprint, sprintOfTask, planRollover, applyRollover, autoAssignSprintFields } from "./sprints.js";
import { buildReportPacket, closeSprint, getSprintReport, AUDIENCES } from "./reports.js";
import { graduateProject } from "./graduate.js";
import { estimateWork, planBudget, suggestModel, dailyPlan } from "./budget.js";
import { computeWaves } from "./planchain.js";
import { evalReport } from "./eval.js";
import { exportBoard, parsePmImport, exportWorkLog, exportMetricsSeries } from "./pmbridge.js";
import { setRequirements, getRequirements, checkAcceptance } from "./requirements.js";
import { parseFeedback, createFeedbackTickets, captureAsk } from "./feedback.js";
import { withOrchestrationLabels, findUnlabeledTickets, applyTriage } from "./orchestration.js";
import { notifySlack, notifyTicketEvent } from "./slack.js";
import { registerEmail } from "./registration.js";
import { addDecision, listDecisions, decisionsForTicket } from "./decisions.js";
import { writeHandoff } from "./handoffs.js";
import { getTicketHistory, agentMonitorV2, appendEvent, getTimelineData, appendHeartbeat, completedAtForTask } from "./events.js";
import { evaluateRules } from "./rules.js";
import { postProjectUpdate, getLatestUpdate, UPDATE_HEALTH } from "./updates.js";
import { getPricing, rollupCost } from "./pricing.js";
import { addKbDoc, listKbDocs, getKbDoc, searchKb } from "./kb.js";
import {
  listMedia, saveMedia, getMedia, revertMedia,
  tagMedia, annotateMedia, removeAnnotation, searchMedia,
  saveUpload, listUploads, editMediaText, listVariations,
  addComment, listComments, removeComment,
} from "./media.js";
import { startDriftRun, recordDriftScore, driftReport, applyDriftRemediation } from "./drift.js";
import { scanBoardCleanup, pruneBoard, scanTestFiles, dismissCleanupFinding } from "./cleanup.js";
import { listCodeTree, readCodeFile, codeFileMap, suggestFileSplit } from "./explorer.js";
import { saveTestPage, listTestPages, getTestPage, removeTestPage } from "./testpages.js";
import { groupBySuite, coverageByProduct, generateMultiModelTests, saveGeneratedTests, listVariants } from "./testing.js";
import { runVariantMatrix, formatEvidenceSection, appendEvidence } from "./modeleval.js";
import { draftShare, listShares, removeShare, platformLimit } from "./social.js";
import {
  addCompany, listCompanies, getCompany, setCompanyProducts, addContact, updateContact, removeContact,
  reportCompanyBug, resolveCompanyBug,
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
  getSite, setSite, editSection, setLoginGate, setPageSeo, addPage, listPages, removePage,
  listSiteTemplates, applySiteTemplate,
  renderSite, siteRoot, saveAsset, listAssets, setSiteAnalytics, addRawPage,
} from "./website.js";
import { getGitConfig, setGitConfig, commitFeature, mirrorGraduatedPad, getTicketDiff, getGlobalConfig, setGlobalConfig, resolveGitMode, evaluateCommitGate, reconcileChurn, getHistoryMap, suggestHistoricalFiles, openPullRequest } from "./git.js";
import { createWorktree, listWorktrees, cleanupWorktree, mergeBackGuidance } from "./worktrees.js";
import { addReviewComment, listReviewComments, resolveReviewComment, ticketsWithUnresolvedReviews } from "./reviews.js";
import { evaluateDoneGates } from "./gates.js";
import { scaffoldSite } from "./sitegen.js";
import { setAnalyticsConfig, autoConfigureAnalytics, getSiteTraffic } from "./analytics.js";
import { suggestPackaging, savePackagingConfig, getPackagingConfig, validatePackaging } from "./packaging.js";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import nodePath from "node:path";
import os from "node:os";
import { registerBoardTools } from "./register/board.js";
import { registerWorkflowTools } from "./register/workflow.js";
import { registerTaskTools } from "./register/tasks.js";
import { registerAnalyticsTools } from "./register/analytics.js";
import { registerTestingTools } from "./register/testing.js";
import { registerMediaTools } from "./register/media.js";
import { registerCrmTools } from "./register/crm.js";
import { registerSiteTools } from "./register/site.js";
import { registerGitTools } from "./register/git.js";
import { registerLicensingTools } from "./register/licensing.js";
import { registerPrompts } from "./register/prompts.js";

// FBMCPF-244: default the data dir when the host doesn't provide one — Cowork
// plugin installs have no user_config prompt (unlike the .mcpb flow), so
// boards land in ~/FeatureBoard unless FEATUREBOARD_DATA_DIR overrides it.
const DATA_DIR = process.env.FEATUREBOARD_DATA_DIR || nodePath.join(os.homedir(), "FeatureBoard");

// Absolute path to the shipped board UI. index.js lives in server/, the UI in
// artifact/board.html — so the packaged install always resolves it, regardless
// of cwd. Exposed to agents via the get_board tool (see below).
const SERVER_DIR = nodePath.dirname(fileURLToPath(import.meta.url));
const BOARD_HTML_PATH = nodePath.join(SERVER_DIR, "..", "artifact", "board.html");

// FBMCPB-19 — the board UI calls back into this server via a `call(tool, args)`
// wrapper (`window.cowork.callMcpTool("mcp__FeatureBoard__" + tool, args)`).
// get_board used to tell the calling agent to guess "this server's tools" for
// the artifact's mcp_tools allowlist, which drifted from what board.html
// actually calls (e.g. get_test_runs, get_scratchpad went missing). Instead,
// derive the allowlist straight from board.html's own call() sites so it can
// never drift again — whatever the UI calls IS the allowlist.
// NOTE: test/board_tools_parity.test.js re-implements this same extraction
// (it can't import this file — main() connects a stdio transport on import)
// to guard against silent regressions; keep the two in sync.
function extractBoardToolNames(html) {
  const names = new Set();
  const callRe = /\bcall\(/g;
  let m;
  while ((m = callRe.exec(html))) {
    const start = callRe.lastIndex;
    let depth = 1;
    let i = start;
    let firstArgEnd = -1;
    while (i < html.length && depth > 0) {
      const c = html[i];
      if (c === "(") depth++;
      else if (c === ")") {
        depth--;
        if (depth === 0) break;
      } else if (c === "," && depth === 1 && firstArgEnd === -1) {
        firstArgEnd = i;
      }
      i++;
    }
    const firstArg = html.slice(start, firstArgEnd === -1 ? i : firstArgEnd).trim();
    if (!firstArg) continue;
    // Ternary tool names (`type === "bug" ? "log_bug" : "add_feature"`): only
    // look at the two branches, never the condition (it may contain unrelated
    // quoted strings like "bug" that aren't tool names).
    const qmark = firstArg.indexOf("?");
    let branches;
    if (qmark === -1) {
      branches = [firstArg];
    } else {
      const rest = firstArg.slice(qmark + 1);
      const colon = rest.indexOf(":");
      branches = colon === -1 ? [rest] : [rest.slice(0, colon), rest.slice(colon + 1)];
    }
    for (const branch of branches) {
      const lit = branch.match(/^\s*["'`]([a-zA-Z_][a-zA-Z0-9_]*)["'`]\s*$/);
      if (lit) names.add(lit[1]);
    }
  }
  return [...names].sort();
}

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

const INSTRUCTIONS = `FeatureBoard is your task board for the user's projects. PROACTIVE BOARDING: a substantive, multi-step dev request (build/fix/ship/refactor X) IS a boarding event — run plan_work without being asked; the user should never have to say 'put it on the board'. Treat it as the place you plan and track work, not just a store you touch when asked.

When the user gives you a substantive, multi-step request (build X, fix these bugs, ship a feature):
1. Pick or create the board. Call list_projects; if nothing fits, create_project.
2. Break the request down onto the board. Use plan_work once to create the project (if needed) plus the initial features and bugs in a single step. Features are units of new work (FBF-###); bugs are defects (FBB-###).
3. Step 0: check the packet's gitTargets — code commits and projectpad commits can go to DIFFERENT repos; never assume. Work one ticket at a time. Call next_task to pull the next open item (it honours manual priority). set_status <ticket> "In Progress" BEFORE you start. Call get_work_packet to assemble a focused brief (scope, linked issue, code location, custom prompt, definition of done) and read the files it points to rather than dumping them. Each packet and next_task response now carries a \`dispatch\` block ({subAgent, model, cap, parallelizable, instruction}) — obey it: fan sonnet/haiku tickets out to parallel sub-agents when parallelizable and file-disjoint; keep opus/fable in the orchestrator. For a substantial or code ticket, dispatch it to a fresh sub-agent with that packet so it works in isolated context; do trivial tickets inline. Pick the sub-agent\u2019s model from the ticket\u2019s model: label (or the packet\u2019s suggestedModel): sonnet/haiku tickets may run as PARALLEL sub-agents; opus/fable tickets run SEQUENTIALLY with orchestrator review between. Match rigor to the effort: label — low: minimal exploration, obvious change, verify, stop; medium: normal loop with tests; high: read adjacent code, protect invariants and back-compat, add tests, self-review the diff. Dispatches running more than a couple minutes should show live progress, not just a generic \"multitasking\" wait: tell the sub-agent to call log_heartbeat a few times at natural milestones (a short phase note, plus model/elapsedMinutes/spend when known) — get_agent_monitor and the board's live/stall banners read these per ticket. As the orchestrator, emit your own one-line status when checking in on a running dispatch (ticket, model, elapsed, cap spend) so the user sees progress even before you next touch the board. Sub-agents NEVER write the board — the orchestrator alone sets status, logs work, and commits. Only you (the orchestrator) write to the board. When finished, set_status "Done" with a one-line completionSummary AND log_work with additions/deletions (and model) so progress is recorded. Write tools return compact acks by default (verbose:true for the full ticket) — do not re-fetch tickets you just wrote. If git is configured for the project, commit the change per ticket (commit_feature, message referencing the ticket id) before pulling the next. Then pull the next. (The process_next prompt runs this loop for you.)
4. Log new issues as you find them with log_bug, and split anything too big with decompose_feature.
5. When the user asks how things are going, use get_metrics and list_tasks rather than guessing.
6. Parallel dispatch (Cline-Kanban parity): when several ready tickets touch DISJOINT areas of the code, you may create an isolated git worktree per ticket (create_worktree) and dispatch one sub-agent per worktree in parallel - each sub-agent edits its own checked-out directory on branch ticket/<id>, never the shared repo working tree; the ticket packet's worktree block carries the path + branch + merge-back steps. Each parallel sub-agent should still call log_heartbeat at milestones so get_agent_monitor shows all of them progressing, not just whichever one last touched the board. Worktrees live OUTSIDE the repo (sibling <codeLocation>-worktrees/, configurable via the worktreeDir project config key) because under Cowork a worktree inside a synced repo mount can corrupt git internals. Board writes stay orchestrator-only. Merge branches back SERIALLY (one at a time): checkout the base branch, merge/rebase ticket/<id>, run tests, commit per ticket, then cleanup_worktree.

Keep the board honest: a ticket should be In Progress only while you are actively working it, and Done only when it is genuinely finished. The board is scaffolding around the real work — it does not replace writing the code, running the tests, etc. Do not create boards or tickets for trivial one-shot chores that don't benefit from tracking.

Showing the board: when the user asks to see, open, or check on the board in natural language — e.g. "show me the board", "show the featureboard", "open the board", "let's see the tasks/queue", "what's on my plate", "how's it going / how are we looking", "give me a status", or "show velocity/analytics" — call the get_board tool and render the HTML it returns as a Cowork artifact (create_artifact with id "featureboard-board", or update_artifact if one is already open — reuse it, don't create duplicates). Do NOT hand-write your own board or reply only in text: get_board returns the shipped UI, which already has the Todo / In Progress / Done columns, the product filter, the dark/light theme toggle, and the 📊 Analytics dashboard (velocity, timeline, bug health, and the work-log feed) — tasks + analytics + everything in one place. Use the mcp_tools array get_board returns VERBATIM as the artifact's mcp_tools (don't hand-pick tools from memory) so its buttons and charts work. Pair the artifact with a one- or two-line text summary of where things stand.`;

const server = new McpServer(
  { name: "featureboard", version: "0.3.3" },
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
  "validate_feedback", "capture_ask", "export_metrics",
  "decompose_feature", "log_bug", "list_tasks", "get_task", "get_metrics",
  "get_health", "get_work_log", "get_scratchpad", "set_scratchpad", "next_task",
  "set_status", "get_work_packet", "log_work", "update_task", "delete_task",
  "link_tasks", "license_status", "activate_license", "request_commercial_license",
  "set_usage_type", "register_email",
  // used by the board UI artifact (keep the panels working in core mode)
  "import_tasks", "get_regressions", "get_test_runs", "append_scratchpad",
  // sprints (FBMCPF-120)
  "create_sprint", "list_sprints", "assign_sprint",
  // graduation (FBMCPF-150)
  "graduate_project",
  // budgeting (FBMCPF-123/124) + daily planning (FBMCPF-152)
  "estimate_work", "plan_budget", "daily_plan",
  // eval + PM bridge + requirements (FBMCPF-128/143/138)
  "eval_report", "export_tasks", "set_requirements", "get_requirements", "check_acceptance",
  // decisions + handoffs (FBMCPF-139/144)
  "add_decision", "list_decisions", "set_handoff", "get_ticket_history",
  "get_timeline_data",
  // per-ticket diff + review comments (FBMCPF-135)
  "get_ticket_diff", "add_review_comment", "list_review_comments", "resolve_review_comment",
  // knowledge base (FBMCPF-141)
  "add_kb_doc", "list_kb_docs", "search_kb", "get_kb_doc",
  // FBMCPF-206: board.html also calls these — needed for the live monitor banner,
  // global git-config panel, and sprint-report panel to work in core mode.
  "get_agent_monitor", "get_global_config", "set_global_config", "get_sprint_report",
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
                `Buy a key (US$${license.PRICE_PER_SEAT_YEAR_USD}/seat/yr) at ${license.CHECKOUT_URL} and enter it with activate_license, ` +
                `or start custom licensing with request_commercial_license.`,
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
    blockedBy: t.blockedBy,
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

const StatusEnum = z.enum(["Todo", "In Progress", "Review", "Done"]);


// Shared bindings handed to every register/*.js module (FBMCPF-224).
const ctx = {
  AUDIENCES, BOARD_HTML_PATH, Board, DATA_DIR, McpServer, SERVER_DIR, StatusEnum, StdioServerTransport, UPDATE_HEALTH, addAgreement, addComment, addCompany, addContact, addDecision, addInboxMessage, addInteraction, addKbDoc, addLead, addLeadArea, addPage, addRawPage, addReviewComment, agentMonitorV2, annotateMedia, appendEvent, appendEvidence, appendHeartbeat, applyDriftRemediation, applyRollover, applySiteTemplate, applyTriage, assignSprint, autoAssignSprintFields, autoConfigureAnalytics, book, bugImpactScan, buildCustomerPortal, buildReportPacket, cancelBooking, captureAsk, checkAcceptance, cleanupWorktree, closeSprint, codeFileMap, commitFeature, compactView, companiesForTicket, companyPriorityTickets, completedAtForTask, computeRegressions, computeWaves, convertLead, coverageByProduct, createCampaign, createFeedbackTickets, createSprint, createWorktree, dailyPlan, decisionsForTicket, dismissCleanupFinding, draftEmail, draftShare, driftReport, editMediaText, editSection, enrichLead, estimateWork, evalReport, evaluateCommitGate, evaluateDoneGates, evaluateRules, existsSync, exportBoard, exportMetricsSeries, exportWorkLog, extractBoardToolNames, fail, fileURLToPath, findUnlabeledTickets, formatEvidenceSection, fullView, generateContract, generateMultiModelTests, generateTestFromPrompt, getBoard, getCampaign, getCompany, getEmail, getGitConfig, getGlobalConfig, getHistoryMap, getKbDoc, getLatestUpdate, getMedia, getPackagingConfig, getPricing, getRequirements, getSite, getSiteTraffic, getSprintReport, getTestPage, getTicketDiff, getTicketHistory, getTimelineData, graduateProject, groupBySuite, isBlocked, leadsMap, license, linkTicket, listAssets, listBookings, listCampaigns, listCodeTree, listComments, listCompanies, listDecisions, listInbox, listKbDocs, listLeadAreas, listLeads, listMail, listMedia, listPages, listReviewComments, listShares, listSiteTemplates, listSprints, listTemplates, listTestPages, listUploads, listVariants, listVariations, listWorktrees, markSent, mergeBackGuidance, meta, mirrorGraduatedPad, nodePath, notifySlack, notifyTicketEvent, ok, openPullRequest, os, parseFeedback, parseImport, parsePmImport, planBudget, planRollover, platformLimit, postProjectUpdate, predictDueDates, pruneBoard, readCodeFile, readFileSync, readdirSync, reconcileChurn, recordDriftScore, recordOpen, registerEmail, removeAgreement, removeAnnotation, removeComment, removeContact, removePage, removeShare, removeTestPage, renderSite, reportCompanyBug, resolveCompanyBug, resolveGitMode, resolveReviewComment, revertMedia, reviewInboxMessage, rollupCost, runVariantMatrix, saveAsset, saveGeneratedTests, saveMedia, savePackagingConfig, saveTestPage, saveUpload, scaffoldSite, scanBoardCleanup, scanTestFiles, searchKb, searchMedia, setAnalyticsConfig, setCompanyProducts, setGitConfig, setGlobalConfig, setLeadStatus, setLoginGate, setPageSeo, setRequirements, setSite, setSiteAnalytics, siteRoot, sprintOfTask, startDriftRun, submitIntake, suggestFileSplit, suggestHistoricalFiles, suggestModel, suggestPackaging, suggestTestStub, tagMedia, ticketsWithUnresolvedReviews, trim, tryBrand, tryImageTool, tryTool, unlinkTicket, updateAgreement, updateContact, updateLeadLocation, validatePackaging, withOrchestrationLabels, writeHandoff, writeTool, z
};

// Register all tool/prompt domains (order preserved from the original file).
registerBoardTools(server, ctx);
registerWorkflowTools(server, ctx);
registerTaskTools(server, ctx);
registerAnalyticsTools(server, ctx);
registerTestingTools(server, ctx);
registerMediaTools(server, ctx);
registerCrmTools(server, ctx);
registerSiteTools(server, ctx);
registerGitTools(server, ctx);
registerLicensingTools(server, ctx);
registerPrompts(server, ctx);

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
