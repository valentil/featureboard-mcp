import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeSpec, scaffoldSite } from "../server/sitegen.js";
import { getSite, listPages } from "../server/website.js";

// FBMCPF-94 — scaffold a whole site from one prompt

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbsite-"));
  return { dir, board: { projectDir: () => dir } };
}

test("normalizeSpec requires a title", () => {
  assert.throws(() => normalizeSpec({}), /needs a title/);
  assert.throws(() => normalizeSpec({ title: "  " }), /needs a title/);
});

test("normalizeSpec validates theme + page slugs", () => {
  assert.throws(() => normalizeSpec({ title: "X", theme: "neon" }), /theme must be/);
  assert.throws(() => normalizeSpec({ title: "X", pages: [{ title: "no slug" }] }), /needs a slug/);
});

test("normalizeSpec coerces sections/pages into clean shapes", () => {
  const { home, pages } = normalizeSpec({
    title: "Acme",
    tagline: "We make things",
    theme: "dark",
    sections: [{ heading: "About", body: "Hi" }, {}],
    pages: [{ slug: "Pricing", sections: [{ heading: "Plans" }] }],
  });
  assert.equal(home.title, "Acme");
  assert.equal(home.theme, "dark");
  assert.equal(home.sections.length, 2);
  assert.equal(home.sections[1].heading, ""); // coerced
  assert.equal(pages[0].slug, "Pricing");
  assert.equal(pages[0].title, "Pricing"); // defaults to slug
  assert.equal(pages[0].sections[0].body, ""); // coerced
});

test("scaffoldSite persists home + pages in one shot", () => {
  const { board } = tmpBoard();
  const r = scaffoldSite(board, "P", {
    title: "Acme Co",
    tagline: "Widgets for all",
    theme: "dark",
    sections: [{ heading: "About", body: "We build widgets." }],
    pages: [
      { slug: "pricing", title: "Pricing", sections: [{ heading: "Plans", body: "Cheap." }] },
      { slug: "contact", sections: [{ heading: "Reach us", body: "hi@acme.co" }] },
    ],
  });
  assert.equal(r.title, "Acme Co");
  assert.equal(r.theme, "dark");
  assert.equal(r.pagesCreated, 2);
  assert.deepEqual(r.pages.map((p) => p.slug), ["pricing", "contact"]);

  // verify it went through the website store
  const site = getSite(board, "P");
  assert.equal(site.title, "Acme Co");
  assert.equal(site.tagline, "Widgets for all");
  assert.equal(site.sections.length, 1);
  const pages = listPages(board, "P");
  assert.equal(pages.count, 3); // home + 2 sub-pages
  assert.ok(fs.existsSync(path.join(board.projectDir("P"), "site", "index.html")));
  assert.ok(fs.existsSync(path.join(board.projectDir("P"), "site", "pricing.html")));
});

test("scaffoldSite works with no pages", () => {
  const { board } = tmpBoard();
  const r = scaffoldSite(board, "P", { title: "Solo", sections: [] });
  assert.equal(r.pagesCreated, 0);
  assert.equal(getSite(board, "P").title, "Solo");
});
