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
 */

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

// end of predictive.js
