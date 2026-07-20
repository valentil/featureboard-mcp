import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  setSite, getSite, addPage, listPages, siteRoot,
  SITE_DIR, SITE_HTML, SITE_CONFIG,
} from "../server/website.js";
import { setProjectConfig, resolveGitTargets } from "../server/metadata.js";
import { scaffoldSite } from "../server/sitegen.js";

// FBMCPF-249 — shipped-website support: a project's site can live outside the
// pad (its own dir + git repo) via the websiteLocation config key.

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbwl-"));
  return { dir, board: { projectDir: () => dir } };
}
function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// (a) back-compat: no websiteLocation → the site stays under <project>/site/.
test("no websiteLocation: site tools use the pad's <project>/site/ folder", () => {
  const { board, dir } = tmpBoard();
  setSite(board, "P", { title: "Home", sections: [] });
  addPage(board, "P", { slug: "about", title: "About" });
  assert.equal(siteRoot(board, "P"), path.join(dir, SITE_DIR));
  assert.ok(fs.existsSync(path.join(dir, SITE_DIR, SITE_HTML)));
  assert.ok(fs.existsSync(path.join(dir, SITE_DIR, SITE_CONFIG)));
  assert.ok(fs.existsSync(path.join(dir, SITE_DIR, "about.html")));
  const pages = listPages(board, "P");
  assert.equal(pages.count, 2);
});

// (b) websiteLocation set → site tools read+write the external dir directly.
test("websiteLocation set: addPage/listPages/getSite operate on the external dir", () => {
  const { board, dir } = tmpBoard();
  const ext = tmpDir("fbwl-ext-");
  setProjectConfig(board, "P", { websiteLocation: ext });

  assert.equal(siteRoot(board, "P"), path.resolve(ext));

  setSite(board, "P", { title: "Shipped", tagline: "live", sections: [] });
  const r = addPage(board, "P", { slug: "pricing", title: "Pricing" });
  assert.equal(r.pages, 1);

  // Files land in the external dir, NOT in the pad's site/ folder.
  assert.ok(fs.existsSync(path.join(ext, SITE_HTML)), "index.html in external dir");
  assert.ok(fs.existsSync(path.join(ext, SITE_CONFIG)), "site.json in external dir");
  assert.ok(fs.existsSync(path.join(ext, "pricing.html")), "pricing.html in external dir");
  assert.ok(!fs.existsSync(path.join(dir, SITE_DIR, "pricing.html")), "nothing written to pad site/");

  // getSite reads back from the external dir.
  const site = getSite(board, "P");
  assert.equal(site.title, "Shipped");
  const pages = listPages(board, "P");
  assert.equal(pages.count, 2);
  assert.ok(pages.pages.some((p) => p.slug === "pricing"));
});

// (c) resolveGitTargets — websiteRepo from explicit config, from an ancestor
// walk over websiteLocation, and absent when unconfigured.
test("resolveGitTargets: explicit gitTargets.websiteRepo wins", () => {
  const { board } = tmpBoard();
  setProjectConfig(board, "P", {
    codeLocation: "/repos/code",
    gitTargets: { websiteRepo: { path: "/repos/site", branch: "main" } },
  });
  const t = resolveGitTargets(board, "P");
  assert.ok(t.websiteRepo);
  assert.equal(t.websiteRepo.path, "/repos/site");
  assert.ok(t.preflight.includes("/repos/site"), "preflight mentions website repo");
});

test("resolveGitTargets: infers websiteRepo by walking up from websiteLocation to the .git root", () => {
  const { board } = tmpBoard();
  const repo = tmpDir("fbwl-repo-");
  fs.mkdirSync(path.join(repo, ".git")); // simulate a git repo root
  const assets = path.join(repo, "cloudflare"); // assets dir is a subdir of the repo
  fs.mkdirSync(assets);
  setProjectConfig(board, "P", { websiteLocation: assets });

  const t = resolveGitTargets(board, "P");
  assert.ok(t.websiteRepo, "websiteRepo present");
  assert.equal(t.websiteRepo.path, path.resolve(repo));
  assert.match(t.websiteRepo.note, /walked up/i);
  assert.ok(t.preflight.includes(path.resolve(repo)));
});

test("resolveGitTargets: websiteRepo absent when nothing is configured", () => {
  const { board } = tmpBoard();
  setProjectConfig(board, "P", { codeLocation: "/repos/code" });
  const t = resolveGitTargets(board, "P");
  assert.equal(t.websiteRepo, undefined);
  assert.ok(!t.preflight.includes("website commits"), "preflight has no website line");
});

// (d) scaffold_site initGit → a git repo is created at the site location.
test("scaffoldSite initGit:true creates a repo at the site location", () => {
  const { board } = tmpBoard();
  const res = scaffoldSite(board, "P", { title: "T", sections: [{ heading: "H", body: "B" }] }, { initGit: true });
  assert.ok(res.git, "result carries git info");
  assert.equal(res.git.path, siteRoot(board, "P"));
  if (res.git.initialized) {
    assert.ok(fs.existsSync(path.join(res.git.path, ".git")), ".git created");
  } else {
    assert.ok(res.git.warning || res.git.note, "non-initialized result explains why");
  }
});

test("scaffoldSite initGit:true is a no-op init when already inside a repo", () => {
  const { board } = tmpBoard();
  const repo = tmpDir("fbwl-existing-");
  fs.mkdirSync(path.join(repo, ".git"));
  const assets = path.join(repo, "site");
  fs.mkdirSync(assets);
  setProjectConfig(board, "P", { websiteLocation: assets });
  const res = scaffoldSite(board, "P", { title: "T" }, { initGit: true });
  assert.ok(res.git);
  assert.equal(res.git.initialized, false);
  assert.equal(res.git.path, path.resolve(repo));
});
