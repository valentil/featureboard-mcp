/**
 * FeatureBoard compliance & traceability export (FBMCPF-347).
 *
 * One tool — export_audit — that unifies the audit primitives that already
 * exist across the server into a single exportable report:
 *
 *   - ticket_events.jsonl field-change events (events.js, FBMCPF-142)
 *   - agent_work_log.md work sessions (metadata.js)
 *   - dispatch audit events — who/which model worked a ticket (FBMCPF-256)
 *   - requirements pads + acceptance criteria (requirements.js, FBMCPF-138)
 *   - review comments with resolution state (reviews.js, FBMCPF-135)
 *   - decision log entries touching the ticket (decisions.js, FBMCPF-139)
 *   - commits correlated to the ticket, recorded-first (git.js, FBMCPF-188)
 *   - drift scores from the eval harness (drift.js)
 *
 * The result is a requirements-to-code trail per ticket plus a board-level
 * compliance summary (acceptance coverage, Done-without-commit gaps,
 * unresolved reviews, drift). Read-only: this module never writes.
 *
 * Formats: json (structured, default), markdown (human dossier), csv (flat
 * chronological trail rows for spreadsheets/BI).
 */

import { eventsForTicket, lastDispatchForTicket } from "./events.js";
import { readWorkLog } from "./metadata.js";
import { getRequirements } from "./requirements.js";
import { listReviewComments } from "./reviews.js";
import { decisionsForTicket } from "./decisions.js";
import { getTicketDiff } from "./git.js";
import { driftScoresForTicket } from "./drift.js";

// ---------------------------------------------------------------------------
// dossier assembly
// ---------------------------------------------------------------------------

function commitsForTicket(board, project, ticket, maxCommits) {
  // Reuse get_ticket_diff's recorded-first commit correlation (falls back to
  // git log --grep), but drop the diffs — the audit trail wants who/when/what
  // subject, not the patch. Tiny maxBytes keeps the underlying git show cheap.
  try {
    const res = getTicketDiff(board, project, ticket, { maxCommits, maxBytes: 1000, context: 0 });
    if (res && Array.isArray(res.commits)) {
      return {
        count: res.count || res.commits.length,
        source: res.source || null,
        commits: res.commits.map((c) => ({ hash: c.hash, author: c.author, date: c.date, subject: c.subject })),
        ...(res.warning ? { warning: res.warning } : {}),
      };
    }
    return { count: 0, commits: [], ...(res && res.warning ? { warning: res.warning } : {}) };
  } catch (e) {
    return { count: 0, commits: [], warning: String(e && e.message ? e.message : e) };
  }
}

function requirementsSummary(board, project, ticket) {
  const req = getRequirements(board, project, ticket);
  if (!req) return null;
  const criteria = req.acceptanceCriteria || [];
  return {
    intent: req.intent || "",
    acceptance: {
      total: criteria.length,
      done: criteria.filter((c) => c.done).length,
      criteria: criteria.map((c) => ({ text: c.text, done: !!c.done })),
    },
    assumptions: (req.assumptions || []).length,
    openQuestions: (req.openQuestions || []).length,
  };
}

function buildDossier(board, project, task, workLog, { maxCommits, includeCommits }) {
  const tk = task.ticketNumber;
  const events = eventsForTicket(board, project, tk).map((e) => ({
    ts: e.ts, field: e.field, from: e.from ?? null, to: e.to ?? null, source: e.source ?? null,
    ...(e.worker ? { worker: e.worker } : {}), ...(e.model ? { model: e.model } : {}),
  }));
  const sessions = workLog
    .filter((e) => e.ticket === tk)
    .map((e) => ({
      date: e.date, time: e.time, summary: e.text || "",
      tokens: e.tokens ?? null, additions: e.additions ?? null, deletions: e.deletions ?? null,
      model: e.model ?? null, commit: e.hash ?? null,
    }));
  const reviews = listReviewComments(board, project, tk);
  const drift = driftScoresForTicket(board, project, tk);
  return {
    ticket: tk,
    title: task.title,
    type: task.type || null,
    status: task.status,
    priority: task.priority ?? null,
    labels: task.labels || [],
    createdDate: task.createdDate || null,
    completionDate: task.completionDate || null,
    completionSummary: task.completionSummary || null,
    requirements: requirementsSummary(board, project, tk),
    events,
    workSessions: sessions,
    dispatch: lastDispatchForTicket(board, project, tk) || null,
    reviews: {
      total: reviews.length,
      unresolved: reviews.filter((c) => !c.resolved).length,
      comments: reviews.map((c) => ({
        comment: c.comment, author: c.author ?? null, resolved: !!c.resolved,
        file: c.file ?? null, line: c.line ?? null, ts: c.ts ?? c.createdAt ?? null,
      })),
    },
    decisions: decisionsForTicket(board, project, tk).map((d) => ({ id: d.id ?? null, title: d.title, decision: d.decision })),
    commits: includeCommits ? commitsForTicket(board, project, tk, maxCommits) : null,
    drift,
  };
}

function buildSummary(dossiers, { includeCommits }) {
  const byStatus = {};
  let criteriaTotal = 0, criteriaDone = 0, withRequirements = 0;
  let unresolvedReviews = 0, tokens = 0, additions = 0, deletions = 0;
  let driftScored = 0, driftFlagged = 0;
  const doneWithoutCommits = [];
  for (const d of dossiers) {
    byStatus[d.status] = (byStatus[d.status] || 0) + 1;
    if (d.requirements) {
      withRequirements += 1;
      criteriaTotal += d.requirements.acceptance.total;
      criteriaDone += d.requirements.acceptance.done;
    }
    unresolvedReviews += d.reviews.unresolved;
    for (const s of d.workSessions) {
      tokens += s.tokens || 0; additions += s.additions || 0; deletions += s.deletions || 0;
    }
    for (const s of d.drift) {
      driftScored += 1;
      if (s.verdict === "partial" || s.verdict === "drift") driftFlagged += 1;
    }
    if (includeCommits && d.status === "Done" && d.commits && d.commits.count === 0) doneWithoutCommits.push(d.ticket);
  }
  return {
    tickets: dossiers.length,
    byStatus,
    acceptance: { ticketsWithRequirements: withRequirements, criteriaTotal, criteriaDone },
    reviews: { unresolved: unresolvedReviews },
    work: { tokens, additions, deletions },
    drift: { scored: driftScored, flagged: driftFlagged },
    ...(includeCommits ? { doneWithoutCommits } : {}),
  };
}

// ---------------------------------------------------------------------------
// renderers
// ---------------------------------------------------------------------------

function renderMarkdown(project, summary, dossiers, generatedAt) {
  const L = [];
  L.push(`# Compliance & traceability report — ${project}`);
  L.push(``);
  L.push(`Generated ${generatedAt}. ${summary.tickets} ticket(s).`);
  L.push(``);
  L.push(`## Summary`);
  L.push(``);
  L.push(`- Status: ${Object.entries(summary.byStatus).map(([s, n]) => `${s} ${n}`).join(" · ") || "—"}`);
  L.push(`- Acceptance criteria: ${summary.acceptance.criteriaDone}/${summary.acceptance.criteriaTotal} met across ${summary.acceptance.ticketsWithRequirements} ticket(s) with requirements`);
  L.push(`- Unresolved review comments: ${summary.reviews.unresolved}`);
  L.push(`- Drift harness: ${summary.drift.scored} scored, ${summary.drift.flagged} flagged`);
  if (summary.doneWithoutCommits) {
    L.push(`- Done tickets with no correlated commit: ${summary.doneWithoutCommits.length ? summary.doneWithoutCommits.join(", ") : "none"}`);
  }
  for (const d of dossiers) {
    L.push(``);
    L.push(`## ${d.ticket} — ${d.title}`);
    L.push(``);
    L.push(`Status: ${d.status}${d.completionDate ? ` (completed ${d.completionDate})` : ""}${d.priority != null ? ` · priority ${d.priority}` : ""}`);
    if (d.completionSummary) L.push(`Completion: ${d.completionSummary}`);
    if (d.requirements) {
      L.push(``);
      L.push(`### Requirements (${d.requirements.acceptance.done}/${d.requirements.acceptance.total} criteria met)`);
      if (d.requirements.intent) L.push(`Intent: ${d.requirements.intent}`);
      for (const c of d.requirements.acceptance.criteria) L.push(`- [${c.done ? "x" : " "}] ${c.text}`);
    }
    if (d.events.length) {
      L.push(``);
      L.push(`### Timeline`);
      for (const e of d.events) L.push(`- ${e.ts} · ${e.field}: ${e.from ?? "∅"} → ${e.to ?? "∅"} (${e.source || "unknown"}${e.worker ? ` · ${e.worker}` : ""}${e.model ? ` · ${e.model}` : ""})`);
    }
    if (d.workSessions.length) {
      L.push(``);
      L.push(`### Work sessions`);
      for (const s of d.workSessions) L.push(`- ${s.date} ${s.time}${s.model ? ` · ${s.model}` : ""} · +${s.additions ?? 0}/−${s.deletions ?? 0}${s.tokens ? ` · ${s.tokens} tokens` : ""}${s.summary ? ` — ${s.summary}` : ""}`);
    }
    if (d.commits && d.commits.commits.length) {
      L.push(``);
      L.push(`### Commits (${d.commits.source || "correlated"})`);
      for (const c of d.commits.commits) L.push(`- ${String(c.hash).slice(0, 10)} ${c.date} ${c.author} — ${c.subject}`);
    } else if (d.commits && d.commits.warning) {
      L.push(``);
      L.push(`### Commits`);
      L.push(`- (${d.commits.warning})`);
    }
    if (d.reviews.total) {
      L.push(``);
      L.push(`### Review comments (${d.reviews.unresolved} unresolved)`);
      for (const c of d.reviews.comments) L.push(`- [${c.resolved ? "resolved" : "open"}]${c.author ? ` ${c.author}:` : ""} ${c.comment}${c.file ? ` (${c.file}${c.line ? `:${c.line}` : ""})` : ""}`);
    }
    if (d.decisions.length) {
      L.push(``);
      L.push(`### Decisions`);
      for (const dec of d.decisions) L.push(`- ${dec.title}: ${dec.decision}`);
    }
    if (d.drift.length) {
      L.push(``);
      L.push(`### Drift scores`);
      for (const s of d.drift) L.push(`- run ${s.runId}: score ${s.score} (${s.verdict})${s.gap ? ` — ${s.gap}` : ""}`);
    }
  }
  L.push(``);
  return L.join("\n");
}

function csvEscape(v) {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function renderCsv(dossiers) {
  const rows = [["ticket", "ts", "kind", "detail", "actor", "model"]];
  for (const d of dossiers) {
    for (const e of d.events) rows.push([d.ticket, e.ts, `event:${e.field}`, `${e.from ?? ""} -> ${e.to ?? ""}`, e.worker || e.source || "", e.model || ""]);
    for (const s of d.workSessions) rows.push([d.ticket, `${s.date}T${s.time}`, "work", `${s.summary || ""} (+${s.additions ?? 0}/-${s.deletions ?? 0})`, "", s.model || ""]);
    if (d.commits) for (const c of d.commits.commits) rows.push([d.ticket, c.date, "commit", c.subject, c.author, ""]);
    for (const c of d.reviews.comments) rows.push([d.ticket, c.ts || "", c.resolved ? "review:resolved" : "review:open", c.comment, c.author || "", ""]);
    for (const s of d.drift) rows.push([d.ticket, s.at || "", "drift", `score ${s.score} (${s.verdict})`, "", ""]);
  }
  return rows.map((r) => r.map(csvEscape).join(",")).join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

export function exportAudit(board, project, { ticket = null, format = "json", maxCommits = 20, includeCommits = true } = {}) {
  if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
  let tasks;
  if (ticket) {
    const t = board.getTask(project, ticket);
    if (!t) throw new Error(`Ticket "${ticket}" not found in "${project}".`);
    tasks = [t];
  } else {
    tasks = board.listTasks(project, {});
  }
  const workLog = readWorkLog(board, project);
  const dossiers = tasks.map((t) => buildDossier(board, project, t, workLog, { maxCommits, includeCommits }));
  const summary = buildSummary(dossiers, { includeCommits });
  const generatedAt = new Date().toISOString();
  if (format === "markdown") return { project, format, generatedAt, summary, content: renderMarkdown(project, summary, dossiers, generatedAt) };
  if (format === "csv") return { project, format, generatedAt, summary, content: renderCsv(dossiers) };
  return { project, format: "json", generatedAt, summary, tickets: dossiers };
}
