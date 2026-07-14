import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Board, parseMarkdown, serializeTask, parseImport, suggestTestStub, bugImpactScan, computeRegressions, generateTestFromPrompt, splitBehaviors } from "../server/storage.js";

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-"));
  fs.mkdirSync(path.join(dir, "Proj"));
  fs.writeFileSync(path.join(dir, "Proj", "featurelist.md"), "# Feature List\n");
  fs.writeFileSync(path.join(dir, "Proj", "buglist.md"), "# Bug List\n");
  return new Board(dir);
}

test("parse a real-format line", () => {
  const line =
    "- [x] [FBF-546] **Title here**: some desc [Product: Core] [Labels: a, b] Summary: got it done [Created: 2026-05-24 | Due: 2026-05-29]";
  const [t] = parseMarkdown(line, "featurelist.md");
  assert.equal(t.ticketNumber, "FBF-546");
  assert.equal(t.title, "Title here");
  assert.equal(t.description, "some desc");
  assert.equal(t.status, "Done");
  assert.equal(t.product, "Core");
  assert.deepEqual(t.labels, ["a", "b"]);
  assert.equal(t.completionSummary, "got it done");
  assert.equal(t.dueDate, "2026-05-29");
});

test("round-trip serialize/parse", () => {
  const task = {
    ticketNumber: "FBF-1",
    title: "Round trip",
    description: "desc",
    status: "Todo",
    dueDate: "2026-07-14",
    product: "Core",
    labels: ["x", "y"],
    linkedIssue: "FBB-3",
    createdDate: "2026-07-07",
  };
  const [back] = parseMarkdown(serializeTask(task), "featurelist.md");
  assert.equal(back.title, "Round trip");
  assert.equal(back.product, "Core");
  assert.deepEqual(back.labels, ["x", "y"]);
  assert.equal(back.linkedIssue, "FBB-3");
  assert.equal(back.dueDate, "2026-07-14");
});

test("parse NewFile / Website flags", () => {
  const line =
    "- [ ] [FBF-24] **Ported**: desc [Product: Core] [NewFile: true] [Website: https://example.com/x] [Created: 2026-07-13]";
  const [t] = parseMarkdown(line, "featurelist.md");
  assert.equal(t.newFile, true);
  assert.equal(t.website, "https://example.com/x");
  // tokens must not bleed into the title/description text
  assert.equal(t.title, "Ported");
  assert.equal(t.description, "desc");
});

test("round-trip NewFile / Website (incl. explicit false)", () => {
  const task = {
    ticketNumber: "FBF-2",
    title: "Flagged",
    description: "d",
    status: "Todo",
    newFile: false,
    website: "https://foo.dev",
    createdDate: "2026-07-13",
  };
  const line = serializeTask(task);
  assert.match(line, /\[NewFile: false\]/);
  assert.match(line, /\[Website: https:\/\/foo\.dev\]/);
  const [back] = parseMarkdown(line, "featurelist.md");
  assert.equal(back.newFile, false);
  assert.equal(back.website, "https://foo.dev");
});

test("absent flags stay null and unserialized", () => {
  const line = serializeTask({
    ticketNumber: "FBF-3", title: "Plain", description: "", status: "Todo", createdDate: "2026-07-13",
  });
  assert.doesNotMatch(line, /NewFile|Website/);
  const [t] = parseMarkdown(line, "featurelist.md");
  assert.equal(t.newFile, null);
  assert.equal(t.website, null);
});

test("update flags then clear them", () => {
  const b = tmpBoard();
  const f = b.addTask("Proj", "feature", { title: "x", newFile: true, website: "https://a.b" });
  let u = b.getTask("Proj", f.ticketNumber);
  assert.equal(u.newFile, true);
  assert.equal(u.website, "https://a.b");
  b.updateTask("Proj", f.ticketNumber, { newFile: null, website: null });
  u = b.getTask("Proj", f.ticketNumber);
  assert.equal(u.newFile, null);
  assert.equal(u.website, null);
});

test("parseImport: markdown / csv / json + auto-detect", () => {
  const md = parseImport("# Backlog\n- [ ] A\n- [x] B: done it");
  assert.equal(md.length, 2);
  assert.equal(md[0].title, "A");
  assert.equal(md[1].title, "B");
  assert.equal(md[1].description, "done it");
  assert.equal(md[1].status, "Done");

  const csv = parseImport('title,type,priority,labels\n"Login, SSO",bug,2,"p1;auth"');
  assert.equal(csv[0].title, "Login, SSO");
  assert.equal(csv[0].type, "bug");
  assert.equal(csv[0].priority, 2);
  assert.deepEqual(csv[0].labels, ["p1", "auth"]);

  const json = parseImport('{"features":["X"],"bugs":[{"title":"Y"}]}');
  assert.equal(json.length, 2);
  assert.equal(json[0].type, "feature");
  assert.equal(json[1].type, "bug");
  assert.equal(parseImport("").length, 0);
});

test("suggestTestStub / bugImpactScan / computeRegressions", () => {
  const stub = suggestTestStub({ ticketNumber: "FBF-9", title: "Dark mode", description: "persist" }, "/app/");
  assert.equal(stub.path, "/app/test/FBF-9-dark-mode.test.js");
  assert.ok(stub.content.includes('test("Dark mode"'));

  const feats = [
    { ticketNumber: "FBF-1", title: "OAuth login", description: "SSO auth", product: "Auth", status: "Done" },
    { ticketNumber: "FBF-2", title: "CSV export", description: "download", product: "Core", status: "Todo" },
  ];
  const imp = bugImpactScan({ title: "login broken", description: "auth fails", product: "Auth" }, feats);
  assert.equal(imp[0].ticket, "FBF-1");
  assert.ok(!imp.some((r) => r.ticket === "FBF-2"));

  const reg = computeRegressions(
    [{ ticketNumber: "FBB-1", title: "x", status: "Todo", linkedIssue: "FBF-1" },
     { ticketNumber: "FBB-2", title: "y", status: "Todo", linkedIssue: null }],
    feats
  );
  assert.equal(reg.regressions.length, 1);
  assert.equal(reg.regressions[0].feature, "FBF-1");
  assert.equal(reg.regressions[0].openBugs, 1);
  assert.equal(reg.unlinkedBugs.length, 1);
});

test("id allocation and prefix inference", () => {
  const b = tmpBoard();
  const f1 = b.addTask("Proj", "feature", { title: "one" });
  const f2 = b.addTask("Proj", "feature", { title: "two" });
  assert.equal(f1.ticketNumber, "PF-1");
  assert.equal(f2.ticketNumber, "PF-2");
  const bug = b.addTask("Proj", "bug", { title: "bug" });
  assert.equal(bug.ticketNumber, "PB-1");
});

test("status transitions and completion summary", () => {
  const b = tmpBoard();
  const f = b.addTask("Proj", "feature", { title: "x" });
  b.setStatus("Proj", f.ticketNumber, "In Progress");
  assert.equal(b.getTask("Proj", f.ticketNumber).status, "In Progress");
  b.setStatus("Proj", f.ticketNumber, "Done", "finished");
  const done = b.getTask("Proj", f.ticketNumber);
  assert.equal(done.status, "Done");
  assert.equal(done.completionSummary, "finished");
});

test("update, link, delete", () => {
  const b = tmpBoard();
  const f = b.addTask("Proj", "feature", { title: "x", dueDate: "2026-01-01" });
  b.updateTask("Proj", f.ticketNumber, { title: "renamed", dueDate: null });
  const u = b.getTask("Proj", f.ticketNumber);
  assert.equal(u.title, "renamed");
  assert.equal(u.dueDate, null);
  b.linkTasks("Proj", f.ticketNumber, "PB-9");
  assert.equal(b.getTask("Proj", f.ticketNumber).linkedIssue, "PB-9");
  b.deleteTask("Proj", f.ticketNumber);
  assert.equal(b.getTask("Proj", f.ticketNumber), null);
});

test("existing FB-prefixed board keeps its prefix", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-"));
  fs.mkdirSync(path.join(dir, "Anything"));
  fs.writeFileSync(
    path.join(dir, "Anything", "featurelist.md"),
    "# Feature List\n- [ ] [FBF-40] **old** [Created: 2026-01-01]\n"
  );
  const b = new Board(dir);
  const next = b.addTask("Anything", "feature", { title: "new" });
  assert.equal(next.ticketNumber, "FBF-41");
});

// FBMCPF-102 — AI-generate a test from a prompt
test("splitBehaviors splits lines / and / sentences and strips 'should'", () => {
  assert.deepEqual(splitBehaviors("should log a bug\nand link it"), ["log a bug", "link it"]);
  assert.deepEqual(splitBehaviors("adds a row and returns the id"), ["adds a row", "returns the id"]);
  assert.deepEqual(splitBehaviors(""), ["behaves as described"]);
});

test("generateTestFromPrompt emits one test() per behaviour + valid header", () => {
  const r = generateTestFromPrompt({ prompt: "creates a contact\nremoves a contact", ticket: "FBF-9", title: "contacts", module: "../server/crm.js", codeLocation: "/repo" });
  assert.equal(r.fileName, "FBF-9-contacts.test.js");
  assert.match(r.path, /test[\\/]FBF-9-contacts\.test\.js$/);
  assert.equal(r.behaviors.length, 2);
  assert.match(r.content, /import \{ test \} from "node:test";/);
  assert.match(r.content, /import \* as mod from "\.\.\/server\/crm\.js";/);
  assert.equal((r.content.match(/^test\(/gm) || []).length, 2);
  assert.throws(() => generateTestFromPrompt({}), /required/);
});
