/**
 * FeatureBoard Slack integration (FBMCPF-155) — optional, opt-in, local-first.
 *
 * The board is local by default and never phones home. Slack is the one deliberate
 * egress point, and it is off unless the user configures it: they paste an incoming
 * webhook URL into the project config and pick which events may be posted. Nothing
 * leaves the machine until both of those are set.
 *
 * Config lives in the project's managed config (the orchestrator adds "slackWebhook"
 * and "slackEvents" to CONFIG_KEYS so they persist alongside the other settings):
 *   - slackWebhook : "https://hooks.slack.com/services/T.../B.../xxxx"  (string)
 *   - slackEvents  : ["done","review","summary"]                        (array)
 *
 * Egress safety: slackConfigured() only accepts an https:// URL whose host is exactly
 * hooks.slack.com. We validate the host (not just "starts with https") so a malformed
 * or hostile config value can't be turned into an arbitrary outbound POST target — the
 * webhook field is user-controlled and this module is the thing that fetches it, so it
 * enforces the destination itself rather than trusting the caller.
 *
 * notifySlack never throws: any problem (not configured, event filtered out, network
 * error, non-2xx response, timeout) is returned as { sent:false, reason|warning }. That
 * mirrors git.js's failure-tolerant style — an optional integration must never break the
 * primary board operation it is attached to.
 */

import fs from "node:fs";
import path from "node:path";
import { getProjectConfig } from "./metadata.js";

/** Events that may be posted, in the absence of an explicit slackEvents config. */
export const DEFAULT_SLACK_EVENTS = ["done", "review", "summary"];

const MANAGED_CONFIG = ".featureboard.config.json";
const SLACK_WEBHOOK_HOST = "hooks.slack.com";
const POST_TIMEOUT_MS = 5000;

/**
 * Read the Slack settings for a project. Starts from the merged project config
 * (getProjectConfig — legacy overlaid by managed) and then overlays slackWebhook /
 * slackEvents read directly from the managed config file. The direct read keeps this
 * module self-contained: the two keys live in the managed config, but until the
 * orchestrator adds them to metadata.js's CONFIG_KEYS whitelist, getProjectConfig won't
 * surface them — reading the file directly means Slack works regardless of that ordering.
 */
export function getSlackConfig(board, project) {
  let cfg = {};
  try {
    cfg = getProjectConfig(board, project) || {};
  } catch {
    cfg = {};
  }
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(board.projectDir(project), MANAGED_CONFIG), "utf8"));
    if (cfg.slackWebhook === undefined && raw.slackWebhook !== undefined) cfg.slackWebhook = raw.slackWebhook;
    if (cfg.slackEvents === undefined && raw.slackEvents !== undefined) cfg.slackEvents = raw.slackEvents;
  } catch {
    // no managed config / unreadable — fall back to whatever getProjectConfig gave us
  }
  return cfg;
}

/**
 * True when `cfg` carries a usable Slack webhook: an https:// URL pointing at
 * hooks.slack.com. Host is validated (see file header) so an arbitrary URL in the
 * config can't be used as an egress target. Anything else — http, another host, a
 * non-URL string, empty/missing — is false.
 */
export function slackConfigured(cfg) {
  const raw = cfg && cfg.slackWebhook;
  if (!raw || typeof raw !== "string") return false;
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    return false;
  }
  return url.protocol === "https:" && url.hostname === SLACK_WEBHOOK_HOST;
}

/** The list of events allowed for this config (defaults when unset/invalid). */
function allowedEvents(cfg) {
  const e = cfg && cfg.slackEvents;
  return Array.isArray(e) && e.length ? e : DEFAULT_SLACK_EVENTS;
}

/**
 * Render a ticket event into Slack mrkdwn text (pure — no config, no network).
 *   done   → "✅ *FBF-12* Title — Done (Project)"  (+ a second line with the
 *            completionSummary when the ticket carries one)
 *   review → "👀 *FBF-12* Title — ready for review (Project)"
 * Any other event falls back to a neutral status line so callers always get text.
 */
export function formatTicketEvent(event, task, project) {
  const t = task || {};
  const id = t.ticketNumber || t.ticket || "";
  const title = t.title || "";
  const proj = project ? ` (${project})` : "";
  const head = `*${id}* ${title}`.trim();
  switch (event) {
    case "done": {
      let text = `✅ ${head} — Done${proj}`;
      if (t.completionSummary && String(t.completionSummary).trim()) {
        text += `\n> ${String(t.completionSummary).trim()}`;
      }
      return text;
    }
    case "review":
      return `👀 ${head} — ready for review${proj}`;
    default:
      return `📋 ${head} — ${event}${proj}`;
  }
}

/**
 * Post `text` to the project's Slack webhook.
 *
 * Reads the project's config. If Slack is not configured, or `event` is not in the
 * project's slackEvents allow-list, returns { sent:false, reason } without any network
 * call. Otherwise POSTs { text } as JSON with a 5s AbortController timeout. Any failure
 * — thrown fetch, non-2xx status, timeout — is caught and returned as
 * { sent:false, warning }; this function never throws. Success → { sent:true }.
 *
 * `fetchImpl` is injectable (defaults to globalThis.fetch) so tests can exercise the
 * success / HTTP-error / rejection paths without real network access.
 */
export async function notifySlack(board, project, { text, event = "summary", fetchImpl } = {}) {
  const cfg = getSlackConfig(board, project);
  if (!slackConfigured(cfg)) {
    return { sent: false, reason: "Slack is not configured for this project (set slackWebhook via set_project_config)" };
  }
  if (!allowedEvents(cfg).includes(event)) {
    return { sent: false, reason: `event "${event}" is not in slackEvents for this project` };
  }
  if (!text || !String(text).trim()) {
    return { sent: false, reason: "no text to post" };
  }

  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== "function") {
    return { sent: false, warning: "no fetch implementation available" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
  try {
    const res = await doFetch(cfg.slackWebhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: String(text) }),
      signal: controller.signal,
    });
    if (!res || !res.ok) {
      const status = res && res.status != null ? res.status : "unknown";
      return { sent: false, warning: `Slack webhook responded with HTTP ${status}` };
    }
    return { sent: true };
  } catch (err) {
    const msg = err && err.name === "AbortError" ? "timed out after 5s" : (err && err.message) || String(err);
    return { sent: false, warning: `Slack notification failed: ${msg}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Convenience: format a ticket event and post it. Wraps formatTicketEvent + notifySlack
 * so callers (e.g. set_status) can fire a single call. Never throws; returns the same
 * shape as notifySlack. `opts` forwards { fetchImpl } for testing.
 */
export async function notifyTicketEvent(board, project, event, task, opts = {}) {
  const text = formatTicketEvent(event, task, project);
  return notifySlack(board, project, { text, event, fetchImpl: opts.fetchImpl });
}
