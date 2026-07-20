/**
 * FeatureBoard predictive due-date suggestions (FBMCPF-32).
 *
 * Ported from the original app's predictive_adjustment.js. Estimates when open
 * work will complete by dividing the remaining backlog by the board's observed
 * throughput (tickets closed per active day, from completion history), then
 * walking the priority-ordered queue to give each open ticket a projected
 * completion date. Tickets that already carry a due date are compared against
 * the projection so the board can flag ones that are likely to slip.
 *
 * The heavy lifting is a pure function (`predictCompletion`) so it can be unit
 * tested without a Board or the filesystem; `predictDueDates` is the thin
 * wrapper that gathers the board's tasks and feeds the pure core.
 *
 * FBMCPF-269 also adds `estimateTicketMinutes` here (per-ticket wall-clock ETA,
 * distinct from predictCompletion's board-wide due-date projection): it needs
 * effortOfTask (budget.js) and eventsForTicket (events.js), and this module is
 * only ever imported by index.js/register/*.js — never by metadata.js, budget.js,
 * or events.js themselves — so pulling those two in here creates no import cycle.
 */
import { effortOfTask } from "./budget.js";
import { eventsForTicket } from "./events.js";

// ---------------------------------------------------------------------------
// date helpers (calendar days; no weekend/holiday modelling, matching original)
// ---------------------------------------------------------------------------

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function toISO(d) {
  const x = startOfDay(d);
  const y = x.getFullYear();
  const m = String(x.getMonth() + 1).padStart(2, "0");
  const day = String(x.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function addDays(d, n) {
  const x = startOfDay(d);
  x.setDate(x.getDate() + n);
  return x;
}
function parseISO(s) {
  if (s == null) return null;
  // Treat a bare YYYY-MM-DD as a LOCAL calendar date. Date.parse() reads it as
  // UTC midnight, which shifts to the previous day in negative-offset zones and
  // corrupts day-count math — so build it in local time explicitly.
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const t = Date.parse(s);
  return isNaN(t) ? null : startOfDay(new Date(t));
}
function daysBetween(a, b) {
  return Math.round((startOfDay(b) - startOfDay(a)) / 86400000);
}

// ---------------------------------------------------------------------------
// pure core
// ---------------------------------------------------------------------------

/**
 * @param {object} p
 * @param {Array}  p.open      open tickets, already in work order (highest priority first).
 *                             Each: { ticketNumber, title, status, priority, dueDate, product }.
 * @param {string[]} p.doneDates completion dates (YYYY-MM-DD) of finished tickets.
 * @param {Date}   [p.asOf]    reference "today" (defaults to now).
 * @param {number} [p.fallbackRate] tickets/day to assume when there's no history (default 1).
 * @returns prediction object.
 */
export function predictCompletion({ open = [], doneDates = [], asOf, fallbackRate = 1 } = {}) {
  const today = startOfDay(asOf || new Date());

  // throughput: distinct active days and total completed
  const days = new Set();
  let totalDone = 0;
  for (const d of doneDates) {
    if (parseISO(d)) {
      days.add(d);
      totalDone += 1;
    }
  }
  const activeDays = days.size;
  const hasHistory = totalDone > 0 && activeDays > 0;
  const ratePerDay = hasHistory
    ? totalDone / activeDays
    : Math.max(fallbackRate, 0.01);

  const confidence =
    totalDone >= 10 && activeDays >= 3
      ? "high"
      : totalDone >= 3
      ? "medium"
      : "low";

  const tickets = open.map((t, i) => {
    const position = i + 1; // 1-based place in the queue
    const daysOut = Math.max(1, Math.ceil(position / ratePerDay));
    const predicted = addDays(today, daysOut);
    const predictedCompletion = toISO(predicted);

    const due = t.dueDate ? parseISO(t.dueDate) : null;
    let slipDays = null;
    let atRisk = false;
    if (due) {
      slipDays = daysBetween(due, predicted); // >0 => predicted after the due date
      atRisk = slipDays > 0;
    }

    return {
      ticket: t.ticketNumber,
      title: t.title,
      status: t.status,
      priority: t.priority != null ? t.priority : null,
      product: t.product || null,
      queuePosition: position,
      dueDate: t.dueDate || null,
      predictedCompletion,
      // a due-date suggestion for tickets that don't have one yet
      suggestedDueDate: t.dueDate ? null : predictedCompletion,
      slipDays,
      atRisk,
    };
  });

  const projectedCompletion = tickets.length
    ? tickets[tickets.length - 1].predictedCompletion
    : null;
  const atRisk = tickets.filter((t) => t.atRisk);

  return {
    asOf: toISO(today),
    ratePerDay: Math.round(ratePerDay * 100) / 100,
    confidence,
    basis: { totalDone, activeDays, usedFallback: !hasHistory },
    openCount: tickets.length,
    projectedCompletion,
    atRiskCount: atRisk.length,
    tickets,
  };
}

// ---------------------------------------------------------------------------
// board wrapper
// ---------------------------------------------------------------------------

/** Same open-queue ordering next_task uses: In Progress first, then priority, due, id. */
function workOrder(a, b) {
  const rank = (t) => (t.status === "In Progress" ? 0 : 1);
  const prio = (t) => (t.priority != null ? t.priority : Infinity);
  const dueVal = (t) => (t.dueDate ? Date.parse(t.dueDate) || Infinity : Infinity);
  const num = (t) => parseInt((t.ticketNumber || "").replace(/\D+/g, ""), 10) || 0;
  return rank(a) - rank(b) || prio(a) - prio(b) || dueVal(a) - dueVal(b) || num(a) - num(b);
}

/**
 * Predict completion dates for a board's open work.
 * @param {import('./storage.js').Board} board
 * @param {string} project
 * @param {object} [opts] { type: "all"|"feature"|"bug", asOf }
 */
export function predictDueDates(board, project, opts = {}) {
  const type = opts.type || "all";
  const all = board.listTasks(project, { type });
  const open = all.filter((t) => t.status !== "Done").sort(workOrder);
  const doneDates = all
    .filter((t) => t.status === "Done" && t.completionDate)
    .map((t) => t.completionDate);

  const result = predictCompletion({
    open,
    doneDates,
    asOf: opts.asOf ? new Date(opts.asOf) : undefined,
  });
  return { project, type, ...result };
}

// ---------------------------------------------------------------------------
// FBMCPF-269: ETA hints — per-ticket wall-clock estimate
// ---------------------------------------------------------------------------

// Static fallback ranges (minutes) used when a project has fewer than
// ETA_MIN_SAMPLES measurable historical durations for a ticket's effort label.
const ETA_DEFAULTS = {
  low: { low: 5, high: 10 },
  medium: { low: 10, high: 20 },
  high: { low: 20, high: 40 },
};
const ETA_MIN_SAMPLES = 3;

function etaPercentile(sorted, p) {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * A Done ticket's measured wall-clock duration in minutes, from its most
 * recent status->"In Progress" audit event to its most recent status->"Done"
 * audit event (mirrors events.js's resolveStartedInProgress/resolveCompletedAt
 * conventions: "most recent" because events are append-order and a ticket that
 * bounced back through In Progress more than once should be measured by its
 * final run, not a stale earlier one). Returns null when there's no usable
 * In Progress -> Done pair, or when the pair doesn't resolve to a positive
 * duration (e.g. clock skew, or a ticket whose events predate FBMCPF-142).
 */
function measuredMinutes(board, project, ticketNumber) {
  const statusEvents = eventsForTicket(board, project, ticketNumber).filter((e) => e.field === "status");
  const starts = statusEvents.filter((e) => e.to === "In Progress");
  const ends = statusEvents.filter((e) => e.to === "Done");
  if (!starts.length || !ends.length) return null;
  const startMs = Date.parse(starts[starts.length - 1].ts);
  const endMs = Date.parse(ends[ends.length - 1].ts);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return null;
  const minutes = (endMs - startMs) / 60000;
  return minutes > 0 ? minutes : null;
}

/**
 * Estimate how long a ticket will take, in minutes (FBMCPF-269 "ETA hints").
 *
 * Basis (a): a historical median wall-clock duration for OTHER Done tickets
 * in this project sharing the same effort:<low|medium|high> label — measured
 * via measuredMinutes() above — when there are at least ETA_MIN_SAMPLES (3)
 * usable samples. The range is the sample's 25th-75th percentile band, so
 * it reflects genuine observed spread rather than a made-up multiplier.
 *
 * Basis (b): a documented static default per effort label (low ~5-10min,
 * medium ~10-20min, high ~20-40min) when history is thin.
 *
 * `ticket`'s own effort:* label decides which bucket it's estimated against;
 * a ticket with no effort label is treated as "medium" (same default budget.js
 * uses for effort-less tickets elsewhere). Always honest about its basis:
 * "history (n=X)" or "default" — never silently blends the two.
 */
export function estimateTicketMinutes(board, project, ticket) {
  const task = board.getTask(project, ticket);
  if (!task) throw new Error(`Ticket ${ticket} not found in "${project}".`);
  const effort = effortOfTask(task) || "medium";

  const samples = [];
  for (const t of board.listTasks(project, {})) {
    if (t.status !== "Done") continue;
    if (t.ticketNumber === task.ticketNumber) continue; // never use a ticket as its own history
    if (effortOfTask(t) !== effort) continue; // only same-label tickets count as history for this bucket
    const minutes = measuredMinutes(board, project, t.ticketNumber);
    if (minutes != null) samples.push(minutes);
  }

  if (samples.length >= ETA_MIN_SAMPLES) {
    const sorted = samples.slice().sort((a, b) => a - b);
    let low = Math.max(1, Math.round(etaPercentile(sorted, 0.25)));
    let high = Math.round(etaPercentile(sorted, 0.75));
    if (high <= low) high = low + Math.max(1, Math.round(low * 0.2));
    return { estimatedMinutes: { low, high }, basis: `history (n=${samples.length})` };
  }

  const fallback = ETA_DEFAULTS[effort] || ETA_DEFAULTS.medium;
  return { estimatedMinutes: { low: fallback.low, high: fallback.high }, basis: "default" };
}

// end of predictive.js
