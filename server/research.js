/**
 * FeatureBoard v0.6 research-on-intake (FBMCPF-263).
 *
 * When a feature is requested, an optional (DEFAULT ON) research phase runs
 * before implementation: cheap sub-agents (haiku/sonnet) pull "how do we build
 * this / what's the prior art / what do competitors do / what are the risks",
 * collate it into a short markdown brief, and hand that brief up to the
 * expensive implementing model so it starts with context instead of a cold read.
 *
 * This module is deterministic and makes NO model calls. `prepareResearch`
 * assembles a research REQUEST packet — the questions to answer, the local
 * sources to start from (KB docs, docs/ paths, prior art from the lexical RAG,
 * FBMCPF-264), and where to save the result. The orchestrator dispatches that
 * packet to a sub-agent, then saves the returned brief with add_kb_doc under the
 * research-<ticket> convention so getWorkPacket auto-attaches it downstream.
 *
 * No import cycle: metadata.js does NOT import this module (getWorkPacket only
 * needs kb.js to read the saved brief), so this module may freely import
 * getProjectConfig from metadata.js and ragSearch from rag.js.
 */

import { getProjectConfig, DISPATCH_EFFORT_RE } from "./metadata.js";
import { resolveStandard, researchProfile } from "./standards.js";
import { ragSearch } from "./rag.js";
import { searchKb, slugify, appendKbDoc } from "./kb.js";

/** The kb slug a ticket's research brief lives under: research-<ticket-lowercased>. */
export function researchSlug(ticket) {
  return slugify(`research ${ticket}`);
}

/**
 * Append one research finding to a ticket's durable research doc (FBMCPF-333).
 * Writes to the SAME kb slug getWorkPacket auto-attaches (research-<ticket>),
 * creating it on first call and appending on later ones — so findings accrue
 * incrementally in the always-indexed kb/, not the ephemeral scratchpad. The
 * finding is stored verbatim as its own paragraph.
 */
export function appendResearch(board, project, ticket, finding) {
  const task = board.getTask(project, ticket);
  if (!task) throw new Error(`Ticket ${ticket} not found in "${project}".`);
  const text = String(finding == null ? "" : finding).trim();
  if (!text) throw new Error("A finding is required.");
  const res = appendKbDoc(board, project, `research/${task.ticketNumber}`, text);
  return {
    ticket: task.ticketNumber,
    slug: researchSlug(task.ticketNumber),
    created: res.created,
    appended: res.appended,
    bytes: res.bytes,
  };
}

/** Effort from a ticket's effort:<low|medium|high> label, or null. */
function effortOf(task) {
  for (const l of (task && task.labels) || []) {
    const m = String(l).match(DISPATCH_EFFORT_RE);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

function hasLabel(task, label) {
  return ((task && task.labels) || []).some((l) => String(l).toLowerCase() === label);
}

/**
 * Resolve whether the research phase should run for a ticket. Default is ON when
 * config.researchOnIntake is absent (resolved here, NOT force-written). A
 * `research:off` label always skips; a `research:on` label always forces.
 * Returns { enabled, source: "label"|"config"|"default", reason }.
 */
export function resolveResearchOnIntake(board, project, task) {
  if (hasLabel(task, "research:off")) {
    return { enabled: false, source: "label", reason: "research:off label on the ticket skips the research phase." };
  }
  if (hasLabel(task, "research:on")) {
    return { enabled: true, source: "label", reason: "research:on label on the ticket forces the research phase." };
  }
  let cfg = {};
  try { cfg = getProjectConfig(board, project) || {}; } catch { cfg = {}; }
  if (cfg.researchOnIntake === false) {
    return { enabled: false, source: "config", reason: "researchOnIntake is disabled for this project." };
  }
  if (cfg.researchOnIntake === true) {
    return { enabled: true, source: "config", reason: "researchOnIntake is enabled for this project." };
  }
  return { enabled: true, source: "default", reason: "researchOnIntake defaults ON when unset." };
}

/** haiku for effort low/medium, else sonnet (higher-effort research warrants a stronger cheap model). */
function suggestResearchModel(task) {
  const e = effortOf(task);
  return e === "low" || e === "medium" ? "haiku" : "sonnet";
}

/**
 * Build a deterministic research REQUEST packet for one ticket. When the
 * research phase resolves OFF, returns { skip: true, reason } and nothing else
 * heavy. Otherwise returns the questions to answer, the local sources to seed
 * from (KB matches, docs/ paths, code hints, prior art from the lexical RAG),
 * the deliverable spec, the save instruction, and a suggested cheap model.
 */
export function prepareResearch(board, project, ticket, opts = {}) {
  const task = board.getTask(project, ticket);
  if (!task) throw new Error(`Ticket ${ticket} not found in "${project}".`);

  let resolved = resolveResearchOnIntake(board, project, task);
  // Project standard bends the default: "polished" forces research on (labels
  // still win); "prototype" skips it unless a research:on label forces it.
  const cfgStd = (() => { try { return getProjectConfig(board, project); } catch { return {}; } })();
  const std = resolveStandard(cfgStd.standard);
  const profile = researchProfile(std);
  if (resolved.source === "default" && profile.defaultOn === true && !resolved.enabled) {
    resolved = { enabled: true, source: "standard", reason: `project standard "${std.level}" runs research-first.` };
  }
  if (resolved.source === "default" && profile.defaultOn === false) {
    return { ticket: task.ticketNumber, title: task.title, skip: true, reason: `project standard "${std.level}" skips the research phase by default (add a research:on label to force it).` };
  }
  if (!resolved.enabled) {
    return { ticket: task.ticketNumber, title: task.title, skip: true, reason: resolved.reason };
  }

  // Prior art from the local lexical RAG (FBMCPF-264) — cheap researchers start
  // from hits, not zero. Query = title + description; exclude the ticket's own
  // research brief so we never seed a brief with itself.
  const query = [task.title, task.description].filter(Boolean).join(" ");
  let priorArt = [];
  try {
    priorArt = ragSearch(board, project, query, { k: 3, exclude: [researchSlug(task.ticketNumber)] });
  } catch { priorArt = []; }

  // KB docs matching by keyword (title/slug + short excerpt).
  let kb = [];
  try {
    kb = searchKb(board, project, query, { limit: 5 }).map((h) => ({ slug: h.slug, title: h.title, excerpt: h.excerpt }));
  } catch { kb = []; }

  // docs/ paths surfaced by the RAG prior-art hits (a starting reading list).
  const docs = [...new Set(priorArt.map((h) => h.source).filter((s) => /^docs\//i.test(s) || /^readme\.md$/i.test(s)))];

  // web egress is on by default (comparables/competitors need it); a
  // research:local label opts out for air-gapped / offline runs.
  const web = !hasLabel(task, "research:local");

  const questions = [
    "How to execute: the 1-3 most plausible implementation approaches, each with its key tradeoff (complexity, blast radius, back-compat).",
    "Prior art IN THIS REPO: which existing files, modules, or Done tickets already touched similar ground? (Start from the priorArt hits below and rag_search for more.)",
    "Comparables / competitors: how do other tools solve this, and what's the one idea worth borrowing?",
    "Risks & invariants: what must NOT break — data shapes, public APIs, existing tests, performance envelopes?",
    ...profile.extraQuestions,
  ];

  return {
    ticket: task.ticketNumber,
    title: task.title,
    description: task.description || "",
    skip: false,
    researchOn: resolved,
    questions,
    sources: {
      kb,
      docs,
      code: { ref: task.ref || null, product: task.product || null, newFile: task.newFile || null },
      priorArt, // rag_search top-3 [{ score, source, heading, text }]
      web,
    },
    deliverable: "A collated markdown brief ≤ ~150 lines: recommended approach + runners-up, prior-art pointers (file/ticket refs), one competitor idea, and a short risks/invariants checklist. Capture findings AS YOU GO with append_research(project, ticket, finding) — one call per finding as you discover it — so nothing gets stranded in the scratchpad; the final brief just consolidates what you already captured. And keep the SOURCES: every paper/page you actually rely on, capture with add_source(project, ticket, url=<link>) (or path=<file>) as you read it — the raw text is fetched + indexed automatically, so the material is preserved, not just your notes about it.",
    saveInstruction:
      `Capture findings INCREMENTALLY as you research: append_research(project, ticket="${task.ticketNumber}", finding=<one finding>) appends to kb slug ` +
      `"${researchSlug(task.ticketNumber)}" (creating it on the first call), so knowledge lands in the always-indexed kb/ immediately instead of the ephemeral scratchpad. ` +
      `At the end the orchestrator consolidates into the same doc via add_kb_doc(project, title="research/${task.ticketNumber}", content=<brief>); getWorkPacket then auto-attaches it as researchBrief. ` +
      `Also capture each SOURCE you rely on as you read it: add_source(project, url="<link>", ticket="${task.ticketNumber}") fetches + extracts the raw text into the sources/ library (RAG-indexed) automatically — findings go to append_research, the raw material goes to add_source. ` +
      `Sub-agents NEVER write the board or KB themselves — they hand findings + source links back to the orchestrator, which calls append_research / add_kb_doc / add_source.`,
    suggestedModel: suggestResearchModel(task),
  };
}
