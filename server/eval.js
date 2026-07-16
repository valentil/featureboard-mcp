// Eval harness (FBMCPF-128): compare "board" vs "chat" workflows on matched
// trials, using nothing but label conventions on top of the existing board.
//
// Conventions (set via labels on features/bugs, e.g. from add_feature or
// update_task):
//   experiment:board   — this ticket was worked through the FeatureBoard flow
//   experiment:chat     — this ticket was worked as a plain chat/no-board flow
//   pair:<id>           — ties a board trial and a chat trial together so they
//                         can be compared head-to-head (same task, two arms)
//
// Everything here is derived from readWorkLog (server/metadata.js) and
// board.listTasks/getTask (server/storage.js) — no new persistence, no writes.

import { readWorkLog } from "./metadata.js";

export const ARM_RE = /^experiment:(board|chat)$/i;
export const PAIR_RE = /^pair:(.+)$/i;

/** Experiment arm ("board" | "chat") carried by a task's labels, or null. */
export function armOfTask(t) {
  for (const l of (t && t.labels) || []) {
    const m = String(l).match(ARM_RE);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

/** Pair id carried by a task's labels, or null. */
export function pairOfTask(t) {
  for (const l of (t && t.labels) || []) {
    const m = String(l).match(PAIR_RE);
    if (m) return m[1].trim();
  }
  return null;
}

function daysBetween(a, b) {
  const da = Date.parse(a);
  const db = Date.parse(b);
  if (isNaN(da) || isNaN(db)) return null;
  return Math.round((db - da) / 86400000);
}

function median(nums) {
  const xs = nums.filter((n) => n != null && !isNaN(n)).slice().sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

function fmtTokens(n) {
  if (n == null) return "n/a";
  if (n >= 1000) return `${Math.round(n / 100) / 10}k`;
  return String(n);
}

/**
 * Full eval report for a project: every ticket carrying an experiment arm,
 * grouped and summarized per arm, plus head-to-head pairs.
 */
export function evalReport(board, project) {
  const tasks = board.listTasks(project, {});
  const log = readWorkLog(board, project);
  const tokensByTicket = new Map();
  for (const e of log) {
    if (!e.ticket) continue;
    tokensByTicket.set(e.ticket, (tokensByTicket.get(e.ticket) || 0) + (e.tokens || 0));
  }

  const bugs = tasks.filter((t) => t.type === "bug");

  const trials = [];
  for (const t of tasks) {
    const arm = armOfTask(t);
    if (!arm) continue;
    const pair = pairOfTask(t);
    const wallDays = t.status === "Done" && t.createdDate && t.completionDate
      ? daysBetween(t.createdDate, t.completionDate)
      : null;

    let rework = 0;
    if (t.status === "Done" && t.completionDate) {
      const completedMs = Date.parse(t.completionDate);
      if (!isNaN(completedMs)) {
        const windowEnd = completedMs + 7 * 86400000;
        rework = bugs.filter((b) => {
          if (b.linkedIssue !== t.ticketNumber) return false;
          const createdMs = Date.parse(b.createdDate);
          if (isNaN(createdMs)) return false;
          return createdMs >= completedMs && createdMs <= windowEnd;
        }).length;
      }
    }

    trials.push({
      ticket: t.ticketNumber,
      title: t.title,
      arm,
      pair,
      status: t.status,
      tokens: tokensByTicket.get(t.ticketNumber) || 0,
      wallDays,
      rework,
    });
  }

  // additions/deletions come from the work log too (summed, like tokens)
  const addByTicket = new Map();
  const delByTicket = new Map();
  for (const e of log) {
    if (!e.ticket) continue;
    addByTicket.set(e.ticket, (addByTicket.get(e.ticket) || 0) + (e.additions || 0));
    delByTicket.set(e.ticket, (delByTicket.get(e.ticket) || 0) + (e.deletions || 0));
  }
  for (const tr of trials) {
    tr.additions = addByTicket.get(tr.ticket) || 0;
    tr.deletions = delByTicket.get(tr.ticket) || 0;
  }

  // byArm
  const byArm = {};
  for (const arm of ["board", "chat"]) {
    const armTrials = trials.filter((tr) => tr.arm === arm);
    const doneTrials = armTrials.filter((tr) => tr.status === "Done");
    byArm[arm] = {
      trials: armTrials.length,
      done: doneTrials.length,
      medianTokens: doneTrials.length ? median(doneTrials.map((tr) => tr.tokens)) : null,
      medianWallDays: doneTrials.length ? median(doneTrials.map((tr) => tr.wallDays)) : null,
      totalAdditions: armTrials.reduce((s, tr) => s + (tr.additions || 0), 0),
      totalDeletions: armTrials.reduce((s, tr) => s + (tr.deletions || 0), 0),
      reworkTotal: armTrials.reduce((s, tr) => s + (tr.rework || 0), 0),
    };
  }

  // pairs — present on BOTH arms
  const byPairArm = new Map(); // pairId -> { board?: trial, chat?: trial }
  for (const tr of trials) {
    if (!tr.pair) continue;
    const entry = byPairArm.get(tr.pair) || {};
    entry[tr.arm] = tr;
    byPairArm.set(tr.pair, entry);
  }
  const pairs = [];
  for (const [pair, entry] of byPairArm) {
    if (!entry.board || !entry.chat) continue;
    const mk = (tr) => ({ ticket: tr.ticket, tokens: tr.tokens, wallDays: tr.wallDays, rework: tr.rework });
    const boardSide = mk(entry.board);
    const chatSide = mk(entry.chat);
    const tokenRatio = boardSide.tokens && chatSide.tokens ? chatSide.tokens / boardSide.tokens : null;
    pairs.push({ pair, board: boardSide, chat: chatSide, tokenRatio });
  }
  pairs.sort((a, b) => a.pair.localeCompare(b.pair));

  // summary
  let summary;
  if (!pairs.length) {
    if (!trials.length) {
      summary = "No experiment trials found (label tickets experiment:board / experiment:chat to start comparing).";
    } else {
      summary = `${trials.length} trial${trials.length === 1 ? "" : "s"} recorded (board ${byArm.board.trials}, chat ${byArm.chat.trials}) — no paired trials yet (add pair:<id> labels to compare head-to-head).`;
    }
  } else {
    const boardTokens = pairs.map((p) => p.board.tokens).filter((n) => n != null);
    const chatTokens = pairs.map((p) => p.chat.tokens).filter((n) => n != null);
    const medB = median(boardTokens);
    const medC = median(chatTokens);
    const reworkB = pairs.reduce((s, p) => s + (p.board.rework || 0), 0);
    const reworkC = pairs.reduce((s, p) => s + (p.chat.rework || 0), 0);
    let ratioTxt = "";
    if (medB != null && medC != null && medB > 0) {
      ratioTxt = ` (${Math.round((medC / medB) * 10) / 10}x)`;
    }
    const tokensTxt = medB != null && medC != null
      ? `board median ${fmtTokens(medB)} tokens vs chat ${fmtTokens(medC)}${ratioTxt}`
      : "token data incomplete";
    summary = `${pairs.length} paired trial${pairs.length === 1 ? "" : "s"}: ${tokensTxt}, rework ${reworkB} vs ${reworkC}`;
  }

  return { trials, byArm, pairs, summary };
}
