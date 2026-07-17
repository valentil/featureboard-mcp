/**
 * FeatureBoard v0.4 ticket audit trail (FBMCPF-142): full-timeline auditability
 * for status changes, priority moves, label/sprint changes, and due-date edits.
 *
 * Events are appended (never rewritten) as one JSON object per line to a
 * per-project, append-only log:
 *
 *   <projectDir>/ticket_events.jsonl
 *
 * Each line looks like:
 *   {"ts":"2026-07-16T12:00:00.000Z","ticket":"FBF-12","field":"status","from":"Todo","to":"In Progress","source":"set_status"}
 *
 * storage.js is the sole writer (its setStatus/updateTask diff old vs new task
 * state and call appendEvent for whatever actually changed), so every mutation
 * path — set_status, update_task, assign_sprint, drift remediation, budget
 * label passes, etc. — is captured from one place without each call site
 * having to remember to log anything.
 *
 * get_ticket_history merges these events with the ticket's work-log entries
 * (agent_work_log.md, see metadata.js) into one chronological view. This
 * module DOES import metadata.js for that merge, but metadata.js never
 * imports storage.js or this module, so storage.js importing THIS module (to
 * append events from setStatus/updateTask) never creates a require/import
 * cycle.
 */

import fs from "node:fs";
import path from "node:path";
import { readWorkLog } from "./metadata.js";
import { capOfTask, modelOfTask } from "./budget.js";
import { getPricing, costOfEvent, normalizeModelName } from "./pricing.js";
import { sprintOfTask } from "./sprints.js";

const EVENTS_FILE = "ticket_events.jsonl";

function eventsPath(board, project) {
  return path.join(board.projectDir(project), EVENTS_FILE);
}

/**
 * Append one audit event. Best-effort: a filesystem hiccup here must never
 * block the task mutation that triggered it, so failures are swallowed.
 * Returns the normalized event that was (attempted to be) written.
 */
export function appendEvent(board, project, event) {
  const rec = {
    ts: event.ts || new Date().toISOString(),
    ticket: event.ticket,
    field: event.field,
    from: event.from !== undefined ? event.from : null,
    to: event.to !== undefined ? event.to : null,
    source: event.source || null,
  };
  try {
    const p = eventsPath(board, project);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(rec) + "\n", "utf8");
  } catch {
    // audit trail is best-effort — never throw out of a task mutation
  }
  return rec;
}

/** Read + parse a project's event log. Tolerates a missing file and malformed lines. */
export function readEvents(board, project) {
  let content;
  try {
    content = fs.readFileSync(eventsPath(board, project), "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      if (e && e.ticket && e.field) out.push(e);
    } catch {
      // skip a corrupted line rather than failing the whole read
    }
  }
  return out;
}

/** Recorded events for one ticket, oldest first (append order == chronological). */
export function eventsForTicket(board, project, ticket) {
  return readEvents(board, project).filter((e) => e.ticket === ticket);
}

/**
 * Merged chronological audit trail for one ticket: recorded field-change
 * events (status/priority/labels/sprint/dueDate, from storage.js mutations)
 * interleaved with work-log entries (tokens/additions/deletions per work
 * session, from agent_work_log.md) that reference this ticket.
 *
 * Tolerant of a ticket with no events yet — pre-feature tickets (created
 * before FBMCPF-142, or ones that were never mutated through setStatus/
 * updateTask) simply fall back to work-log-only history, never an error.
 */
export function getTicketHistory(board, project, ticket) {
  const events = eventsForTicket(board, project, ticket).map((e) => ({
    kind: "event",
    ts: e.ts,
    field: e.field,
    from: e.from,
    to: e.to,
    source: e.source || null,
  }));

  const work = readWorkLog(board, project)
    .filter((w) => w.ticket === ticket)
    .map((w) => ({
      kind: "work_log",
      ts: `${w.date}T${w.time}`,
      summary: w.text || null,
      additions: w.additions,
      deletions: w.deletions,
      tokens: w.tokens,
      model: w.model,
    }));

  const history = [...events, ...work].sort((a, b) => {
    const da = Date.parse(a.ts), db = Date.parse(b.ts);
    if (Number.isNaN(da) || Number.isNaN(db)) return 0;
    return da - db;
  });

  return { project, ticket, count: history.length, history };
}
// ---------------------------------------------------------------------------
// Agent monitor v2 (FBMCPF-145) — live view of In Progress tickets: elapsed
// time since each went In Progress, its last event (audit or work-log) plus
// age, token spend vs its cap:* label, spend ratio, and a stalled flag driven
// by a configurable inactivity threshold (default 30 minutes). Pairs with
// churn mode in the board UI: a stalled ticket mid-churn usually means the
// agent is stuck or has gone quiet and the run needs attention.
//
// v1 (metadata.js computeActiveWork/agentMonitor) is left in place — it still
// backs its own tests and is a cheaper "cumulative work + idle hours" view.
// This is the richer per-ticket snapshot the board's monitor banner reads.
// ---------------------------------------------------------------------------

const DEFAULT_STALL_MINUTES = 30;

function spendForTicket(work, ticket) {
  let spend = 0;
  for (const w of work) {
    if (w.ticket !== ticket) continue;
    spend += w.tokens || (w.inputTokens || 0) + (w.outputTokens || 0) || 0;
  }
  return spend;
}

/** Dollar cost so far for one ticket: sum of costOfEvent() across its work-log entries. */
function costForTicket(work, ticket, pricing) {
  let cost = 0;
  for (const w of work) {
    if (w.ticket !== ticket) continue;
    cost += costOfEvent(w, pricing);
  }
  return Math.round(cost * 1e4) / 1e4;
}

/**
 * Best-guess model tier for a ticket, used to price its cap:* label in
 * dollars (FBMCPF-157). Precedence: an explicit model:<tier> label (see
 * budget.js modelOfTask) wins; otherwise the most recent work-log entry
 * for the ticket that recorded a model. Returns null (capCost stays
 * uncomputable) when neither source gives a hint.
 */
function inferModelForTicket(work, ticket, task) {
  const labeled = modelOfTask(task);
  if (labeled) return normalizeModelName(labeled) || labeled;
  const withModel = work.filter((w) => w.ticket === ticket && w.model);
  if (withModel.length) return normalizeModelName(withModel[withModel.length - 1].model);
  return null;
}

/**
 * When a ticket entered its current In Progress run: the most recent
 * status→"In Progress" audit event for the ticket (events are append-order,
 * so the last match is the most recent transition). Falls back gracefully
 * when there's no audit trail yet — a board that predates FBMCPF-142, or a
 * ticket that was never mutated through setStatus/updateTask, or a missing/
 * unreadable events file (readEvents already tolerates that and returns []):
 * first to the earliest work-log entry for the ticket (a rough proxy for
 * "work began around here"), then to the ticket's createdDate, then null.
 */
function resolveStartedInProgress(events, work, ticket, task) {
  const statusEvents = events.filter((e) => e.ticket === ticket && e.field === "status" && e.to === "In Progress");
  if (statusEvents.length) {
    return { startedAt: statusEvents[statusEvents.length - 1].ts, source: "status_event" };
  }
  const ticketWork = work.filter((w) => w.ticket === ticket);
  if (ticketWork.length) {
    const ts = `${ticketWork[0].date}T${ticketWork[0].time}`;
    if (!Number.isNaN(Date.parse(ts))) return { startedAt: ts, source: "work_log_fallback" };
  }
  if (task && task.createdDate && !Number.isNaN(Date.parse(task.createdDate))) {
    return { startedAt: `${task.createdDate}T00:00:00`, source: "created_date_fallback" };
  }
  return { startedAt: null, source: "unknown" };
}

/**
 * Most recent activity for a ticket: the later of its last audit event and
 * its last work-log entry. Returns null when the ticket has neither (an
 * In Progress ticket that has never been touched).
 */
function resolveLastEvent(events, work, ticket) {
  const ticketEvents = events.filter((e) => e.ticket === ticket);
  const ticketWork = work.filter((w) => w.ticket === ticket);

  let candidate = null;
  if (ticketEvents.length) {
    const e = ticketEvents[ticketEvents.length - 1];
    candidate = { kind: "event", ts: e.ts, summary: `${e.field}: ${e.from ?? "?"} \u2192 ${e.to ?? "?"}`, model: null };
  }
  if (ticketWork.length) {
    const w = ticketWork[ticketWork.length - 1];
    const ts = `${w.date}T${w.time}`;
    if (!Number.isNaN(Date.parse(ts)) && (!candidate || Date.parse(ts) > Date.parse(candidate.ts))) {
      candidate = { kind: "work_log", ts, summary: w.text || null, model: w.model || null };
    }
  }
  return candidate;
}

/**
 * Board wrapper: v2 monitor snapshot of a project's currently-running
 * (In Progress) tickets. opts.stallMinutes overrides the inactivity
 * threshold (default 30); opts.stallHours is accepted too for callers
 * migrating from the v1 tool signature (converted to minutes, stallMinutes
 * wins if both are given). opts.asOf overrides "now" for deterministic tests.
 */
export function agentMonitorV2(board, project, opts = {}) {
  const now = opts.asOf ? new Date(opts.asOf) : new Date();
  const stallMinutes = opts.stallMinutes != null
    ? opts.stallMinutes
    : (opts.stallHours != null ? opts.stallHours * 60 : DEFAULT_STALL_MINUTES);

  const inProgress = board.listTasks(project, {}).filter((t) => t.status === "In Progress");
  const events = readEvents(board, project);
  const work = readWorkLog(board, project);
  const pricing = getPricing(board, project);

  const tickets = inProgress.map((t) => {
    const ticket = t.ticketNumber;
    const { startedAt, source: startedAtSource } = resolveStartedInProgress(events, work, ticket, t);
    const elapsedMinutes = startedAt && !Number.isNaN(Date.parse(startedAt))
      ? Math.round(((now - new Date(startedAt)) / 60000) * 10) / 10
      : null;

    const last = resolveLastEvent(events, work, ticket);
    let lastEvent = null;
    if (last) {
      const ageMinutes = Math.round(((now - new Date(last.ts)) / 60000) * 10) / 10;
      lastEvent = { ...last, ageMinutes };
    }

    const spend = spendForTicket(work, ticket);
    const cap = capOfTask(t);
    const spendRatio = cap ? Math.round((spend / cap) * 1000) / 1000 : null;

    // FBMCPF-157: dollar view alongside the token view. costSoFar is always
    // computable (falls back to the "default" pricing tier for entries with
    // no/unrecognized model — see pricing.js costOfEvent). capCost needs a
    // model to price the cap label in dollars; null when none can be
    // inferred from a model:* label or the ticket's own work-log history.
    const costSoFar = costForTicket(work, ticket, pricing);
    const capModel = inferModelForTicket(work, ticket, t);
    const capCost = cap != null && capModel && pricing[capModel]
      ? Math.round((cap * pricing[capModel].blendedPerMTok / 1e6) * 1e4) / 1e4
      : null;

    const stalled = !lastEvent || lastEvent.ageMinutes > stallMinutes;

    return {
      ticket,
      title: t.title,
      product: t.product || null,
      priority: t.priority != null ? t.priority : null,
      dueDate: t.dueDate || null,
      startedAt,
      startedAtSource,
      elapsedMinutes,
      lastEvent,
      spend,
      cap,
      spendRatio,
      costSoFar,
      capCost,
      stalled,
    };
  });

  // most recently active first; never-touched / stalest sink to the bottom
  tickets.sort((a, b) => {
    const aAge = a.lastEvent ? a.lastEvent.ageMinutes : Infinity;
    const bAge = b.lastEvent ? b.lastEvent.ageMinutes : Infinity;
    return aAge - bAge;
  });

  const stalledTickets = tickets
    .filter((t) => t.stalled)
    .map((t) => ({ ticket: t.ticket, title: t.title, ageMinutes: t.lastEvent ? t.lastEvent.ageMinutes : null }));

  const totalSpend = tickets.reduce((s, t) => s + t.spend, 0);
  const totalCap = tickets.reduce((s, t) => s + (t.cap || 0), 0);
  const totalCostSoFar = Math.round(tickets.reduce((s, t) => s + (t.costSoFar || 0), 0) * 1e4) / 1e4;
  const capCostTickets = tickets.filter((t) => t.capCost != null);
  const totalCapCost = capCostTickets.length
    ? Math.round(capCostTickets.reduce((s, t) => s + t.capCost, 0) * 1e4) / 1e4
    : null;

  return {
    project,
    asOf: now.toISOString(),
    stallMinutes,
    count: tickets.length,
    stalledCount: stalledTickets.length,
    totalSpend,
    totalCap: totalCap || null,
    totalCostSoFar,
    totalCapCost,
    stalledTickets,
    tickets,
  };
}


// ---------------------------------------------------------------------------
// Timeline data (FBMCPF-158) — piano-roll timeline source. One read pass over
// tasks + ticket_events.jsonl + the work log assembles a per-ticket "span":
// when it was created, when it went In Progress (first status→In Progress
// audit event, falling back to its earliest work-log entry, then createdDate),
// when it completed (completionDate, or last status→Done event), plus per-day
// work rollups (tokens / additions / deletions / dollar cost) for clip
// intensity, and a board-wide byDate rollup for the datastream overlay strip.
// Read-only and lean: the board artifact draws the piano roll entirely from
// this single payload instead of one get_ticket_history call per ticket.
// ---------------------------------------------------------------------------

/** Best-guess model for a ticket: model:<tier> label, else its latest work-log model. */
function timelineModel(work, ticket, task) {
  const labeled = modelOfTask(task);
  if (labeled) return normalizeModelName(labeled) || labeled;
  const withModel = work.filter((w) => w.model);
  if (withModel.length) return normalizeModelName(withModel[withModel.length - 1].model);
  return null;
}

export function getTimelineData(board, project, opts = {}) {
  const from = opts.from ? Date.parse(opts.from) : null;
  const to = opts.to ? Date.parse(opts.to) : null;

  const tasks = board.listTasks(project, {});
  const events = readEvents(board, project);
  const work = readWorkLog(board, project);
  const pricing = getPricing(board, project);

  const evByTicket = {};
  for (const e of events) (evByTicket[e.ticket] = evByTicket[e.ticket] || []).push(e);
  const wlByTicket = {};
  for (const w of work) { if (w.ticket) (wlByTicket[w.ticket] = wlByTicket[w.ticket] || []).push(w); }

  const byDate = {}; // board-wide datastream rollup

  const spans = tasks.map((t) => {
    const ticket = t.ticketNumber;
    const evs = evByTicket[ticket] || [];
    const wls = wlByTicket[ticket] || [];

    // When work began: first status→In Progress event, else earliest work-log, else created.
    let startedAt = null, startedSource = null;
    const ip = evs.filter((e) => e.field === "status" && e.to === "In Progress");
    if (ip.length) { startedAt = ip[0].ts; startedSource = "status_event"; }
    else if (wls.length) {
      const ts = `${wls[0].date}T${wls[0].time}`;
      if (!Number.isNaN(Date.parse(ts))) { startedAt = ts; startedSource = "work_log"; }
    }
    if (!startedAt && t.createdDate) { startedAt = `${t.createdDate}T00:00:00`; startedSource = "created_date"; }

    // When it finished: completionDate, else last status→Done event.
    let completedAt = null;
    if (t.completionDate) completedAt = `${t.completionDate}T23:59:59`;
    else {
      const done = evs.filter((e) => e.field === "status" && e.to === "Done");
      if (done.length) completedAt = done[done.length - 1].ts;
    }

    let tokens = 0, additions = 0, deletions = 0, cost = 0;
    const dayMap = {};
    let lastActivity = null;
    for (const w of wls) {
      const ts = `${w.date}T${w.time}`;
      const c = costOfEvent(w, pricing);
      tokens += w.tokens || 0; additions += w.additions || 0; deletions += w.deletions || 0; cost += c;
      const d = (dayMap[w.date] = dayMap[w.date] || { date: w.date, tokens: 0, additions: 0, deletions: 0, cost: 0 });
      d.tokens += w.tokens || 0; d.additions += w.additions || 0; d.deletions += w.deletions || 0; d.cost += c;
      const bd = (byDate[w.date] = byDate[w.date] || { tokens: 0, additions: 0, deletions: 0, cost: 0 });
      bd.tokens += w.tokens || 0; bd.additions += w.additions || 0; bd.deletions += w.deletions || 0; bd.cost += c;
      if (!Number.isNaN(Date.parse(ts)) && (!lastActivity || Date.parse(ts) > Date.parse(lastActivity))) lastActivity = ts;
    }
    for (const e of evs) {
      if (e.ts && (!lastActivity || Date.parse(e.ts) > Date.parse(lastActivity))) lastActivity = e.ts;
    }

    const days = Object.keys(dayMap).sort().map((k) => {
      const d = dayMap[k]; d.cost = Math.round(d.cost * 1e4) / 1e4; return d;
    });

    return {
      ticket,
      title: t.title,
      type: ticket && /B-\d+$/.test(ticket) ? "bug" : "feature",
      status: t.status,
      product: t.product || null,
      sprint: sprintOfTask(t),
      priority: t.priority != null ? t.priority : null,
      model: timelineModel(wls, ticket, t),
      created: t.createdDate || null,
      startedAt,
      startedSource,
      completedAt,
      lastActivity,
      tokens,
      additions,
      deletions,
      cost: Math.round(cost * 1e4) / 1e4,
      days,
    };
  });

  // Keep spans whose worked window overlaps [from, to] (inclusive). No range = all.
  const spanStart = (s) => {
    const c = [s.startedAt, s.created ? `${s.created}T00:00:00` : null].filter(Boolean).map(Date.parse).filter((n) => !Number.isNaN(n));
    return c.length ? Math.min(...c) : null;
  };
  const spanEnd = (s) => {
    const c = [s.completedAt, s.lastActivity, s.startedAt].filter(Boolean).map(Date.parse).filter((n) => !Number.isNaN(n));
    return c.length ? Math.max(...c) : spanStart(s);
  };
  const filtered = (from == null && to == null) ? spans : spans.filter((s) => {
    const st = spanStart(s), en = spanEnd(s);
    if (from != null && en != null && en < from) return false;
    if (to != null && st != null && st > to) return false;
    return true;
  });

  const byDateArr = Object.keys(byDate).sort().map((d) => ({ date: d, ...byDate[d], cost: Math.round(byDate[d].cost * 1e4) / 1e4 }));

  return {
    project,
    from: opts.from || null,
    to: opts.to || null,
    count: filtered.length,
    spans: filtered,
    byDate: byDateArr,
  };
}
