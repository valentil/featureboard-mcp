/**
 * FeatureBoard AI-assisted packaging config (FBMCPF-85).
 *
 * The original OpenClaw app had a "packaging" step: ai-gen (have the agent draft the
 * distributable's name/description/keywords) plus packaging-config/save (persist it).
 * Ported AI-natively — Claude is the agent, so ai-gen is a *seed* the tool derives
 * from the project (products, brand, description) which Claude then refines and saves,
 * exactly like brainstorm/decompose. The saved metadata mirrors the .mcpb manifest
 * fields and is validated by the same rules the build preflight (build.mjs, FBMCPF-54)
 * applies, so packaging and preflight agree.
 *
 *   <project>/packaging.json
 *     { name, displayName, description, longDescription, keywords:[], version, updatedAt }
 *
 * validatePackaging is pure (metadata -> { ok, errors, warnings }) and is imported by
 * build.mjs so the preflight validates the manifest's packaging fields too.
 */

import fs from "node:fs";
import path from "node:path";
import { getProjectConfig } from "./metadata.js";

export const PACKAGING_FILE = "packaging.json";

export const DEFAULT_PACKAGING = {
  name: "",
  displayName: "",
  description: "",
  longDescription: "",
  keywords: [],
  version: "",
};

/** .mcpb-safe package name: lowercase, alphanumeric + dashes, no leading/trailing dash. */
export function slugifyName(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}
function atomicWrite(filePath, data) {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}
function configPath(board, project) {
  return path.join(board.projectDir(project), PACKAGING_FILE);
}

/** Read a project's packaging config (merged over defaults). */
export function getPackagingConfig(board, project) {
  const raw = readJsonSafe(configPath(board, project));
  const cfg = { ...DEFAULT_PACKAGING, ...(raw && typeof raw === "object" ? raw : {}) };
  cfg.keywords = Array.isArray(cfg.keywords) ? cfg.keywords : [];
  return cfg;
}

/** Normalize keywords: lowercase, trimmed, de-duplicated, no empties. */
export function normalizeKeywords(list) {
  const out = [];
  const seen = new Set();
  for (const k of Array.isArray(list) ? list : []) {
    const s = String(k).trim().toLowerCase();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/**
 * The "ai-gen" seed: derive a packaging draft from the project's config (name,
 * brand, description, products). Does NOT persist — Claude refines it, then calls
 * save_packaging_config. Pure w.r.t. the board's stored config.
 */
export function suggestPackaging(board, project) {
  const cfg = getProjectConfig(board, project) || {};
  const name = slugifyName(project) || "my-project";
  const displayName = cfg.brandTitle || project;
  const description =
    (cfg.description && String(cfg.description).trim()) ||
    (cfg.brandSubtitle && String(cfg.brandSubtitle).trim()) ||
    `${displayName} — packaged with FeatureBoard.`;
  const keywords = normalizeKeywords([
    ...(Array.isArray(cfg.products) ? cfg.products : []),
    ...String(cfg.brandWords || "").split(/[,\s]+/),
  ]);
  const draft = {
    name,
    displayName,
    description: description.slice(0, 240),
    longDescription: cfg.description ? String(cfg.description) : "",
    keywords,
    version: "0.1.0",
  };
  return { project, draft, note: "Draft only — refine, then persist with save_packaging_config.", validation: validatePackaging(draft) };
}

/**
 * Validate packaging metadata (pure). Hard errors block a build; warnings are
 * advisory (directory-submission polish). Shared by save_packaging_config and the
 * build.mjs preflight.
 */
export function validatePackaging(meta = {}) {
  const errors = [];
  const warnings = [];
  const name = String(meta.name || "").trim();
  if (!name) errors.push("name is required");
  else if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) errors.push(`name "${name}" must be lowercase alphanumeric with dashes (no leading/trailing dash)`);
  const description = String(meta.description || "").trim();
  if (!description) errors.push("description is required");
  else if (description.length < 10) errors.push("description is too short (min 10 chars)");
  else if (description.length > 300) warnings.push("description is long (>300 chars) — keep the short description concise");
  const keywords = Array.isArray(meta.keywords) ? meta.keywords : [];
  if (keywords.length === 0) warnings.push("no keywords — add a few so the directory can categorize the extension");
  else if (keywords.length > 15) warnings.push("more than 15 keywords — trim to the most relevant");
  if (!String(meta.displayName || "").trim()) warnings.push("no displayName — a human-friendly title helps in listings");
  if (!String(meta.longDescription || "").trim()) warnings.push("no longDescription — a fuller summary improves the listing");
  return { ok: errors.length === 0, errors, warnings };
}

/** Save/merge the packaging config (packaging-config/save). Validates hard errors. */
export function savePackagingConfig(board, project, patch = {}) {
  const cfg = getPackagingConfig(board, project);
  if (patch.name != null) cfg.name = slugifyName(patch.name);
  if (patch.displayName != null) cfg.displayName = String(patch.displayName).trim();
  if (patch.description != null) cfg.description = String(patch.description).trim();
  if (patch.longDescription != null) cfg.longDescription = String(patch.longDescription);
  if (patch.version != null) cfg.version = String(patch.version).trim();
  if (patch.keywords != null) {
    if (!Array.isArray(patch.keywords)) throw new Error("keywords must be an array of strings");
    cfg.keywords = normalizeKeywords(patch.keywords);
  }
  const validation = validatePackaging(cfg);
  if (!validation.ok) throw new Error(`packaging config invalid: ${validation.errors.join("; ")}`);
  cfg.updatedAt = new Date().toISOString();
  atomicWrite(configPath(board, project), JSON.stringify(cfg, null, 2) + "\n");
  return { project, config: cfg, validation };
}
