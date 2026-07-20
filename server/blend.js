// Plan-meter blend tracking (FBMCPF-278/279).
//
// Claude Max's weekly usage tab shows two meters that reset together: a Fable
// sub-limit (the scarce orchestrator resource) and an all-models limit (the
// volume — sonnet/opus/haiku). The board's job is to help BOTH meters converge
// to exhaustion at the same reset, so no budget is stranded.
//
// planLimits lives in the account-wide global config (git.js get/setGlobalConfig):
//   { fablePct, allModelsPct, capturedAt (ISO), resetAt (ISO), targetRatio }
//
// blendStatus() is a pure function of (globalCfg, now) so it's trivially
// unit-testable; blendPlan() layers a concrete per-day wave plan on top of it,
// reusing estimateTicketMinutes + the board's historical tokens-per-ticket.
//
// No import cycle: metadata.js / predictive.js do NOT import this module, so we
// can import from them here freely.

import { estimateTicketMinutes as defaultEstimateTicketMinutes } from "./predictive.js";
import { velocity as defaultVelocity, readWorkLog as defaultReadWorkLog } from "./metadata.js";

// Weekly meters: capturedAt must be within one cycle of resetAt to be trusted.
const CYCLE_DAYS = 7;
const CYCLE_MS = CYCLE_DAYS * 24 * 3600 * 1000;

// verdict thresholds: fable is "hot" when it leads all-models by more than this
// many points (and "cold" when it trails by more), else "balanced".
const DELTA_THRESHOLD = 5;

// Fallback tokens-per-ticket when a board has no logged history to draw on.
const DEFAULT_TOKENS_PER_TICKET = 60000;

const round1 = (n) => Math.round(n * 10) / 10;

function toMs(t) {
  if (t instanceof Date) return t.getTime();
  if (typeof t === "number") return t;
  const p = Date.parse(t);
  return Number.isNaN(p) ? NaN : p;
}

/**
 * Pure blend status from the account-wide planLimits, or null when unset/stale.
 *
 * Returns null when:
 *   - globalCfg has no planLimits, or planLimits is malformed;
 *   - the capture is stale: capturedAt predates the current cycle window
 *     (older than resetAt minus one 7-day cycle);
 *   - the cycle has already ended (now >= resetAt) — the meters have reset and
 *     the captured numbers no longer describe the live window.
 *
 * Otherwise returns:
 *   { fablePct, allModelsPct, delta, fableDailyAllowancePct,
 *     nonFableDailyNeededPct, hoursToReset, daysToReset,
 *     verdict, recommendation }
 *
 * delta = fablePct - allModelsPct*targetRatio (targetRatio default 1.0, so by
 * default just how many points hotter fable is running than all-models).
 * fableDailyAllowancePct spreads fable's REMAINING headroom over the days left;
 * nonFableDailyNeededPct is the per-day all-models burn required to also reach
 * exhaustion by resetAt — i.e. the pace that converges the two meters.
 */
export function blendStatus(globalCfg, now = new Date()) {
  const pl = globalCfg && globalCfg.planLimits;
  if (!pl || typeof pl !== "object") return null;

  const fablePct = Number(pl.fablePct);
  const allModelsPct = Number(pl.allModelsPct);
  const targetRatio = pl.targetRatio == null ? 1.0 : Number(pl.targetRatio);
  const capMs = toMs(pl.capturedAt);
  const resetMs = toMs(pl.resetAt);
  const nowMs = toMs(now);
  if (
    !Number.isFinite(fablePct) || !Number.isFinite(allModelsPct) ||
    !Number.isFinite(targetRatio) ||
    Number.isNaN(capMs) || Number.isNaN(resetMs) || Number.isNaN(nowMs)
  ) {
    return null;
  }

  // stale capture: taken before the current cycle window opened.
  if (capMs < resetMs - CYCLE_MS) return null;
  // cycle already over — meters have reset, the numbers are moot.
  if (nowMs >= resetMs) return null;

  const hoursToReset = round1((resetMs - nowMs) / 3600000);
  const daysToReset = round1(hoursToReset / 24);
  const days = Math.max(hoursToReset / 24, 1 / 24); // floor at 1h to keep per-day finite

  const delta = round1(fablePct - allModelsPct * targetRatio);
  const fableDailyAllowancePct = round1(Math.max(0, 100 - fablePct) / days);
  const nonFableDailyNeededPct = round1(Math.max(0, 100 - allModelsPct) / days);

  let verdict;
  if (delta > DELTA_THRESHOLD) verdict = "fable-hot";
  else if (delta < -DELTA_THRESHOLD) verdict = "fable-cold";
  else verdict = "balanced";

  let recommendation;
  if (verdict === "fable-hot") {
    recommendation =
      `Fable is ${round1(Math.abs(delta))} pts hotter than all-models — push volume onto sonnet/opus sub-agents ` +
      `(~${nonFableDailyNeededPct}%/day of the all-models meter) and hold fable to ~${fableDailyAllowancePct}%/day ` +
      `so both meters exhaust together in ${daysToReset}d.`;
  } else if (verdict === "fable-cold") {
    recommendation =
      `Fable is ${round1(Math.abs(delta))} pts behind all-models — route more planning/review through fable ` +
      `(~${fableDailyAllowancePct}%/day) and ease off sonnet/opus volume so both meters converge by reset in ${daysToReset}d.`;
  } else {
    recommendation =
      `Meters are balanced (delta ${delta} pts) — hold the current mix: ~${fableDailyAllowancePct}%/day fable and ` +
      `~${nonFableDailyNeededPct}%/day non-fable to converge by reset in ${daysToReset}d.`;
  }

  return {
    fablePct: round1(fablePct),
    allModelsPct: round1(allModelsPct),
    delta,
    fableDailyAllowancePct,
    nonFableDailyNeededPct,
    hoursToReset,
    daysToReset,
    verdict,
    recommendation,
  };
}

/** Median of a numeric array (rounded), or null when empty. */
function median(xs) {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/** Historical median tokens-per-ticket from the work log (Done or otherwise);
 *  null when the board has no logged tokens yet. Best-effort — never throws. */
function historicalTokensPerTicket(board, project, { velocity, readWorkLog }) {
  try {
    const v = velocity(readWorkLog(board, project));
    const perTicket = Object.values(v.byTicket || {})
      .map((t) => t.tokens)
      .filter((n) => Number.isFinite(n) && n > 0);
    return median(perTicket);
  } catch {
    return null;
  }
}

/**
 * Concrete per-day convergence plan layered on blendStatus (FBMCPF-279). Returns
 * null when planLimits is unset/stale (same gate as blendStatus).
 *
 * {
 *   daysToReset, fablePerDayPct, nonFablePerDayPct, convergeBy (=resetAt),
 *   verdict,
 *   waves: [ suggestion strings ]  // e.g. "2-3 parallel sonnet/opus waves/day
 *                                   //       (~60k logged tokens each) ..."
 * }
 *
 * The wave count is sized from the open-ticket backlog (how many must clear per
 * day to reach reset) grouped into ~2-3-ticket parallel waves; the per-wave
 * token figure is the board's historical median tokens-per-ticket (metadata
 * velocity), falling back to a documented default when history is thin.
 * estimateTicketMinutes is used to weight heavier tickets toward fewer parallel
 * slots so the suggestion stays plausible.
 */
export function blendPlan(board, project, globalCfg, now = new Date(), deps = {}) {
  const estimateTicketMinutes = deps.estimateTicketMinutes || defaultEstimateTicketMinutes;
  const velocity = deps.velocity || defaultVelocity;
  const readWorkLog = deps.readWorkLog || defaultReadWorkLog;

  const status = blendStatus(globalCfg, now);
  if (!status) return null;

  const daysToReset = status.daysToReset;
  const fablePerDayPct = status.fableDailyAllowancePct;
  const nonFablePerDayPct = status.nonFableDailyNeededPct;
  const convergeBy = globalCfg.planLimits.resetAt;

  // Open backlog and its rough per-day effort weighting.
  let open = [];
  try {
    open = board.listTasks(project, {}).filter((t) => t.status !== "Done");
  } catch {
    open = [];
  }
  const openCount = open.length;

  // Average estimated minutes across open tickets — heavier work means fewer
  // tickets fit a parallel wave.
  let avgMinutes = 20;
  const mins = [];
  for (const t of open) {
    try {
      const eta = estimateTicketMinutes(board, project, t.ticketNumber);
      const m = eta && eta.estimatedMinutes;
      if (m) mins.push((m.low + m.high) / 2);
    } catch { /* ignore per-ticket eta failures */ }
  }
  if (mins.length) avgMinutes = mins.reduce((a, c) => a + c, 0) / mins.length;
  // Heavier tickets => smaller parallel waves (2 for >30min avg, else 3).
  const perWave = avgMinutes > 30 ? 2 : 3;

  const days = Math.max(daysToReset, 0.5);
  const ticketsPerDay = openCount > 0 ? Math.ceil(openCount / days) : 0;
  const wavesPerDayHi = Math.max(2, Math.min(4, Math.ceil(ticketsPerDay / perWave) || 2));
  const wavesPerDayLo = Math.max(1, wavesPerDayHi - 1);
  const waveRange = wavesPerDayLo === wavesPerDayHi ? `${wavesPerDayHi}` : `${wavesPerDayLo}-${wavesPerDayHi}`;

  const tpt = historicalTokensPerTicket(board, project, { velocity, readWorkLog }) || DEFAULT_TOKENS_PER_TICKET;
  const tptK = Math.max(1, Math.round(tpt / 1000));

  const waves = [];
  waves.push(
    `${waveRange} parallel sonnet/opus waves/day (~${tptK}k logged tokens each) to burn ~${nonFablePerDayPct}%/day of the all-models meter.`
  );
  waves.push(
    `Hold fable to ~${fablePerDayPct}%/day: reserve it for orchestration, planning, and review, and batch board ops into few turns.`
  );
  if (status.verdict === "fable-hot") {
    waves.unshift(
      `Fable is running hot (${status.fablePct}% vs ${status.allModelsPct}%): dispatch implementation tickets to sonnet/opus sub-agents and keep orchestrator turns terse.`
    );
  } else if (status.verdict === "fable-cold") {
    waves.unshift(
      `Fable is running cold (${status.fablePct}% vs ${status.allModelsPct}%): pull more planning/review inline on fable and let sonnet/opus volume ease until the meters even out.`
    );
  }

  return {
    daysToReset,
    fablePerDayPct,
    nonFablePerDayPct,
    convergeBy,
    verdict: status.verdict,
    openTickets: openCount,
    tokensPerTicket: tpt,
    waves,
  };
}
