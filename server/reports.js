/**
 * FBMCPF-156: audience-specific sprint close-out reports.
 *
 * When a sprint closes (all its tickets Done, or the user forces it) we turn the
 * sprint's tickets + work log + metrics into four reports, one per audience:
 *
 *   marketing  — features shipped, positioning-ready (factual) copy
 *   sales      — customer-facing capabilities + the CRM tickets they resolve
 *   technical  — per-ticket changes, commits, tests, ADRs touched
 *   executive  — velocity, spend vs budget, health, risks
 *
 * Two paths, sharing one packet:
 *   - deterministic: renderReport(packet, audience) draws structured markdown
 *     straight from the data — no LLM, byte-stable, safe to commit as a pad.
 *   - generate-via-prompt: buildReportPrompt(packet, audience) hands the calling
 *     agent the packet + an audience brief so it can draft richer copy itself.
 *
 * Storage mirrors the other pad modules (decisions.js / requirements.js): reports
 * live under the project dir at reports/<slug>/<audience>.md, with a manifest.json
 * per sprint so the board and get_sprint_report can list what's been generated.
 *
 * Imports: node builtins plus the read-only helpers from sibling modules
 * (sprints/pricing/metadata/decisions/crm/budget). Nothing imports THIS module
 * except index.js, so pulling those in can't create an import cycle.
 */

import fs from "node:fs";
import path from "node:path";
import { sprintOfTask } from "./sprints.js";
import { readWorkLog, velocity, getProjectConfig } from "./metadata.js";
import { getPricing, rollupCost, costOfEvent } from "./pricing.js";
import { decisionsForTicket } from "./decisions.js";
import { companiesForTicket } from "./crm.js";
import { capOfTask } from "./budget.js";
import { recordedCommitsForTicket } from "./events.js";

export const AUDIENCES = ["marketing", "sales", "technical", "executive"];
const REPORTS_DIR = "reports";
const MANIFEST_FILE = "manifest.json";

// ---------------------------------------------------------------------------
// small local helpers (kept in-module so reports.js stays self-contained)
// ---------------------------------------------------------------------------

function atomicWrite(p, content) {
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, p);
}

/** Filesystem-safe directory name for a sprint (its display name is kept in the manifest). */
export function slugify(name) {
  const s = String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "sprint";
}

function fmtInt(n) {
  return Number(n || 0).toLocaleString("en-US");
}

function fmtUsd(n) {
  const v = Number(n || 0);
  return v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(4)}`;
}

/** Human token count, e.g. 12.3k / 4.5M. */
function fmtTokens(n) {
  const v = Number(n || 0);
  if (v >= 1e6) return `${Math.round(v / 1e5) / 10}M`;
  if (v >= 1e3) return `${Math.round(v / 100) / 10}k`;
  return String(v);
}

/** Pull commit-ish refs out of a work-log line ("commit abc1234", bare 7–40-hex shas). */
function extractCommits(text) {
  if (!text) return [];
  const out = new Set();
  const re = /\b[0-9a-f]{7,40}\b/gi;
  let m;
  while ((m = re.exec(text))) out.add(m[0].toLowerCase());
  return [...out];
}

function uniqueBy(arr, key) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const k = key(x);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

// ---------------------------------------------------------------------------
// packet building
// ---------------------------------------------------------------------------

/**
 * Gather everything the four reports draw from for one sprint: its tickets
 * (Done + carryover), work-log entries scoped to those tickets, velocity /
 * cost metrics, commits (best-effort from the work log), ADRs touched, and CRM
 * ticket links. Pure read — never writes. Throws only when the sprint has no
 * tickets at all (nothing to report on).
 */
export function buildReportPacket(board, project, sprintName, { now = new Date() } = {}) {
  const name = String(sprintName || "").trim();
  if (!name) throw new Error("Sprint name is required.");

  const allTasks = board.listTasks(project, {});
  const mine = allTasks.filter((t) => (sprintOfTask(t) || "").toLowerCase() === name.toLowerCase());
  if (!mine.length) {
    throw new Error(`Sprint "${name}" has no tickets (assign tickets with a sprint:${name} label first).`);
  }
  // preserve the display casing actually used on the tickets
  const display = sprintOfTask(mine[0]) || name;

  // sprint registry meta (goal / dates), if registered
  let goal = null, start = null, end = null;
  try {
    const cfg = getProjectConfig(board, project);
    const reg = Array.isArray(cfg.sprints) ? cfg.sprints : [];
    const s = reg.find((x) => x && x.name && x.name.toLowerCase() === name.toLowerCase());
    if (s) { goal = s.goal || null; start = s.start || null; end = s.end || null; }
  } catch { /* no config — fine */ }

  const pricing = getPricing(board, project);
  const log = readWorkLog(board, project);
  const ticketIds = new Set(mine.map((t) => t.ticketNumber));
  const sprintLog = log.filter((e) => e.ticket && ticketIds.has(e.ticket));

  // per-ticket aggregation from the work log
  const agg = new Map();
  for (const e of sprintLog) {
    const a = agg.get(e.ticket) || { additions: 0, deletions: 0, tokens: 0, cost: 0, model: null, commits: [] };
    a.additions += e.additions || 0;
    a.deletions += e.deletions || 0;
    a.tokens += e.tokens || (e.inputTokens || 0) + (e.outputTokens || 0) || 0;
    a.cost += costOfEvent(e, pricing);
    if (e.model) a.model = e.model;
    a.commits.push(...extractCommits(e.text));
    agg.set(e.ticket, a);
  }

  const tickets = mine
    .slice()
    .sort((a, b) => (a.ticketNumber < b.ticketNumber ? -1 : 1))
    .map((t) => {
      const a = agg.get(t.ticketNumber) || { additions: 0, deletions: 0, tokens: 0, cost: 0, model: null, commits: [] };
      let adrs = [];
      try { adrs = decisionsForTicket(board, project, t.ticketNumber).map((d) => ({ id: d.id, title: d.title })); } catch { adrs = []; }
      let customers = [];
      try { customers = (companiesForTicket(board, project, t.ticketNumber).companies || []).map((c) => ({ id: c.id, name: c.name })); } catch { customers = []; }
      // FBMCPB-23: prefer commit_feature's recorded commit events (real
      // correlation, FBMCPF-188) over hash-shaped substrings regexed out of
      // work-log prose; the regex path stays as a legacy fallback only.
      let commits = [];
      try { commits = recordedCommitsForTicket(board, project, t.ticketNumber).map((h) => h.slice(0, 8)); } catch { commits = []; }
      if (!commits.length) commits = [...new Set(a.commits)];
      return {
        ticket: t.ticketNumber,
        type: t.type || "feature",
        title: t.title || "",
        description: t.description || "",
        status: t.status,
        done: t.status === "Done",
        completionSummary: t.completionSummary || null,
        completionDate: t.completionDate || null,
        product: t.product || null,
        priority: t.priority != null ? t.priority : null,
        labels: t.labels || [],
        additions: a.additions,
        deletions: a.deletions,
        tokens: a.tokens,
        cost: Math.round(a.cost * 1e4) / 1e4,
        model: a.model,
        cap: capOfTask(t),
        commits,
        adrs,
        customers,
      };
    });

  const doneTickets = tickets.filter((t) => t.done);
  const carryoverTickets = tickets.filter((t) => !t.done);
  const closed = tickets.length > 0 && carryoverTickets.length === 0;

  const v = velocity(sprintLog);
  const cost = rollupCost(sprintLog, pricing);
  const capTotal = tickets.reduce((s, t) => s + (t.cap || 0), 0);
  const spendTotal = v.totals.tokens || 0;

  const adrs = uniqueBy(tickets.flatMap((t) => t.adrs), (d) => d.id);
  const customers = uniqueBy(tickets.flatMap((t) => t.customers), (c) => c.id);
  const commits = [...new Set(tickets.flatMap((t) => t.commits))];

  return {
    project,
    generatedAt: now.toISOString(),
    sprint: { name: display, slug: slugify(display), goal, start, end },
    closed,
    tickets,
    doneTickets,
    carryoverTickets,
    metrics: {
      total: tickets.length,
      done: doneTickets.length,
      carryover: carryoverTickets.length,
      completionPct: tickets.length ? Math.round((doneTickets.length / tickets.length) * 100) : 0,
      velocity: {
        tokens: v.totals.tokens,
        additions: v.totals.additions,
        deletions: v.totals.deletions,
        events: v.totals.events,
        activeDays: v.totals.activeDays,
      },
      cost: { totalCost: cost.totalCost, byModel: cost.byModel },
      budget: {
        capTotal,
        spendTotal,
        ratio: capTotal ? Math.round((spendTotal / capTotal) * 1000) / 1000 : null,
        overCap: tickets.filter((t) => t.cap && t.tokens > t.cap).map((t) => ({ ticket: t.ticket, cap: t.cap, tokens: t.tokens })),
      },
    },
    adrs,
    customers,
    commits,
  };
}

// ---------------------------------------------------------------------------
// deterministic renderers
// ---------------------------------------------------------------------------

function header(packet, audience, label) {
  const { sprint } = packet;
  const dates = sprint.start || sprint.end ? ` · ${sprint.start || "?"} → ${sprint.end || "?"}` : "";
  const lines = [
    `# ${label} — ${sprint.name}`,
    `*${packet.project} · sprint close-out${dates} · generated ${packet.generatedAt.slice(0, 10)}*`,
  ];
  if (sprint.goal) lines.push("", `**Sprint goal:** ${sprint.goal}`);
  if (!packet.closed) {
    lines.push("", `> ⚠️ Sprint closed with ${packet.metrics.carryover} open ticket(s) — carryover is listed below.`);
  }
  return lines.join("\n");
}

function byProduct(tickets) {
  const groups = new Map();
  for (const t of tickets) {
    const k = t.product || "General";
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function renderMarketing(packet) {
  const shipped = packet.doneTickets.filter((t) => t.type !== "bug");
  const fixes = packet.doneTickets.filter((t) => t.type === "bug");
  const out = [header(packet, "Marketing report", "📣 Marketing")];

  out.push("", "## Headline", "");
  out.push(`${shipped.length} feature${shipped.length === 1 ? "" : "s"} shipped${fixes.length ? `, ${fixes.length} fix${fixes.length === 1 ? "" : "es"} landed` : ""} in ${packet.sprint.name}.`);

  out.push("", "## Features shipped", "");
  if (!shipped.length) {
    out.push("_No features completed this sprint._");
  } else {
    for (const [prod, items] of byProduct(shipped)) {
      out.push(`### ${prod}`, "");
      for (const t of items) {
        const desc = t.completionSummary || t.description || "";
        out.push(`- **${t.title}**${desc ? ` — ${desc}` : ""} (${t.ticket})`);
      }
      out.push("");
    }
  }

  out.push("## Positioning-ready copy", "");
  out.push("_Factual, launch-ready lines — verify claims before publishing._", "");
  if (!shipped.length) {
    out.push("- _Nothing new to announce this sprint._");
  } else {
    for (const t of shipped) {
      const detail = t.completionSummary || t.description || "";
      out.push(`- **Now available: ${t.title}.**${detail ? ` ${detail}` : ""}`);
    }
  }

  if (fixes.length) {
    out.push("", "## Reliability & fixes", "");
    for (const t of fixes) out.push(`- ${t.title}${t.completionSummary ? ` — ${t.completionSummary}` : ""} (${t.ticket})`);
  }

  out.push("", "---", `_${shipped.length} features · ${fixes.length} fixes · ${packet.metrics.done}/${packet.metrics.total} tickets done._`);
  return out.join("\n") + "\n";
}

function renderSales(packet) {
  const capabilities = packet.doneTickets.filter((t) => t.type !== "bug");
  const out = [header(packet, "Sales report", "💼 Sales")];

  out.push("", "## New customer-facing capabilities", "");
  if (!capabilities.length) {
    out.push("_No customer-facing capabilities shipped this sprint._");
  } else {
    for (const t of capabilities) {
      const detail = t.completionSummary || t.description || "";
      out.push(`- **${t.title}** — ${detail || "shipped this sprint"} (${t.ticket})`);
    }
  }

  out.push("", "## Talk track", "");
  out.push("_Keep it factual; these map 1:1 to shipped tickets._", "");
  if (!capabilities.length) {
    out.push("- _No new talking points this sprint._");
  } else {
    for (const t of capabilities) out.push(`- You can now ${t.title.charAt(0).toLowerCase() + t.title.slice(1)}.`);
  }

  out.push("", "## Customer tickets resolved", "");
  const linked = packet.doneTickets.filter((t) => t.customers.length);
  if (!linked.length) {
    out.push("_No shipped tickets are linked to CRM customers (link them with link_customer_ticket)._");
  } else {
    for (const t of linked) {
      const who = t.customers.map((c) => c.name || c.id).join(", ");
      out.push(`- **${t.ticket}** ${t.title} → ${who}`);
    }
  }

  if (packet.carryoverTickets.length) {
    out.push("", "## Coming soon (carryover)", "");
    for (const t of packet.carryoverTickets.filter((t) => t.type !== "bug")) {
      out.push(`- ${t.title} (${t.ticket}, ${t.status})`);
    }
  }

  out.push("", "---", `_${capabilities.length} capabilities · ${linked.length} linked customer ticket(s)._`);
  return out.join("\n") + "\n";
}

function renderTechnical(packet) {
  const out = [header(packet, "Technical report", "🛠️ Technical")];

  out.push("", "## Per-ticket changes", "");
  if (!packet.tickets.length) {
    out.push("_No tickets in this sprint._");
  } else {
    for (const t of packet.tickets) {
      out.push(`### ${t.ticket} — ${t.title}  \`${t.status}\``);
      const meta = [];
      if (t.product) meta.push(`product: ${t.product}`);
      if (t.model) meta.push(`model: ${t.model}`);
      meta.push(`+${fmtInt(t.additions)}/−${fmtInt(t.deletions)}`);
      if (t.tokens) meta.push(`${fmtTokens(t.tokens)} tokens`);
      if (t.cost) meta.push(fmtUsd(t.cost));
      out.push(`- ${meta.join(" · ")}`);
      if (t.completionSummary) out.push(`- Summary: ${t.completionSummary}`);
      if (t.commits.length) out.push(`- Commits: ${t.commits.map((c) => `\`${c.slice(0, 10)}\``).join(", ")}`);
      if (t.adrs.length) out.push(`- ADRs touched: ${t.adrs.map((d) => `${d.id} (${d.title})`).join("; ")}`);
      out.push("");
    }
  }

  out.push("## Architecture decisions touched", "");
  if (!packet.adrs.length) out.push("_No ADRs referenced by this sprint's tickets._");
  else for (const d of packet.adrs) out.push(`- ${d.id}: ${d.title}`);

  out.push("", "## Change totals", "");
  const v = packet.metrics.velocity;
  out.push(`- Lines: +${fmtInt(v.additions)} / −${fmtInt(v.deletions)} across ${v.events} work session(s)`);
  out.push(`- Tokens: ${fmtTokens(v.tokens)} · Cost: ${fmtUsd(packet.metrics.cost.totalCost)}`);
  out.push(`- Commits recorded: ${packet.commits.length}`);

  if (packet.carryoverTickets.length) {
    out.push("", "## Carryover (not Done)", "");
    for (const t of packet.carryoverTickets) out.push(`- ${t.ticket} ${t.title} — ${t.status}`);
  }

  out.push("", "---", `_${packet.metrics.done}/${packet.metrics.total} tickets Done · ${packet.adrs.length} ADR(s) · ${packet.commits.length} commit(s)._`);
  return out.join("\n") + "\n";
}

function renderExecutive(packet) {
  const m = packet.metrics;
  const out = [header(packet, "Executive report", "📈 Executive")];

  out.push("", "## Velocity", "");
  out.push(`- Tickets: **${m.done}/${m.total} done** (${m.completionPct}%)${m.carryover ? `, ${m.carryover} carryover` : ""}`);
  out.push(`- Lines changed: +${fmtInt(m.velocity.additions)} / −${fmtInt(m.velocity.deletions)}`);
  out.push(`- Active days: ${m.velocity.activeDays} · work sessions: ${m.velocity.events}`);

  out.push("", "## Spend vs budget", "");
  out.push(`- Total spend: **${fmtUsd(m.cost.totalCost)}** (${fmtTokens(m.velocity.tokens)} tokens)`);
  if (m.budget.capTotal) {
    const pct = m.budget.ratio != null ? `${Math.round(m.budget.ratio * 100)}%` : "n/a";
    out.push(`- Token budget (sum of caps): ${fmtTokens(m.budget.capTotal)} — used ${pct}`);
  } else {
    out.push("- No token caps set on this sprint's tickets (no budget to compare against).");
  }
  const models = Object.keys(m.cost.byModel || {});
  if (models.length) {
    out.push(`- By model: ${models.map((k) => `${k} ${fmtUsd(m.cost.byModel[k].cost)}`).join(" · ")}`);
  }

  out.push("", "## Health", "");
  const health = m.completionPct >= 100 ? "🟢 on track (all Done)" : m.completionPct >= 60 ? "🟡 mostly complete" : "🔴 at risk";
  out.push(`- Completion: ${m.completionPct}% — ${health}`);
  out.push(`- Customer tickets touched: ${packet.customers.length}`);

  out.push("", "## Risks & follow-ups", "");
  const risks = [];
  if (m.carryover) risks.push(`${m.carryover} ticket(s) rolled over: ${packet.carryoverTickets.map((t) => t.ticket).join(", ")}`);
  for (const o of m.budget.overCap) risks.push(`${o.ticket} exceeded its cap (${fmtTokens(o.tokens)} vs ${fmtTokens(o.cap)})`);
  if (!risks.length) risks.push("None flagged — sprint closed clean.");
  for (const r of risks) out.push(`- ${r}`);

  out.push("", "---", `_${fmtUsd(m.cost.totalCost)} · ${m.completionPct}% complete · ${packet.customers.length} customer(s)._`);
  return out.join("\n") + "\n";
}

const RENDERERS = {
  marketing: renderMarketing,
  sales: renderSales,
  technical: renderTechnical,
  executive: renderExecutive,
};

/** Deterministic markdown for one audience. Throws on an unknown audience. */
export function renderReport(packet, audience) {
  const fn = RENDERERS[String(audience || "").toLowerCase()];
  if (!fn) throw new Error(`Unknown audience "${audience}" (expected ${AUDIENCES.join(", ")}).`);
  return fn(packet);
}

// ---------------------------------------------------------------------------
// generate-via-prompt path
// ---------------------------------------------------------------------------

const AUDIENCE_BRIEF = {
  marketing:
    "Draft a marketing close-out. Lead with the features shipped and their user value. Produce positioning-ready copy that stays factual (no invented benchmarks, no superlatives you can't defend). Group by product where it helps.",
  sales:
    "Draft a sales close-out. Frame shipped work as customer-facing capabilities and concrete talk-track lines. Call out which CRM customer tickets each shipped item resolves. Keep every claim traceable to a ticket.",
  technical:
    "Draft a technical close-out. Summarize per-ticket changes, commits, tests, and any ADRs touched. Be precise about what changed and what remains (carryover). Engineering audience — favour accuracy over polish.",
  executive:
    "Draft an executive close-out. Report velocity (tickets done vs planned), spend vs budget, overall health, and the top risks/follow-ups. One screen, decision-oriented, no jargon.",
};

/**
 * The LLM path: a self-contained prompt for one audience that carries the report
 * packet (as JSON) plus an audience brief, so the calling agent can draft richer
 * copy than the deterministic renderer while staying grounded in real data.
 */
export function buildReportPrompt(packet, audience) {
  const brief = AUDIENCE_BRIEF[String(audience || "").toLowerCase()];
  if (!brief) throw new Error(`Unknown audience "${audience}" (expected ${AUDIENCES.join(", ")}).`);
  return [
    `You are writing the ${audience} close-out report for sprint "${packet.sprint.name}" of project "${packet.project}".`,
    "",
    brief,
    "",
    "Ground every statement in the packet below. Do not invent tickets, metrics, customers, or commits. Output GitHub-flavoured markdown only.",
    "",
    "REPORT PACKET (JSON):",
    "```json",
    JSON.stringify(packet, null, 2),
    "```",
  ].join("\n");
}

/** All four audience prompts, keyed by audience. */
export function buildAllPrompts(packet) {
  const out = {};
  for (const a of AUDIENCES) out[a] = buildReportPrompt(packet, a);
  return out;
}

// ---------------------------------------------------------------------------
// slack summary
// ---------------------------------------------------------------------------

/** One-block Slack summary for a closed sprint (pure text — caller posts it). */
export function formatSprintSummary(packet) {
  const m = packet.metrics;
  const lines = [
    `📊 *Sprint closed: ${packet.sprint.name}* (${packet.project})`,
    `${m.done}/${m.total} tickets done · +${fmtInt(m.velocity.additions)}/−${fmtInt(m.velocity.deletions)} lines · ${fmtUsd(m.cost.totalCost)}`,
  ];
  const shipped = packet.doneTickets.filter((t) => t.type !== "bug").slice(0, 5);
  if (shipped.length) lines.push("Shipped: " + shipped.map((t) => t.title).join(", "));
  if (m.carryover) lines.push(`⚠️ ${m.carryover} carried over`);
  lines.push("Reports: marketing · sales · technical · executive");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// storage: write / read reports under <projectDir>/reports/<slug>/
// ---------------------------------------------------------------------------

function reportsRoot(board, project) {
  return path.join(board.projectDir(project), REPORTS_DIR);
}
function sprintDir(board, project, slug) {
  return path.join(reportsRoot(board, project), slug);
}

/**
 * Render all four audience reports for a packet and write them as pads under
 * reports/<slug>/<audience>.md, plus a manifest.json (display name, dates,
 * generation time, closed flag, metric summary). Returns the written paths.
 */
export function writeReports(board, project, packet) {
  const slug = packet.sprint.slug;
  const dir = sprintDir(board, project, slug);
  fs.mkdirSync(dir, { recursive: true });
  const paths = {};
  for (const a of AUDIENCES) {
    const p = path.join(dir, `${a}.md`);
    atomicWrite(p, renderReport(packet, a));
    paths[a] = p;
  }
  const manifest = {
    sprint: packet.sprint.name,
    slug,
    project,
    generatedAt: packet.generatedAt,
    closed: packet.closed,
    audiences: AUDIENCES,
    metrics: {
      total: packet.metrics.total,
      done: packet.metrics.done,
      carryover: packet.metrics.carryover,
      completionPct: packet.metrics.completionPct,
      totalCost: packet.metrics.cost.totalCost,
    },
  };
  const manifestPath = path.join(dir, MANIFEST_FILE);
  atomicWrite(manifestPath, JSON.stringify(manifest, null, 2));
  return { dir, paths, manifest, manifestPath };
}

/** List sprints that have written reports (reads each manifest.json). */
export function listReports(board, project) {
  const root = reportsRoot(board, project);
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return { project, reports: [] };
  }
  const reports = [];
  for (const d of entries) {
    const mp = path.join(root, d.name, MANIFEST_FILE);
    let manifest = null;
    try { manifest = JSON.parse(fs.readFileSync(mp, "utf8")); } catch { manifest = null; }
    const audiences = AUDIENCES.filter((a) => {
      try { fs.accessSync(path.join(root, d.name, `${a}.md`)); return true; } catch { return false; }
    });
    reports.push({
      slug: d.name,
      sprint: (manifest && manifest.sprint) || d.name,
      generatedAt: manifest && manifest.generatedAt,
      closed: manifest ? manifest.closed : null,
      metrics: manifest && manifest.metrics,
      audiences,
    });
  }
  reports.sort((a, b) => String(b.generatedAt || "").localeCompare(String(a.generatedAt || "")));
  return { project, reports };
}

/**
 * Read a written report. With no sprint → list available reports. With a sprint
 * but no audience → the manifest + which audiences exist. With sprint+audience →
 * that report's markdown.
 */
export function getSprintReport(board, project, { sprint, audience } = {}) {
  if (!sprint) return listReports(board, project);
  const slug = slugify(sprint);
  const dir = sprintDir(board, project, slug);
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_FILE), "utf8")); } catch { manifest = null; }
  const audiences = AUDIENCES.filter((a) => {
    try { fs.accessSync(path.join(dir, `${a}.md`)); return true; } catch { return false; }
  });
  if (!manifest && !audiences.length) {
    throw new Error(`No reports found for sprint "${sprint}" (run close_sprint first).`);
  }
  if (!audience) {
    return { project, sprint: (manifest && manifest.sprint) || sprint, slug, closed: manifest && manifest.closed, metrics: manifest && manifest.metrics, audiences };
  }
  const a = String(audience).toLowerCase();
  if (!AUDIENCES.includes(a)) throw new Error(`Unknown audience "${audience}" (expected ${AUDIENCES.join(", ")}).`);
  let markdown;
  try { markdown = fs.readFileSync(path.join(dir, `${a}.md`), "utf8"); } catch { throw new Error(`No ${a} report for sprint "${sprint}".`); }
  return { project, sprint: (manifest && manifest.sprint) || sprint, slug, audience: a, markdown };
}

// ---------------------------------------------------------------------------
// close_sprint
// ---------------------------------------------------------------------------

/**
 * Close a sprint: build its packet, enforce the closed state (all tickets Done
 * unless force:true), write the four reports, and — when a `notify` hook is
 * given — post a Slack summary. Never throws out of the Slack step: a failed
 * post is reported in the result, it does not fail the close.
 *
 * `notify(text)` is injected (index.js wires it to slack.notifySlack) so this
 * module stays free of network + config concerns and is unit-testable.
 */
export async function closeSprint(board, project, sprintName, { force = false, now = new Date(), notify = null } = {}) {
  const packet = buildReportPacket(board, project, sprintName, { now });
  if (!packet.closed && !force) {
    const open = packet.carryoverTickets.map((t) => `${t.ticket} (${t.status})`).join(", ");
    throw new Error(`Sprint "${packet.sprint.name}" still has ${packet.metrics.carryover} open ticket(s): ${open}. Finish them or pass force:true to close anyway.`);
  }
  const written = writeReports(board, project, packet);
  const prompts = buildAllPrompts(packet);

  let slack = { sent: false, reason: "no notify hook provided" };
  if (typeof notify === "function") {
    try {
      slack = (await notify(formatSprintSummary(packet))) || { sent: false };
    } catch (err) {
      // a Slack failure must never fail the close
      slack = { sent: false, warning: `Slack summary failed: ${(err && err.message) || String(err)}` };
    }
  }

  return {
    project,
    sprint: packet.sprint,
    closed: packet.closed,
    forced: !packet.closed && force,
    dir: written.dir,
    paths: written.paths,
    summary: {
      total: packet.metrics.total,
      done: packet.metrics.done,
      carryover: packet.metrics.carryover,
      completionPct: packet.metrics.completionPct,
      totalCost: packet.metrics.cost.totalCost,
      tokens: packet.metrics.velocity.tokens,
      adrs: packet.adrs.length,
      customers: packet.customers.length,
      commits: packet.commits.length,
    },
    prompts,
    slack,
  };
}
