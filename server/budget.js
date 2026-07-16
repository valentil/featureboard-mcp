// Estimator + budget planner (FBMCPF-123/124) and model tiering (FBMCPF-125).
//
// estimateWork: per-ticket token estimates for open work, from (in precedence
// order) a cap:<tokens> label, the median actual spend for Done tickets in the
// same product, the board-wide median, or a documented default. Deterministic
// and explainable: every estimate carries its basis.
//
// planBudget: walks the priority-ordered open queue and maps the coming week's
// token spend BEFORE it happens — day assignments, the cutline where the
// budget runs out, and an Opus/Sonnet split with blended cost units.

import * as meta from "./metadata.js";

export const CAP_LABEL_RE = /^cap:(\d+(?:\.\d+)?)([km]?)$/i;
export const MODEL_LABEL_RE = /^model:([a-z0-9._-]+)$/i;

const DEFAULT_ESTIMATE = 60000; // tokens, when no history and no cap label
const MIN_SAMPLES = 3; // actual spends needed before a median is trusted
// blended relative cost per token (planning weight, not pricing)
const COST_UNITS = { fable: 6, opus: 5, sonnet: 1, haiku: 0.25 };

export function capOfTask(t) {
  for (const l of t.labels || []) {
    const m = String(l).match(CAP_LABEL_RE);
    if (m) return Math.round(parseFloat(m[1]) * (m[2]?.toLowerCase() === "m" ? 1e6 : m[2]?.toLowerCase() === "k" ? 1e3 : 1));
  }
  return null;
}

export function modelOfTask(t) {
  for (const l of t.labels || []) {
    const m = String(l).match(MODEL_LABEL_RE);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

/** Heuristic model suggestion when no model: label is present (FBMCPF-125). */
export function suggestModel(t) {
  if (modelOfTask(t)) return { model: modelOfTask(t), basis: "model label" };
  if (t.type === "bug") return { model: "sonnet", basis: "bug → sonnet" };
  const hard = /architect|schema|storage|server|parallel|orchestr|dependenc|refactor|migration|protocol/i;
  if (hard.test(`${t.title} ${t.description || ""}`)) return { model: "opus", basis: "architecture keywords" };
  const lightProducts = new Set(["Docs & Packaging", "Website", "Board UI", "Board UX", "Media", "Mail & Marketing"]);
  if (t.product && lightProducts.has(t.product)) return { model: "sonnet", basis: "light product" };
  return { model: t.priority != null && t.priority <= 3 ? "opus" : "sonnet", basis: "priority default" };
}

function median(xs) {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

function spendByTicket(entries) {
  const spend = {};
  for (const e of entries || []) {
    if (!e.ticket) continue;
    const n = e.tokens || (e.inputTokens || 0) + (e.outputTokens || 0) || 0;
    spend[e.ticket] = (spend[e.ticket] || 0) + n;
  }
  return spend;
}

/** Per-ticket estimates for all open (Todo / In Progress) tickets. */
export function estimateWork(board, project) {
  const tasks = board.listTasks(project, {});
  const spend = spendByTicket(meta.readWorkLog(board, project));

  // history: actual spends of Done tickets, grouped by product
  const byProduct = {};
  const allActuals = [];
  for (const t of tasks) {
    if (t.status !== "Done") continue;
    const s = spend[t.ticketNumber];
    if (!s) continue;
    allActuals.push(s);
    const p = t.product || "(none)";
    (byProduct[p] = byProduct[p] || []).push(s);
  }
  const boardMedian = median(allActuals);

  const open = tasks.filter((t) => t.status !== "Done");
  const estimates = open.map((t) => {
    const cap = capOfTask(t);
    let estimate, basis, confidence;
    if (cap != null) {
      estimate = cap; basis = "cap label"; confidence = "high";
    } else {
      const pm = median(byProduct[t.product || "(none)"] || []);
      if (pm != null && (byProduct[t.product || "(none)"] || []).length >= MIN_SAMPLES) {
        estimate = pm; basis = `product median (${t.product})`; confidence = "medium";
      } else if (boardMedian != null && allActuals.length >= MIN_SAMPLES) {
        estimate = boardMedian; basis = "board median"; confidence = "low";
      } else {
        estimate = DEFAULT_ESTIMATE; basis = "default"; confidence = "low";
      }
    }
    const spent = spend[t.ticketNumber] || 0;
    const m = suggestModel(t);
    return {
      ticket: t.ticketNumber, title: t.title, status: t.status,
      product: t.product || null, priority: t.priority != null ? t.priority : null,
      estimate, spent, remaining: Math.max(0, estimate - spent),
      basis, confidence, model: m.model, modelBasis: m.basis,
    };
  });

  return {
    project,
    openTickets: estimates.length,
    history: { doneWithSpend: allActuals.length, boardMedian, defaultEstimate: DEFAULT_ESTIMATE },
    estimates,
  };
}

/** Map a token budget onto the priority-ordered queue before spending it. */
export function planBudget(board, project, { budgetTokens = 25_000_000, days = 5, sprint = null } = {}) {
  const { estimates, history } = estimateWork(board, project);
  const sprintRe = /^sprint:(.+)$/i;
  const tasks = board.listTasks(project, {});
  const sprintOf = (tk) => {
    const t = tasks.find((x) => x.ticketNumber === tk);
    for (const l of (t && t.labels) || []) { const m = String(l).match(sprintRe); if (m) return m[1].trim(); }
    return null;
  };
  let queue = estimates;
  if (sprint) queue = queue.filter((e) => (sprintOf(e.ticket) || "").toLowerCase() === String(sprint).toLowerCase());
  // priority order (1 = top, unset last), then older tickets first
  const num = (tk) => parseInt(String(tk).replace(/\D+/g, ""), 10) || 0;
  queue = queue.slice().sort((a, b) => {
    const pa = a.priority == null ? Infinity : a.priority;
    const pb = b.priority == null ? Infinity : b.priority;
    return pa - pb || num(a.ticket) - num(b.ticket);
  });

  const dayLoads = Array.from({ length: Math.max(1, days) }, () => 0);
  const planned = [], unplanned = [];
  let cumulative = 0;
  const byModel = {};
  let costUnits = 0;
  for (const e of queue) {
    if (cumulative + e.remaining <= budgetTokens) {
      cumulative += e.remaining;
      // greedy: put the ticket on the lightest day
      let day = 0;
      for (let i = 1; i < dayLoads.length; i++) if (dayLoads[i] < dayLoads[day]) day = i;
      dayLoads[day] += e.remaining;
      byModel[e.model] = (byModel[e.model] || 0) + e.remaining;
      costUnits += e.remaining * (COST_UNITS[e.model] ?? 1);
      planned.push({ ...e, day: day + 1, cumulative });
    } else {
      unplanned.push({ ticket: e.ticket, title: e.title, estimate: e.remaining, model: e.model });
    }
  }
  return {
    project, budgetTokens, days, sprint: sprint || null,
    history,
    plan: planned,
    cutline: unplanned.length
      ? { after: planned.length ? planned[planned.length - 1].ticket : null, unplannedTickets: unplanned.length, unplannedTokens: unplanned.reduce((a, c) => a + c.estimate, 0) }
      : null,
    unplanned,
    totals: {
      plannedTickets: planned.length,
      plannedTokens: cumulative,
      remainingBudget: budgetTokens - cumulative,
      byModel,
      costUnits: Math.round(costUnits),
      byDay: dayLoads.map((tokens, i) => ({ day: i + 1, tokens })),
    },
  };
}

export const EFFORT_LABEL_RE = /^effort:(low|medium|high)$/i;

export function effortOfTask(t) {
  for (const l of t.labels || []) {
    const m = String(l).match(EFFORT_LABEL_RE);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

/** Effort heuristic (FBMCPF-152): explicit label > cap-derived size > title
 *  keywords (description is NOT scanned; free text there shouldn't override
 *  a title's or cap's signal) > estimate-size fallback. */
export function suggestEffort(t, estimate) {
  const labeled = effortOfTask(t);
  if (labeled) return { effort: labeled, basis: "effort label" };

  const cap = capOfTask(t);
  if (cap != null) {
    if (cap <= 50000) return { effort: "low", basis: "cap size" };
    if (cap <= 120000) return { effort: "medium", basis: "cap size" };
    return { effort: "high", basis: "cap size" };
  }

  const title = t.title || "";
  if (/architect|schema|migration|orchestr|protocol|storage format|invariant|parallel/i.test(title)) {
    return { effort: "high", basis: "hard keywords" };
  }
  if (/docs|copy|readme|page|label|chip|badge|rename|typo|comment/i.test(title)) {
    return { effort: "low", basis: "light keywords" };
  }

  if (estimate > 120000) return { effort: "high", basis: "large estimate" };
  if (estimate <= 50000) return { effort: "low", basis: "small estimate" };
  return { effort: "medium", basis: "default" };
}

/** Model roster (FBMCPF-152): what each Claude tier is trusted with.
 *  fable  — orchestration, cross-cutting design, spec/architecture review
 *  opus   — architecture, multi-file server changes, storage invariants
 *  sonnet — standard implementation: UI, features, most bugs, integrations
 *  haiku  — mechanical work: docs/copy edits, label churn, data reshaping */
export function rosterModel(t, effort) {
  const labeled = modelOfTask(t);
  if (labeled) return { model: labeled, basis: "model label" };
  const text = `${t.title} ${t.description || ""}`;
  if (/orchestrat|cross-cutting|design review|spec review|roadmap|strategy/i.test(text)) return { model: "fable", basis: "orchestration/design keywords" };
  if (effort === "low" && /docs|copy|readme|listing|comparison page|privacy|typo|comment/i.test(text) && t.type !== "bug") {
    return { model: "haiku", basis: "mechanical docs/copy" };
  }
  const s = suggestModel(t);
  return { model: s.model, basis: s.basis };
}

/** Today's slice of the queue with model + effort per ticket (FBMCPF-152).
 *  apply=true writes model:/effort: labels back to the tickets.
 *  budgetTokens default 650000: ~ weekly 25M effective ÷ 5 days ÷ ×8 orchestration multiplier. */
export function dailyPlan(board, project, { budgetTokens = 650_000, sprint = null, apply = false } = {}) {
  const plan = planBudget(board, project, { budgetTokens, days: 1, sprint });
  const tasks = board.listTasks(project, {});
  const byId = Object.fromEntries(tasks.map((t) => [t.ticketNumber, t]));
  const rows = plan.plan.map((e) => {
    const t = byId[e.ticket] || { labels: [], title: e.title };
    const eff = suggestEffort(t, e.estimate);
    const mod = rosterModel(t, eff.effort);
    return { ticket: e.ticket, title: e.title, estimate: e.remaining, spent: e.spent, model: mod.model, modelBasis: mod.basis, effort: eff.effort, effortBasis: eff.basis };
  });
  const byModel = {};
  rows.forEach((r) => { byModel[r.model] = byModel[r.model] || { tickets: 0, tokens: 0 }; byModel[r.model].tickets++; byModel[r.model].tokens += r.estimate; });
  let applied = 0;
  if (apply) {
    for (const r of rows) {
      const t = byId[r.ticket];
      if (!t) continue;
      const labels = (t.labels || []).filter((l) => !MODEL_LABEL_RE.test(String(l)) && !EFFORT_LABEL_RE.test(String(l)));
      labels.push(`model:${r.model}`, `effort:${r.effort}`);
      board.updateTask(project, r.ticket, { labels });
      applied++;
    }
  }
  return {
    project, date: new Date().toISOString().slice(0, 10), budgetTokens, sprint: sprint || null,
    plan: rows, byModel,
    cutline: plan.cutline, unplanned: plan.unplanned,
    totals: { tickets: rows.length, tokens: plan.totals.plannedTokens, costUnits: plan.totals.costUnits },
    applied: apply ? applied : 0,
    dispatch: {
      parallel: rows.filter((r) => r.model === "sonnet" || r.model === "haiku").map((r) => r.ticket),
      sequential: rows.filter((r) => r.model === "opus" || r.model === "fable").map((r) => r.ticket),
      note: "sonnet/haiku tickets can run as parallel sub-agents; opus/fable tickets run sequentially with review between.",
    },
  };
}
