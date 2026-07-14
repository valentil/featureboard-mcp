/**
 * FeatureBoard social share drafts (FBMCPF-42).
 *
 * The original OpenClaw app could push a gallery item live to X / LinkedIn. In the
 * MCP port there is no social connector, and DESIGN.md deliberately leaves live
 * publishing to a dedicated connector. So this is *draft-only*: Claude writes the
 * suggested copy (short for X, longer for LinkedIn) and these tools persist it as a
 * reviewable draft under <project>/shares.json. Nothing is ever posted — the user
 * (or a future connector) does the actual publish.
 *
 *   <project>/shares.json  { "seq": N, "shares": [ { id, asset, platform, text,
 *                            length, status:"draft", createdAt } ] }
 *
 * Pure helpers (validatePlatform, platformLimit, buildShare) are exported for tests.
 */

import fs from "node:fs";
import path from "node:path";

export const SHARES_FILE = "shares.json";

/** Per-platform character budgets used to sanity-check draft copy. */
export const PLATFORM_LIMITS = { x: 280, linkedin: 3000 };

/** Normalize a platform alias to a canonical key, or throw. */
export function validatePlatform(platform) {
  const p = String(platform || "").trim().toLowerCase();
  const alias = { x: "x", twitter: "x", tweet: "x", linkedin: "linkedin", li: "linkedin" };
  const key = alias[p];
  if (!key) throw new Error(`unknown platform "${platform}" (use "x" or "linkedin")`);
  return key;
}

/** Character budget for a platform. */
export function platformLimit(platform) {
  return PLATFORM_LIMITS[validatePlatform(platform)];
}

/** Build a share-draft record (pure). Enforces the platform length budget. */
export function buildShare(seq, { asset, platform, text }, now = new Date()) {
  const key = validatePlatform(platform);
  const body = String(text == null ? "" : text);
  if (!body.trim()) throw new Error("share text is required");
  const limit = PLATFORM_LIMITS[key];
  if (body.length > limit) {
    throw new Error(`${key} copy is ${body.length} chars; limit is ${limit}. Shorten it.`);
  }
  return {
    id: `s${seq}`,
    asset: asset ? String(asset) : null,
    platform: key,
    text: body,
    length: body.length,
    status: "draft",
    createdAt: now.toISOString(),
  };
}

function readFileSafe(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function atomicWrite(filePath, data) {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}

/** Read the raw shares store ({ seq, shares }) for a project. */
function readStore(board, project) {
  const raw = readFileSafe(path.join(board.projectDir(project), SHARES_FILE));
  if (!raw) return { seq: 0, shares: [] };
  try {
    const data = JSON.parse(raw);
    return { seq: data.seq || 0, shares: Array.isArray(data.shares) ? data.shares : [] };
  } catch {
    return { seq: 0, shares: [] };
  }
}

function writeStore(board, project, store) {
  atomicWrite(path.join(board.projectDir(project), SHARES_FILE), JSON.stringify(store, null, 2) + "\n");
}

/** Save a reviewable share draft (never posts). Returns the new draft. */
export function draftShare(board, project, { asset, platform, text } = {}, { now = new Date() } = {}) {
  const store = readStore(board, project);
  const seq = store.seq + 1;
  const share = buildShare(seq, { asset, platform, text }, now);
  store.shares.push(share);
  store.seq = seq;
  writeStore(board, project, store);
  return { project, share, count: store.shares.length };
}

/** List share drafts, newest-first, optionally filtered by asset and/or platform. */
export function listShares(board, project, { asset, platform } = {}) {
  const store = readStore(board, project);
  const key = platform ? validatePlatform(platform) : null;
  const shares = store.shares
    .filter((s) => (asset ? s.asset === asset : true))
    .filter((s) => (key ? s.platform === key : true))
    .slice()
    .reverse();
  return { project, count: shares.length, shares };
}

/** Remove a share draft by id. Throws if the id isn't present. */
export function removeShare(board, project, id) {
  const store = readStore(board, project);
  const next = store.shares.filter((s) => s.id !== id);
  if (next.length === store.shares.length) throw new Error(`share ${id} not found`);
  store.shares = next;
  writeStore(board, project, store);
  return { project, removed: id, count: next.length };
}
