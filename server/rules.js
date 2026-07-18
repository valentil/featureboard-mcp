/**
 * FBMCPF-196: a small, declarative automation-rules engine.
 *
 * Generalizes the ad-hoc intake-guard / stalled-flag / scan-cleanup patterns
 * into config-driven rules that fire ON TOOL CALLS — there is NO daemon or
 * background process (matching FeatureBoard's whole architecture). A tool
 * handler that mutates a ticket (add_feature/log_bug, set_status, close_sprint)
 * calls evaluateRules() after the mutation; matching rules apply their action
 * and each application appends an audit event to ticket_events.jsonl.
 *
 * Rules live per-project in .featureboard.config.json under "rules" (a
 * CONFIG_KEYS entry), each shaped:
 *   {
 *     name?: string,
 *     trigger: "ticket-created" | "status-change" | "sprint-closed",
 *     condition?: { product?, label?, priority? (number | {lte,gte}),
 *                   to?, from?, ageDaysGte? },   // omitted/empty = always match
 *     action: { type: "set-label"|"set-priority"|"assign-sprint"|"warn"|"notify-slack", ... }
 *   }
 *
 * The engine is deliberately conservative: an unknown trigger/action is skipped,
 * and every action is wrapped so a rule can never break the tool call that
 * triggered it. board mutations go through board.updateTask (labels/priority/
 * sprint); notify-slack is delegated to an injected notify() so this module
 * stays free of network/config concerns and is unit-testable.
 */

import { getProjectConfig } from "./metadata.js";
import { appendEvent } from "./events.js";

export const RULE_TRIGGERS = ["ticket-created", "status-change", "sprint-closed"];
export const RULE_ACTIONS = ["set-label", "set-priority", "assign-sprint", "warn", "notify-slack"];

const SPRINT_LABEL_RE = /^sprint:/i;

/** A project's configured rules (only well-formed ones with a known trigger). */
export function getRules(board, project) {
  let cfg = {};
  try {
    cfg = getProjectConfig(board, project) || {};
  } catch {
    cfg = {};
  }
  const rules = Array.isArray(cfg.rules) ? cfg.rules : [];
  return rules.filter((r) => r && typeof r === "object" && RULE_TRIGGERS.includes(r.trigger) && r.action);
}

/**
 * Pure predicate: does `condition` match `task` under event context `ctx`
 * ({ to, from, now })? An absent/empty condition matches everything. Supported
 * keys: product (case-insensitive equals), label (must be present),
 * priority (exact number, or { lte, gte }), to/from (status-change context),
 * ageDaysGte (task age in days from createdDate).
 */
export function matchesCondition(condition, task, ctx = {}) {
  if (!condition || typeof condition !== "object" || !Object.keys(condition).length) return true;
  const c = condition;
  if (!task) return false;
  if (c.product != null && String(task.product || "").toLowerCase() !== String(c.product).toLowerCase()) return false;
  if (c.label != null && !(task.labels || []).some((l) => String(l).toLowerCase() === String(c.label).toLowerCase())) return false;
  if (c.priority != null) {
    const p = task.priority;
    if (typeof c.priority === "number") {
      if (p !== c.priority) return false;
    } else if (typeof c.priority === "object") {
      if (c.priority.lte != null && !(p != null && p <= c.priority.lte)) return false;
      if (c.priority.gte != null && !(p != null && p >= c.priority.gte)) return false;
    }
  }
  if (c.to != null && String(ctx.to || "") !== String(c.to)) return false;
  if (c.from != null && String(ctx.from || "") !== String(c.from)) return false;
  if (c.ageDaysGte != null) {
    const created = task.createdDate ? Date.parse(task.createdDate) : NaN;
    if (Number.isNaN(created)) return false;
    const nowMs = ctx.now ? new Date(ctx.now).getTime() : Date.now();
    if (!((nowMs - created) / 86400000 >= c.ageDaysGte)) return false;
  }
  return true;
}

/** Apply one action to a ticket; returns a result descriptor or null (skipped). */
function applyAction(board, project, ticket, task, action, { notify, warnings }) {
  const type = action.type || action.action;
  if (type === "set-label" && action.label) {
    const labels = Array.from(new Set([...(task.labels || []).map(String), String(action.label)]));
    board.updateTask(project, ticket, { labels });
    return { type, label: String(action.label) };
  }
  if (type === "set-priority" && action.priority != null) {
    board.updateTask(project, ticket, { priority: Number(action.priority) });
    return { type, priority: Number(action.priority) };
  }
  if (type === "assign-sprint" && action.sprint) {
    const others = (task.labels || []).filter((l) => !SPRINT_LABEL_RE.test(String(l)));
    board.updateTask(project, ticket, { labels: [...others, `sprint:${action.sprint}`] });
    return { type, sprint: String(action.sprint) };
  }
  if (type === "warn") {
    const message = action.message || `Automation rule matched for ${ticket}`;
    warnings.push(message);
    return { type, message };
  }
  if (type === "notify-slack") {
    const message = action.message || `Automation rule fired for ${ticket}`;
    if (typeof notify === "function") {
      try { notify(message); } catch { /* slack is best-effort */ }
    }
    return { type, message };
  }
  return null; // unknown action
}

/**
 * Evaluate the project's rules for one event and apply the matching ones.
 * `event` = { trigger, ticket, to?, from? }. Ticket-scoped: the ticket named in
 * the event is loaded once and every matching rule for that trigger is applied
 * to it. Returns { applied: [...], warnings: [...] }. Never throws — a failing
 * rule action is swallowed so it can't break the triggering tool call.
 */
export function evaluateRules(board, project, event = {}, { notify = null, now = new Date() } = {}) {
  const applied = [];
  const warnings = [];
  const { trigger, ticket } = event;
  if (!RULE_TRIGGERS.includes(trigger) || !ticket) return { applied, warnings };

  let rules;
  try {
    rules = getRules(board, project).filter((r) => r.trigger === trigger);
  } catch {
    return { applied, warnings };
  }
  if (!rules.length) return { applied, warnings };

  for (const rule of rules) {
    try {
      const task = board.getTask(project, ticket); // re-read: an earlier rule may have mutated it
      if (!task) continue;
      if (!matchesCondition(rule.condition, task, { to: event.to, from: event.from, now })) continue;
      const result = applyAction(board, project, ticket, task, rule.action, { notify, warnings });
      if (!result) continue;
      try {
        appendEvent(board, project, { ticket, field: "rule", from: rule.trigger, to: result.type, source: "rules" });
      } catch { /* audit is best-effort */ }
      applied.push({ rule: rule.name || null, trigger: rule.trigger, ...result });
    } catch {
      // one rule's failure must never break the triggering tool call
    }
  }
  return { applied, warnings };
}
