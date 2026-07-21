/**
 * FeatureBoard project standards (rigor profiles).
 *
 * A "standard" sets the level of detail a project's work is held to — how much
 * research happens before implementation, how much polish/testing rigor is
 * expected, and what extra items land in every packet's definition of done.
 * It is resolved once per project and then LOCKED: agents infer it from the
 * conversation at most once (set_standard with source:"inferred"), and after
 * that stop second-guessing — a locked standard only changes when the user
 * explicitly asks (set_standard with force:true).
 *
 * Resolution order: project config `standard` → account-wide `defaultStandard`
 * (set_global_config) → the built-in "standard" preset.
 *
 * No imports beyond node builtins — metadata.js, research.js, and git.js all
 * import this module, so it must sit at the bottom of the dependency graph.
 */

export const STANDARD_LEVELS = ["prototype", "standard", "polished"];

export const STANDARD_PRESETS = {
  prototype: {
    level: "prototype",
    summary: "Move fast, prove the idea. Working > polished; skip ceremony.",
    directives: [
      "Bias to the smallest change that demonstrates the behavior; obvious approach over researched approach.",
      "Tests only where breakage would be silent; skip broad coverage.",
      "No research phase by default; no polish passes (naming, docs, edge-case sweeps) unless asked.",
    ],
    definitionOfDoneExtras: [],
    research: { defaultOn: false, extraQuestions: [] },
  },
  standard: {
    level: "standard",
    summary: "Normal professional loop: tested, reviewed, documented where user-facing.",
    directives: [
      "Normal implementation loop with tests for core paths and edge cases that matter.",
      "Research the approach when the ticket is non-obvious; skip it for mechanical changes.",
      "Keep public APIs, data shapes, and existing tests stable unless the ticket says otherwise.",
    ],
    definitionOfDoneExtras: [],
    research: { defaultOn: null, extraQuestions: [] }, // null = leave researchOnIntake resolution alone
  },
  polished: {
    level: "polished",
    summary:
      "Highly polished engineering standard: research-first, competitor-aware, automation-everywhere, ship like it has users.",
    directives: [
      "Research BEFORE implementing: what competitors/comparable apps do, how they lay out this surface, and at least one idea worth borrowing or beating.",
      "Consult authoritative sources where they exist — white papers, vendor/engineering blogs, UX/UI heuristics (Nielsen, HIG/Material, WCAG) — and cite them in the research brief.",
      "Automate everywhere possible: if a step will be done twice, script it; prefer generated/derived artifacts over hand-maintained ones.",
      "High test rigor: adjacent code read, invariants protected, edge cases and failure modes covered, self-review of the diff before Done.",
      "Polish is in scope: naming, empty/loading/error states, accessibility, perf on the hot path, and user-facing docs.",
    ],
    definitionOfDoneExtras: [
      "Research brief consulted (or written) — competitor/layout/UX findings reflected in the implementation",
      "Automation opportunities captured: anything repeatable is scripted or ticketed",
      "Self-review pass done (diff read end-to-end; edge/error/empty states covered)",
    ],
    research: {
      defaultOn: true,
      extraQuestions: [
        "Competitor teardown: how do the 2-3 closest tools solve this exact feature, and what do their layouts/flows get right or wrong?",
        "Layout & IA: how do comparable apps structure this surface (navigation, hierarchy, defaults)? Which pattern fits here?",
        "Authoritative sources: any white papers, standards, or vendor engineering posts that settle the approach? Cite them.",
        "UX/UI heuristics: which guidelines (Nielsen heuristics, platform HIG, WCAG) constrain this design, and how?",
        "Automation: which parts of this feature — and of building it — can be automated, generated, or scripted instead of done by hand?",
      ],
    },
  },
};

/** Validate + normalize a stored/incoming standard object. Throws on bad level. */
export function normalizeStandard(input) {
  if (!input || typeof input !== "object") return null;
  const level = String(input.level || "").toLowerCase();
  if (!STANDARD_LEVELS.includes(level)) throw new Error(`Unknown standard level "${input.level}" — use one of: ${STANDARD_LEVELS.join(", ")}.`);
  const out = { level, locked: input.locked !== false };
  if (input.mandate && String(input.mandate).trim()) out.mandate = String(input.mandate).trim();
  out.source = ["user", "inferred", "default"].includes(input.source) ? input.source : "user";
  if (input.setAt) out.setAt = input.setAt;
  return out;
}

/**
 * Lock semantics, pure: apply `incoming` over `existing`.
 * A locked existing standard wins unless force — "once we lock, don't keep
 * trying to figure it out; set it once unless told to change".
 */
export function applyStandard(existing, incoming, { force = false, now = new Date() } = {}) {
  const next = normalizeStandard(incoming);
  if (!next) throw new Error("A standard needs at least a level (prototype | standard | polished).");
  const prev = (() => { try { return normalizeStandard(existing); } catch { return null; } })();
  if (prev && prev.locked && !force) {
    return {
      applied: false,
      standard: prev,
      reason:
        `Standard is locked at "${prev.level}" (source: ${prev.source}${prev.setAt ? `, set ${prev.setAt}` : ""}). ` +
        `Locked standards are settled — do not re-infer. Pass force:true only when the USER explicitly asks to change it.`,
    };
  }
  next.setAt = now.toISOString();
  return { applied: true, standard: next };
}

/** Resolve the effective standard: project → global default → built-in "standard". */
export function resolveStandard(projectStandard, globalDefault) {
  for (const [cand, source] of [[projectStandard, null], [globalDefault, "default"]]) {
    try {
      const n = normalizeStandard(cand);
      if (n) return source ? { ...n, source: "default", locked: false } : n;
    } catch { /* malformed stored value — fall through */ }
  }
  return { level: "standard", locked: false, source: "default" };
}

/**
 * The block injected into work packets (getWorkPacket) and surfaced by
 * set_standard: resolved level + preset directives + the project's own mandate.
 */
export function standardPacketBlock(std) {
  const preset = STANDARD_PRESETS[std.level] || STANDARD_PRESETS.standard;
  const block = {
    level: std.level,
    locked: !!std.locked,
    source: std.source || "default",
    summary: preset.summary,
    directives: [...preset.directives],
  };
  if (std.mandate) block.mandate = std.mandate;
  if (!std.locked) {
    block.note =
      "Standard not locked yet — if the conversation has made the expected rigor clear, call set_standard ONCE " +
      "(source:\"inferred\") to lock it, then stop revisiting.";
  }
  return block;
}

/** Extra definition-of-done items the level demands (empty for lighter levels). */
export function definitionOfDoneExtras(std) {
  const preset = STANDARD_PRESETS[std.level];
  return preset ? [...preset.definitionOfDoneExtras] : [];
}

/** How the level bends the research phase: {defaultOn, extraQuestions}. */
export function researchProfile(std) {
  const preset = STANDARD_PRESETS[std.level] || STANDARD_PRESETS.standard;
  return { defaultOn: preset.research.defaultOn, extraQuestions: [...preset.research.extraQuestions] };
}
