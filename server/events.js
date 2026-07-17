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

// ---------------------------------------------------------------------------
// FBMCPF-162: mtime-keyed cache for the append-only jsonl logs
//
// readEvents()/readHeartbeats() are called several times per tool invocation
// (agentMonitorV2, getTimelineData, getTicketHistory all read the full log)
// and re-parse the WHOLE file — every line, every call — even though these
// logs are append-only and often thousands of lines deep on an active board.
// Caching per absolute path, keyed by mtimeMs+size, turns a repeat read
// within the same process into an O(1) lookup. Size is part of the key (not
// just mtime) because an append always changes the byte count even when two
// appends land within the same filesystem mtime tick.
//
// Invalidation: appendEvent()/appendHeartbeat() delete the cache entry for
// their path immediately after the append lands (write-through, airtight for
// same-process writes — this module is the sole writer of both logs); the
// mtime+size check is defense-in-depth for a file touched by another process.
// ---------------------------------------------------------------------------
const jsonlCache = new Map(); // absolute path -> { mtimeMs, size, records }

function readJsonlCached(p, keep) {
  const abs = path.resolve(p);
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    jsonlCache.delete(abs);
    return [];
  }
  const cached = jsonlCache.get(abs);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.records;
  }
  let content;
  try {
    content = fs.readFileSync(abs, "utf8");
  } catch {
    jsonlCache.delete(abs);
    return [];
  }
  const out = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const rec = JSON.parse(line);
      if (keep(rec)) out.push(rec);
    } catch {
      // skip a corrupted line rather than failing the whole read
    }
  }
  jsonlCache.set(abs, { mtimeMs: stat.mtimeMs, size: stat.size, records: out });
  return out;
}

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
  // FBMCPF-188: commit events (field:"commit", appended by commit_feature's
  // enrichment) carry the commit hash + line stats alongside the usual
  // from/to/source shape, so get_ticket_diff/get_ticket_history can read the
  // ticket's actual recorded commits instead of grepping git log.
  if (event.hash != null) rec.hash = String(event.hash);
  if (event.shortHash != null) rec.shortHash = String(event.shortHash);
  if (event.additions != null) rec.additions = Number(event.additions);
  if (event.deletions != null) rec.deletions = Number(event.deletions);
  try {
    const p = eventsPath(board, project);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(rec) + "\n", "utf8");
    jsonlCache.delete(path.resolve(p)); // FBMCPF-162: write-through invalidation
  } catch {
    // audit trail is best-effort — never throw out of a task mutation
  }
  return rec;
}

/** Read + parse a project's event log. Tolerates a missing file and malformed lines. */
export function readEvents(board, project) {
  return readJsonlCached(eventsPath(board, project), (e) => e && e.ticket && e.field);
}

/** Recorded events for one ticket, oldest first (append order == chronological). */
export function eventsForTicket(board, project, ticket) {
  return readEvents(board, project).filter((e) => e.ticket === ticket);
}

/**
 * FBMCPF-188: full commit hashes recorded for a ticket via commit_feature's
 * enrichment (field:"commit" events written by appendEvent), newest first and
 * deduped. Callers (get_ticket_diff) treat a non-empty result as "this ticket
 * has real correlation data" and use these hashes directly instead of
 * grepping git log for the ticket id — grep both misses commits whose message
 * doesn't literally include the ticket id and can false-positive on unrelated
 * commits that happen to mention it.
 */
export function recordedCommitsForTicket(board, project, ticket) {
  const hashes = eventsForTicket(board, project, ticket)
    .filter((e) => e.field === "commit" && e.hash)
    .map((e) => e.hash);
  const seen = new Set();
  const ordered = [];
  for (const h of hashes) {
    if (seen.has(h)) continue;
    seen.add(h);
    ordered.push(h);
  }
  return ordered.reverse(); // append order is oldest-first; callers want newest-first
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
    ...(e.hash != null ? { hash: e.hash, shortHash: e.shortHash || null, additions: e.additions ?? null, deletions: e.deletions ?? null } : {}),
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
      hash: w.hash || null,
    }));

  const history = [...events, ...work].sort((a, b) => {
    const da = Date.parse(a.ts), db = Date.parse(b.ts);
    if (Number.isNaN(da) || Number.isNaN(db)) return 0;
    return da - db;
  });

  return { project, ticket, count: history.length, history };
}

// ---------------------------------------------------------------------------
// Heartbeats (FBMCPB-15) — lightweight in-flight progress pings a sub-agent
// emits mid-dispatch, so the orchestrator surface has something to show
// besides a generic "multitasking" indicator during a long (5-13min) ticket
// run. Stored append-only, one JSON object per line, in a project's:
//
//   <projectDir>/heartbeats.jsonl
//
// Distinct from ticket_events.jsonl (the field-change audit trail that
// storage.js alone writes from setStatus/updateTask) — heartbeats are purely
// informational "still here, this is what I'm doing now" pings, written
// directly by the log_heartbeat tool. agentMonitorV2 below treats a
// heartbeat as "activity" alongside audit events and work-log entries (so a
// ticket that's only heartbeating isn't wrongly flagged stalled), and also
// carries each ticket's own lastHeartbeat (note/model/elapsedMinutes/spend/
// ageMinutes) for a richer "what's it doing right now" view than the
// generic lastEvent gives.
// ---------------------------------------------------------------------------

const HEARTBEATS_FILE = "heartbeats.jsonl";

function heartbeatsPath(board, project) {
  return path.join(board.projectDir(project), HEARTBEATS_FILE);
}

/**
 * Append one heartbeat. Best-effort like appendEvent: a filesystem hiccup
 * here must never blow up the sub-agent call that triggered it, so failures
 * are swallowed. Returns the normalized record that was (attempted to be)
 * written.
 */
export function appendHeartbeat(board, project, heartbeat) {
  const h = heartbeat || {};
  const rec = {
    ts: h.ts || new Date().toISOString(),
    ticket: h.ticket,
    note: h.note != null ? String(h.note) : null,
    model: h.model || null,
    elapsedMinutes: h.elapsedMinutes != null ? Number(h.elapsedMinutes) : null,
    spend: h.spend != null ? Number(h.spend) : null,
  };
  try {
    const p = heartbeatsPath(board, project);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(rec) + "\n", "utf8");
    jsonlCache.delete(path.resolve(p)); // FBMCPF-162: write-through invalidation
  } catch {
    // best-effort — never throw out of a sub-agent's progress ping
  }
  return rec;
}

/** Read + parse a project's heartbeat log. Tolerates a missing file and malformed lines. */
export function readHeartbeats(board, project) {
  return readJsonlCached(heartbeatsPath(board, project), (h) => h && h.ticket);
}

/** Recorded heartbeats for one ticket, oldest first (append order == chronological). */
export function heartbeatsForTicket(board, project, ticket) {
  return readHeartbeats(board, project).filter((h) => h.ticket === ticket);
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

// FBMCPF-162: these all used to take the FULL events/work/heartbeats array
// plus a ticket id and filter it inline — O(tickets * logSize) across
// agentMonitorV2's per-ticket map. agentMonitorV2 now groups each log by
// ticket ONCE up front (see groupByTicket below, same approach
// getTimelineData already used) and passes each ticket's own slice in, so
// every function below is now a straight scan of just that ticket's
// entries — no `.ticket === ticket` filtering left in any of them.

/** Group a chronological (append-order) log by its `ticket` field, preserving order within each group. */
function groupByTicket(list) {
  const map = new Map();
  for (const item of list) {
    if (!item || !item.ticket) continue;
    let arr = map.get(item.ticket);
    if (!arr) map.set(item.ticket, (arr = []));
    arr.push(item);
  }
  return map;
}

function spendForTicket(work) {
  let spend = 0;
  for (const w of work) {
    spend += w.tokens || (w.inputTokens || 0) + (w.outputTokens || 0) || 0;
  }
  return spend;
}

/** Dollar cost so far for one ticket: sum of costOfEvent() across its work-log entries. */
function costForTicket(work, pricing) {
  let cost = 0;
  for (const w of work) {
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
function inferModelForTicket(work, task, heartbeats) {
  const labeled = modelOfTask(task);
  if (labeled) return normalizeModelName(labeled) || labeled;
  const withModel = work.filter((w) => w.model);
  if (withModel.length) return normalizeModelName(withModel[withModel.length - 1].model);
  // FBMCPB-15: before a ticket has any work-log entry, a heartbeat's model
  // is the earliest signal available — lets capCost price in as soon as a
  // sub-agent's first heartbeat lands instead of waiting for completion.
  const withHbModel = (heartbeats || []).filter((h) => h.model);
  if (withHbModel.length) return normalizeModelName(withHbModel[withHbModel.length - 1].model);
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
function resolveStartedInProgress(events, work, task) {
  const statusEvents = events.filter((e) => e.field === "status" && e.to === "In Progress");
  if (statusEvents.length) {
    return { startedAt: statusEvents[statusEvents.length - 1].ts, source: "status_event" };
  }
  if (work.length) {
    const ts = `${work[0].date}T${work[0].time}`;
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
function resolveLastEvent(events, work, heartbeats) {
  let candidate = null;
  if (events.length) {
    const e = events[events.length - 1];
    candidate = { kind: "event", ts: e.ts, summary: `${e.field}: ${e.from ?? "?"} \u2192 ${e.to ?? "?"}`, model: null };
  }
  if (work.length) {
    const w = work[work.length - 1];
    const ts = `${w.date}T${w.time}`;
    if (!Number.isNaN(Date.parse(ts)) && (!candidate || Date.parse(ts) > Date.parse(candidate.ts))) {
      candidate = { kind: "work_log", ts, summary: w.text || null, model: w.model || null };
    }
  }
  // FBMCPB-15: a heartbeat counts as activity too, so a ticket mid-dispatch
  // that's only pinging heartbeats (no status/work-log event yet) isn't
  // wrongly flagged stalled.
  if (heartbeats.length) {
    const h = heartbeats[heartbeats.length - 1];
    if (!Number.isNaN(Date.parse(h.ts)) && (!candidate || Date.parse(h.ts) > Date.parse(candidate.ts))) {
      candidate = { kind: "heartbeat", ts: h.ts, summary: h.note || null, model: h.model || null };
    }
  }
  return candidate;
}

/**
 * Most recent heartbeat for a ticket, with age relative to `now`. Distinct
 * from resolveLastEvent's generic "last activity" — this always reflects the
 * latest heartbeat even when a status/work-log event is newer, so the board
 * can show "current phase" (the note) separately from "last activity".
 * Null when the ticket has never emitted one.
 */
function resolveLastHeartbeat(heartbeats, now) {
  if (!heartbeats.length) return null;
  const h = heartbeats[heartbeats.length - 1];
  if (Number.isNaN(Date.parse(h.ts))) return null;
  const ageMinutes = Math.round(((now - new Date(h.ts)) / 60000) * 10) / 10;
  return {
    ts: h.ts,
    note: h.note || null,
    model: h.model || null,
    elapsedMinutes: h.elapsedMinutes != null ? h.elapsedMinutes : null,
    spend: h.spend != null ? h.spend : null,
    ageMinutes,
  };
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
  const heartbeats = readHeartbeats(board, project);
  const pricing = getPricing(board, project);

  // FBMCPF-162: group each log by ticket ONCE instead of re-filtering the
  // full events/work/heartbeats array inside every resolve*/*ForTicket call
  // below — on a busy board (thousands of events/work-log lines, hundreds
  // of In Progress tickets) that inline filtering was the dominant cost of
  // this whole function (O(tickets * logSize) instead of O(logSize)).
  const eventsByTicket = groupByTicket(events);
  const workByTicket = groupByTicket(work);
  const heartbeatsByTicket = groupByTicket(heartbeats);
  const EMPTY = [];

  const tickets = inProgress.map((t) => {
    const ticket = t.ticketNumber;
    const ticketEvents = eventsByTicket.get(ticket) || EMPTY;
    const ticketWork = workByTicket.get(ticket) || EMPTY;
    const ticketHeartbeats = heartbeatsByTicket.get(ticket) || EMPTY;

    const { startedAt, source: startedAtSource } = resolveStartedInProgress(ticketEvents, ticketWork, t);
    const elapsedMinutes = startedAt && !Number.isNaN(Date.parse(startedAt))
      ? Math.round(((now - new Date(startedAt)) / 60000) * 10) / 10
      : null;

    const last = resolveLastEvent(ticketEvents, ticketWork, ticketHeartbeats);
    let lastEvent = null;
    if (last) {
      const ageMinutes = Math.round(((now - new Date(last.ts)) / 60000) * 10) / 10;
      lastEvent = { ...last, ageMinutes };
    }

    // FBMCPB-15: the ticket's own latest heartbeat (note/model/elapsed/spend
    // as reported by the sub-agent, plus age) — a richer "what's it doing
    // right now" view than lastEvent, which only says activity happened.
    const lastHeartbeat = resolveLastHeartbeat(ticketHeartbeats, now);

    const spend = spendForTicket(ticketWork);
    const cap = capOfTask(t);
    const spendRatio = cap ? Math.round((spend / cap) * 1000) / 1000 : null;

    // FBMCPF-157: dollar view alongside the token view. costSoFar is always
    // computable (falls back to the "default" pricing tier for entries with
    // no/unrecognized model — see pricing.js costOfEvent). capCost needs a
    // model to price the cap label in dollars; null when none can be
    // inferred from a model:* label, the ticket's own work-log history, or
    // (FBMCPB-15) its latest heartbeat.
    const costSoFar = costForTicket(ticketWork, pricing);
    const capModel = inferModelForTicket(ticketWork, t, ticketHeartbeats);
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
      lastHeartbeat,
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

/**
 * FBMCPF-164 / FBMCPB-18: resolve a ticket's exact completion moment from the
 * event stream + work log, WITHOUT reading a time-of-day from the markdown
 * (which only carries a date). Preference: last status\u2192Done audit event,
 * else the ticket's last work-log entry once it's actually Done, else its
 * date-only completionDate read as local end-of-day. A Done ticket's result is
 * clamped so it can never land after `now` (defends against a future-dated
 * completionDate or clock skew). Returns { completedAt, completedSource,
 * completedClamped }; completedAt is null for a ticket that isn't finished and
 * has no Done trail. `evs`/`wls` are this ticket's events / work-log entries in
 * chronological (append) order.
 */
export function resolveCompletedAt(evs, wls, task, now = new Date()) {
  const nowMs = now.getTime();
  let completedAt = null, completedSource = null;
  const done = (evs || []).filter((e) => e.field === "status" && e.to === "Done");
  if (done.length) { completedAt = done[done.length - 1].ts; completedSource = "status_event"; }
  else if (task && task.status === "Done" && wls && wls.length) {
    const last = wls[wls.length - 1];
    const ts = `${last.date}T${last.time}`;
    if (!Number.isNaN(Date.parse(ts))) { completedAt = ts; completedSource = "work_log"; }
  }
  if (!completedAt && task && task.completionDate) {
    completedAt = `${task.completionDate}T23:59:59`;
    completedSource = "completion_date";
  }
  let completedClamped = false;
  if (task && task.status === "Done" && completedAt) {
    const parsed = Date.parse(completedAt);
    if (!Number.isNaN(parsed) && parsed > nowMs) {
      completedAt = now.toISOString();
      completedSource = completedSource ? `${completedSource}_clamped` : "clamped";
      completedClamped = true;
    }
  }
  return { completedAt, completedSource, completedClamped };
}

/**
 * FBMCPF-164: board-level convenience \u2014 the exact completion timestamp for
 * one ticket, derived (never stored in markdown) from its Done audit event /
 * work log. Used by get_task to expose completedAt without a full timeline pass.
 */
export function completedAtForTask(board, project, task, now = new Date()) {
  if (!task) return { completedAt: null, completedSource: null, completedClamped: false };
  const evs = eventsForTicket(board, project, task.ticketNumber);
  const wls = readWorkLog(board, project).filter((w) => w.ticket === task.ticketNumber);
  return resolveCompletedAt(evs, wls, task, now);
}

export function getTimelineData(board, project, opts = {}) {
  const from = opts.from ? Date.parse(opts.from) : null;
  const to = opts.to ? Date.parse(opts.to) : null;
  // FBMCPB-18: "now" is overridable (same convention as agentMonitorV2's
  // opts.asOf) so tests can assert future-completionDate clamping
  // deterministically instead of racing the real clock.
  const now = opts.asOf ? new Date(opts.asOf) : new Date();

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

    // When it finished: prefer a precise timestamp over the date-only
    // completionDate field, which (FBMCPB-18) can be flat-out wrong — it used
    // to be stamped from the UTC calendar day, so a ticket closed late in the
    // local evening could land on tomorrow's date — and is coarse even when
    // correct (day-boundary granularity snaps every bar to midnight instead
    // of the real finish time). Preference order: last status→Done audit
    // event, else the ticket's last work-log entry (only once the ticket is
    // actually Done — an in-progress ticket's latest work-log entry isn't a
    // completion), else completionDate interpreted as local end-of-day. This
    // also doubles as the read-side repair for already-stored future
    // completionDates: whichever event/work-log timestamp exists wins over a
    // bogus date, with no rewrite of the markdown needed.
    const { completedAt, completedSource, completedClamped } = resolveCompletedAt(evs, wls, t, now);

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
      completedSource,
      completedClamped,
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
    // FBMCPB-18: the same clock the spans above were clamped against, so the
    // artifact's now-line and the span data it's drawn from share one time
    // basis instead of the client computing its own "now" independently.
    asOf: now.toISOString(),
    count: filtered.length,
    spans: filtered,
    byDate: byDateArr,
  };
}
