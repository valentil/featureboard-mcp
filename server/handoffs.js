/**
 * FeatureBoard v0.3 pipeline handoffs (FBMCPF-144).
 *
 * When ticket A completes, its output should feed every ticket that is
 * blockedBy A (FBMCPF-133). A handoff is a free-form markdown note an agent
 * writes at close-out, stored per ticket at:
 *
 *   <projectDir>/handoffs/<TICKET>.md
 *
 * There is no fixed section layout here (unlike requirements.js) — the note
 * is whatever the closing agent wants the successor(s) to know: what was
 * built, where, gotchas, follow-ups.
 *
 * IMPORTANT (no import cycle): this module imports ONLY node builtins. It
 * never imports metadata.js — the Board and its projectDir are passed in
 * through arguments, so metadata.js may safely import THIS module for
 * work-packet injection without creating a require/import cycle.
 */

import fs from "node:fs";
import path from "node:path";

function readFileSafe(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}
function atomicWrite(p, content) {
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, p);
}
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** Directory that holds a project's handoff note files. */
function handoffsDir(board, project) {
  return path.join(board.projectDir(project), "handoffs");
}
/** Absolute path to one ticket's handoff note file. */
function handoffPath(board, project, ticket) {
  return path.join(handoffsDir(board, project), `${ticket}.md`);
}

/**
 * Write (or overwrite) a ticket's handoff note. Validates the ticket exists
 * first (board.getTask returns null for an unknown ticket → we throw), then
 * atomically writes the note as-is. Returns a compact summary.
 */
export function writeHandoff(board, project, ticket, note) {
  const task = board.getTask(project, ticket);
  if (!task) throw new Error(`Ticket ${ticket} not found in "${project}".`);

  const content = String(note || "");
  ensureDir(handoffsDir(board, project));
  const p = handoffPath(board, project, ticket);
  atomicWrite(p, content);

  return { ticket: task.ticketNumber, path: p, bytes: Buffer.byteLength(content, "utf8") };
}

/** Read a ticket's handoff note, or null when none has been written. */
export function readHandoff(board, project, ticket) {
  return readFileSafe(handoffPath(board, project, ticket));
}

/**
 * For `ticket`, walk its blockedBy list (FBMCPF-133) and collect what each
 * predecessor is handing off. A predecessor is included only when it is Done
 * OR has a handoff note (an in-progress ticket with no note yet has nothing
 * useful to report). Dangling blockedBy refs (predecessor no longer on the
 * board) are tolerated and simply skipped. Returns [] when the ticket has no
 * (qualifying) dependencies, including when the ticket itself is unknown.
 */
export function handoffsFor(board, project, ticket) {
  const task = board.getTask(project, ticket);
  const blockedBy = (task && task.blockedBy) || [];

  const out = [];
  for (const id of blockedBy) {
    const pred = board.getTask(project, id);
    if (!pred) continue; // dangling ref tolerated

    const handoff = readHandoff(board, project, pred.ticketNumber);
    const qualifies = pred.status === "Done" || handoff != null;
    if (!qualifies) continue;

    out.push({
      ticket: pred.ticketNumber,
      status: pred.status,
      completionSummary: pred.completionSummary,
      handoff,
    });
  }
  return out;
}
