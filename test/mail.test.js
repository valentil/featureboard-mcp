import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  validateRecipients, buildMessage,
  draftEmail, listMail, getEmail, markSent, MAIL_FILE,
} from "../server/mail.js";

// FBMCPF-48 — Mail center (drafts + history)

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbmail-"));
  return { dir, board: { projectDir: () => dir } };
}

test("validateRecipients accepts string/array, rejects bad/empty", () => {
  assert.deepEqual(validateRecipients("a@b.com"), ["a@b.com"]);
  assert.deepEqual(validateRecipients(["a@b.com", "c@d.io"]), ["a@b.com", "c@d.io"]);
  assert.throws(() => validateRecipients("notanemail"), /invalid email/);
  assert.throws(() => validateRecipients([]), /at least one recipient/);
});

test("buildMessage requires subject or body; defaults status draft", () => {
  const m = buildMessage(1, { to: "a@b.com", subject: "Hi", body: "yo", cc: ["c@d.io"] });
  assert.equal(m.id, "E1");
  assert.equal(m.status, "draft");
  assert.deepEqual(m.cc, ["c@d.io"]);
  assert.equal(m.sentAt, null);
  assert.throws(() => buildMessage(2, { to: "a@b.com" }), /subject or body/);
});

test("draftEmail persists; listMail newest-first + filters", () => {
  const { board } = tmpBoard();
  draftEmail(board, "P", { to: "a@b.com", subject: "One", company: "acme" });
  draftEmail(board, "P", { to: "c@d.io", subject: "Two" });
  assert.equal(listMail(board, "P").count, 2);
  assert.equal(listMail(board, "P").messages[0].subject, "Two"); // newest-first
  assert.equal(listMail(board, "P", { company: "acme" }).count, 1);
});

test("markSent moves draft to history; getEmail; guards", () => {
  const { board } = tmpBoard();
  const d = draftEmail(board, "P", { to: "a@b.com", subject: "Hi" });
  assert.equal(listMail(board, "P", { status: "draft" }).count, 1);
  const sent = markSent(board, "P", d.message.id);
  assert.equal(sent.message.status, "sent");
  assert.ok(sent.message.sentAt);
  assert.equal(listMail(board, "P", { status: "sent" }).count, 1);
  assert.equal(listMail(board, "P", { status: "draft" }).count, 0);
  assert.equal(getEmail(board, "P", d.message.id).status, "sent");
  assert.throws(() => markSent(board, "P", d.message.id), /already marked sent/);
  assert.throws(() => markSent(board, "P", "E99"), /not found/);
  assert.throws(() => getEmail(board, "P", "E99"), /not found/);
});

test("store lives at mail.json", () => {
  const { dir, board } = tmpBoard();
  draftEmail(board, "P", { to: "a@b.com", subject: "x" });
  assert.ok(fs.existsSync(path.join(dir, MAIL_FILE)));
});
