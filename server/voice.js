/**
 * FBMCPF-267: voice_lint — a self-editing AI-writing-tell scorer.
 *
 * Reads the research-backed rules catalog out of docs/VOICE-RESEARCH.md (its
 * fenced ```json "Machine-readable ruleset" block, FBMCPF-266) and applies it
 * to a piece of text: regex "tell" rules (overused lexical items, contrastive-
 * pivot rhetoric, sycophantic openers, etc.) plus four metric rules
 * (burstiness, tricolon-density, emdash-density, bold-colon-density).
 *
 * IMPORTANT (no import cycle): mirrors rules.js — this module imports
 * getProjectConfig from metadata.js so a per-project "voiceProfile" config key
 * (extraBannedPhrases / allowedTells / samplesNote) can be read the same way
 * rules.js reads "rules" and slack.js reads "slackWebhook". metadata.js does
 * NOT import this module, so no cycle risk.
 *
 * Scope note (see docs/VOICE-RESEARCH.md "Limitations"): this is an editing
 * aid for your OWN outbound drafts, not a detector for judging whether text
 * someone else wrote is AI-authored.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getProjectConfig } from "./metadata.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DOC_PATH = path.join(HERE, "..", "docs", "VOICE-RESEARCH.md");
const DEFAULT_THRESHOLD = 30;

/**
 * Small embedded fallback ruleset (8-10 highest-signal rules) used when
 * docs/VOICE-RESEARCH.md is missing or its fenced JSON block fails to parse,
 * so voice_lint never breaks even if the research doc gets moved/edited.
 * Same shape as the doc's machine-readable ruleset.
 */
export const FALLBACK_RULESET = [
  { id: "lex.delve", name: "\"delve\" overuse", severity: 3, kind: "regex", pattern: "/\\bdelv(e|es|ed|ing)\\b/i", suggestion: "Replace with \"look into\", \"explore\", or \"dig into\"; often can be cut entirely." },
  { id: "lex.tapestry", name: "\"tapestry\" metaphor", severity: 3, kind: "regex", pattern: "/\\btapestr(y|ies)\\b/i", suggestion: "Cut the metaphor; describe the actual mixture of elements concretely." },
  { id: "lex.underscore", name: "\"underscore(s)\" as verb", severity: 2, kind: "regex", pattern: "/\\bunderscores?\\b(?!\\s*character)/i", suggestion: "Use \"highlights\", \"shows\", or \"points to\"." },
  { id: "lex.leverage", name: "\"leverage\" as verb", severity: 2, kind: "regex", pattern: "/\\bleverag(e|es|ed|ing)\\b/i", suggestion: "Replace with \"use\"." },
  { id: "lex.utilize", name: "\"utilize\"", severity: 2, kind: "regex", pattern: "/\\butiliz(e|es|ed|ing|ation)\\b/i", suggestion: "Replace with \"use\"." },
  { id: "struct.not-but", name: "\"not X, but Y\" contrastive pivot", severity: 3, kind: "regex", pattern: "/\\b(it'?s|this is|that'?s|there'?s)?\\s*not\\s+(just|only|merely|simply)?\\s*[^,.;:]{1,60},?\\s+but\\b/i", suggestion: "Cut the setup; state the point directly without the negation-then-correction move." },
  { id: "struct.isnt-its", name: "\"isn't X, it's Y\" contrastive pivot", severity: 3, kind: "regex", pattern: "/\\bisn'?t\\s+[^,.;:]{1,50},?\\s+it'?s\\b/i", suggestion: "Collapse to a single direct statement." },
  { id: "struct.sycophant-opener", name: "Sycophantic opener", severity: 2, kind: "regex", pattern: "/^\\s*(great|excellent|fantastic|good|wonderful)\\s+(question|point|observation|catch)!?/im", suggestion: "Cut the opener; start with the actual answer." },
  { id: "rhythm.uniform", name: "Low sentence-length variance (burstiness)", severity: 2, kind: "metric", metric: "burstiness", threshold: 4, suggestion: "Mix short, punchy sentences with longer ones; break up uniform rhythm." },
  { id: "struct.tricolon", name: "Rule-of-three / tricolon density", severity: 2, kind: "metric", metric: "tricolon-density", threshold: 2, suggestion: "Vary the count — use two items, four, or restructure as a list instead of a repeated triplet." },
];

const RULESET_CACHE = new Map();

/**
 * Parse the fenced ```json "Machine-readable ruleset" block out of
 * docs/VOICE-RESEARCH.md and cache it (keyed by resolved path so tests can
 * inject an alternate/broken path without clobbering the real cache entry).
 * Falls back to FALLBACK_RULESET (source: "fallback") when the doc is
 * missing, unreadable, or its fenced block doesn't parse to a non-empty
 * array — this function never throws.
 */
export function loadRuleset({ docPath } = {}) {
  const resolvedPath = docPath || DEFAULT_DOC_PATH;
  if (RULESET_CACHE.has(resolvedPath)) return RULESET_CACHE.get(resolvedPath);

  let result;
  try {
    const raw = fs.readFileSync(resolvedPath, "utf8");
    const m = raw.match(/```json\s*\n([\s\S]*?)```/);
    if (!m) throw new Error("no fenced json block found in " + resolvedPath);
    const parsed = JSON.parse(m[1]);
    if (!Array.isArray(parsed) || !parsed.length) throw new Error("ruleset is not a non-empty array");
    result = { rules: parsed, source: "doc", path: resolvedPath };
  } catch {
    result = { rules: FALLBACK_RULESET, source: "fallback", path: resolvedPath };
  }
  RULESET_CACHE.set(resolvedPath, result);
  return result;
}

/**
 * A project's configured voice profile (per FBMCPF-267): extraBannedPhrases
 * (project-specific phrases to flag beyond the base ruleset), allowedTells
 * (rule ids to skip — e.g. a team that genuinely likes em-dashes), and
 * samplesNote (free-text reminder surfaced back on the lint result). Mirrors
 * rules.js's getRules(): tolerant of a missing/malformed config, never throws.
 */
export function getVoiceProfile(board, project) {
  let cfg = {};
  try {
    cfg = getProjectConfig(board, project) || {};
  } catch {
    cfg = {};
  }
  const vp = (cfg && typeof cfg.voiceProfile === "object" && cfg.voiceProfile) || {};
  return {
    extraBannedPhrases: Array.isArray(vp.extraBannedPhrases) ? vp.extraBannedPhrases.map(String).filter(Boolean) : [],
    allowedTells: Array.isArray(vp.allowedTells) ? vp.allowedTells.map(String).filter(Boolean) : [],
    samplesNote: vp.samplesNote ? String(vp.samplesNote) : "",
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function slug(s) {
  return String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "phrase";
}

/**
 * A doc `pattern` field is a full JS regex literal string including
 * delimiters and flags (e.g. "/\\bdelve\\b/i"). Per FBMCPF-267 spec, the
 * linter always constructs the RegExp with fresh "gim" flags (global so every
 * occurrence is collected, case-insensitive, multiline so ^/$ anchors match
 * per line — openers/closers must fire on any line of a multi-line draft)
 * rather than trusting whatever flags the literal carried — simpler and
 * deterministic across the whole ruleset. Returns null (rule skipped) if the
 * pattern can't be parsed.
 */
function toRegex(patternStr) {
  const s = String(patternStr || "");
  if (s.startsWith("/")) {
    const lastSlash = s.lastIndexOf("/");
    if (lastSlash > 0) {
      const body = s.slice(1, lastSlash);
      try { return new RegExp(body, "gim"); } catch { return null; }
    }
  }
  try { return new RegExp(s, "gim"); } catch { return null; }
}

/** ±40-char excerpt around a match, whitespace-collapsed, ellipsis-marked. */
function excerptAround(src, idx, len) {
  const start = Math.max(0, idx - 40);
  const end = Math.min(src.length, idx + len + 40);
  let excerpt = src.slice(start, end).replace(/\s+/g, " ").trim();
  if (start > 0) excerpt = "…" + excerpt;
  if (end < src.length) excerpt = excerpt + "…";
  return excerpt;
}

function wordsOf(src) {
  const t = String(src || "").trim();
  return t ? t.split(/\s+/).filter(Boolean) : [];
}

function splitSentences(src) {
  const t = String(src || "").trim();
  if (!t) return [];
  return t.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
}

function stdev(nums) {
  if (!nums.length) return 0;
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  const variance = nums.reduce((a, b) => a + (b - mean) ** 2, 0) / nums.length;
  return Math.sqrt(variance);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// "X, Y, and Z" style tricolon: three short parallel items joined by an
// optional-Oxford comma "and". Deliberately approximate (see
// docs/VOICE-RESEARCH.md struct.tricolon note) — a heuristic, not a parser.
const TRICOLON_RE = /\b[a-z][\w'-]*(?:\s+[a-z][\w'-]*){0,2},\s*[a-z][\w'-]*(?:\s+[a-z][\w'-]*){0,2},?\s+and\s+[a-z][\w'-]*(?:\s+[a-z][\w'-]*){0,2}\b/gi;

function findRegexFindings(rule, src, findings) {
  const re = toRegex(rule.pattern);
  if (!re) return;
  let m;
  while ((m = re.exec(src))) {
    findings.push({
      id: rule.id,
      name: rule.name,
      severity: rule.severity,
      excerpt: excerptAround(src, m.index, m[0].length),
      suggestion: rule.suggestion,
    });
    if (m[0].length === 0) re.lastIndex += 1; // guard against zero-width infinite loop
  }
}

function findMetricFinding(rule, src, wordCount, findings) {
  if (rule.metric === "burstiness") {
    const sentences = splitSentences(src);
    if (sentences.length < 5) return; // needs 5+ sentences per FBMCPF-267 spec
    const counts = sentences.map((s) => wordsOf(s).length);
    const sd = stdev(counts);
    if (sd < rule.threshold) {
      findings.push({ id: rule.id, name: rule.name, severity: rule.severity, metricValue: round2(sd), suggestion: rule.suggestion });
    }
  } else if (rule.metric === "tricolon-density") {
    if (!wordCount) return;
    const matches = src.match(TRICOLON_RE) || [];
    const density = matches.length / (wordCount / 300);
    if (density > rule.threshold) {
      findings.push({ id: rule.id, name: rule.name, severity: rule.severity, metricValue: round2(density), suggestion: rule.suggestion });
    }
  } else if (rule.metric === "emdash-density") {
    if (!wordCount) return;
    const matches = src.match(/—|--/g) || [];
    const density = matches.length / (wordCount / 500);
    if (density > rule.threshold) {
      findings.push({ id: rule.id, name: rule.name, severity: rule.severity, metricValue: round2(density), suggestion: rule.suggestion });
    }
  } else if (rule.metric === "bold-colon-density") {
    const lines = String(src || "").split(/\r?\n/);
    const bulletLines = lines.filter((l) => /^\s*[-*]\s+/.test(l));
    if (!bulletLines.length) return; // metric only meaningful within an actual list
    const boldLines = bulletLines.filter((l) => /^\s*[-*]\s*\*\*[^*]+\*\*:?/.test(l));
    const fraction = boldLines.length / bulletLines.length;
    if (fraction > rule.threshold) {
      findings.push({ id: rule.id, name: rule.name, severity: rule.severity, metricValue: round2(fraction), suggestion: rule.suggestion });
    }
  }
  // unknown metric name: skip silently (forward-compatible with future doc edits)
}

const SEVERITY_WEIGHT = { 1: 4, 2: 8, 3: 14 };

function summarize(aiScore, threshold, findingCount) {
  if (findingCount === 0) return "Clean — no AI writing tells detected.";
  if (aiScore < threshold) return `Mostly clean — ${findingCount} minor tell(s) found, below the flag threshold.`;
  if (aiScore < 60) return `Noticeably AI-flavored — ${findingCount} tell(s) found; consider revising before sending.`;
  return `Strongly AI-flavored — ${findingCount} tell(s) found across multiple rule categories; a substantial rewrite is recommended.`;
}

/**
 * Score `text` for AI-writing tells against the FBMCPF-266/267 ruleset.
 *
 * opts:
 *   - extraBannedPhrases: string[] — project-specific phrases to flag (from
 *     voiceProfile), in addition to the base ruleset.
 *   - allowedTells: string[] — rule ids to skip entirely (from voiceProfile).
 *   - threshold: number — aiScore cutoff used only to word the summary
 *     verdict (default 30); does not change which findings fire.
 *   - samplesNote: string — passed straight through onto the result as
 *     `profileNote` when non-empty (voiceProfile.samplesNote).
 *   - docPath: string — override for docs/VOICE-RESEARCH.md's location
 *     (tests inject a bad path to exercise the fallback ruleset).
 *
 * Returns { aiScore (0-100, 0 = clean), wordCount, findings, summary,
 * rulesApplied, rulesSource, profileNote? }. Never throws: a malformed rule
 * or an unreadable ruleset doc degrades to fewer findings / the fallback
 * ruleset, not an error.
 */
export function lintVoice(text, opts = {}) {
  const {
    extraBannedPhrases = [],
    allowedTells = [],
    threshold = DEFAULT_THRESHOLD,
    samplesNote = "",
    docPath,
  } = opts || {};

  const src = String(text == null ? "" : text);
  const words = wordsOf(src);
  const wordCount = words.length;

  const { rules, source } = loadRuleset({ docPath });
  const skip = new Set((allowedTells || []).map(String));

  const findings = [];
  let appliedCount = 0;

  for (const rule of rules) {
    if (!rule || !rule.id || skip.has(rule.id)) continue;
    appliedCount += 1;
    try {
      if (rule.kind === "regex") {
        findRegexFindings(rule, src, findings);
      } else if (rule.kind === "metric") {
        findMetricFinding(rule, src, wordCount, findings);
      }
    } catch {
      // one rule's failure must never break the whole lint pass
    }
  }

  for (const phrase of extraBannedPhrases || []) {
    const p = String(phrase || "").trim();
    if (!p) continue;
    const id = `custom.banned.${slug(p)}`;
    if (skip.has(id)) continue;
    appliedCount += 1;
    const re = new RegExp(escapeRegExp(p), "gi");
    let m;
    while ((m = re.exec(src))) {
      findings.push({
        id,
        name: `Banned phrase: "${p}"`,
        severity: 2,
        excerpt: excerptAround(src, m.index, m[0].length),
        suggestion: `This project's voice profile flags "${p}" — reword or cut it.`,
      });
      if (m[0].length === 0) re.lastIndex += 1;
    }
  }

  const rawScore = findings.reduce((sum, f) => sum + (SEVERITY_WEIGHT[f.severity] || 6), 0);
  const perHundredWords = wordCount > 0 ? (rawScore / wordCount) * 100 : (rawScore > 0 ? 100 : 0);
  const aiScore = Math.max(0, Math.min(100, Math.round(perHundredWords)));

  const result = {
    aiScore,
    wordCount,
    findings,
    summary: summarize(aiScore, threshold, findings.length),
    rulesApplied: appliedCount,
    rulesSource: source,
  };
  const note = String(samplesNote || "").trim();
  if (note) result.profileNote = note;
  return result;
}
