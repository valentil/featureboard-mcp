import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Board } from "../server/storage.js";
import { setProjectConfig } from "../server/metadata.js";
import { lintVoice, loadRuleset, getVoiceProfile, FALLBACK_RULESET } from "../server/voice.js";

// FBMCPF-267 — voice_lint: score text for AI-writing tells against the
// research-backed ruleset in docs/VOICE-RESEARCH.md (FBMCPF-266). An editing
// aid for one's OWN outbound drafts, not a detector for judging authorship
// (see docs/VOICE-RESEARCH.md "Limitations").

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-voice-"));
  fs.mkdirSync(path.join(dir, "Proj"));
  fs.writeFileSync(path.join(dir, "Proj", "featurelist.md"), "# Feature List\n");
  fs.writeFileSync(path.join(dir, "Proj", "buglist.md"), "# Bug List\n");
  return new Board(dir);
}

// Six sentences of identical length (uniform rhythm/low burstiness), a
// tricolon, a "not just X, but Y" contrastive pivot, "delve", and a pair of
// em-dashes — a composite of several documented tells from VOICE-RESEARCH.md.
const AI_TEXT =
  "This tool will delve into the archives to find data. " +
  "This tool will scan through the folders to find files. " +
  "This tool will check across the systems to find flaws. " +
  "This tool will search within the records to find gaps. " +
  "This tool will parse across the outputs to find trends. " +
  "This tool will review across the reports to find risks. " +
  "The plan is fast, reliable, and secure. " +
  "It's not just fast, but incredibly efficient. " +
  "This works well — arguably better — than others.";

// Short, bursty (very short/very long alternating) sentences with no banned
// vocabulary, no contrastive pivots, no em-dashes, no tricolons.
const HUMAN_TEXT =
  "I overslept. " +
  "By the time I made it downstairs the coffee had gone cold and the cat was already asleep on the newspaper. " +
  "Rain again. " +
  "I wasn't sure why, though it felt calmer after than it usually does on grey mornings like this one. " +
  "Maybe tomorrow.";

test("AI-sounding fixture scores high with the expected rule ids", () => {
  const r = lintVoice(AI_TEXT);
  const ids = r.findings.map((f) => f.id);
  assert.ok(r.aiScore >= 50, `expected a high aiScore, got ${r.aiScore}`);
  assert.ok(ids.includes("lex.delve"), "delve should fire");
  assert.ok(ids.includes("struct.not-but"), "the not-just-X-but-Y pivot should fire");
  assert.ok(ids.includes("rhythm.uniform"), "uniform sentence length should fire burstiness");
  assert.ok(ids.includes("struct.tricolon"), "the rule-of-three should fire");
  assert.ok(ids.includes("struct.emdash-density"), "the em-dash pair should fire density");
  assert.equal(r.wordCount, AI_TEXT.trim().split(/\s+/).length);
  assert.match(r.summary, /flavored|tell/i);
  // every finding must carry either an excerpt (regex rule) or a metricValue (metric rule)
  for (const f of r.findings) {
    assert.ok(f.excerpt !== undefined || f.metricValue !== undefined, `${f.id} missing excerpt/metricValue`);
    assert.ok(f.suggestion, `${f.id} missing a suggestion`);
  }
});

test("plain human-sounding fixture scores low/clean", () => {
  const r = lintVoice(HUMAN_TEXT);
  assert.equal(r.aiScore, 0, `expected a clean score, got ${r.aiScore} (findings: ${r.findings.map((f) => f.id).join(", ")})`);
  assert.equal(r.findings.length, 0);
  assert.match(r.summary, /clean/i);
});

test("allowedTells suppresses a rule that would otherwise fire", () => {
  const withDelve = lintVoice(AI_TEXT);
  assert.ok(withDelve.findings.some((f) => f.id === "lex.delve"));

  const suppressed = lintVoice(AI_TEXT, { allowedTells: ["lex.delve"] });
  assert.ok(!suppressed.findings.some((f) => f.id === "lex.delve"), "lex.delve should be suppressed");
  // other rules should still fire
  assert.ok(suppressed.findings.some((f) => f.id === "struct.not-but"));
  assert.ok(suppressed.aiScore < withDelve.aiScore, "score should drop once a rule is suppressed");
});

test("extraBannedPhrases adds a project-specific hit", () => {
  const text = "We should really double down on this approach.";
  const base = lintVoice(text);
  assert.ok(!base.findings.some((f) => f.id.startsWith("custom.banned.")));

  const withBan = lintVoice(text, { extraBannedPhrases: ["double down"] });
  const hit = withBan.findings.find((f) => f.id === "custom.banned.double-down");
  assert.ok(hit, "banned phrase should produce a finding");
  assert.equal(hit.severity, 2);
  assert.match(hit.excerpt, /double down/i);
  assert.ok(withBan.aiScore > base.aiScore);
});

test("ruleset loads from docs/VOICE-RESEARCH.md by default (33 documented rules)", () => {
  const { rules, source } = loadRuleset();
  assert.equal(source, "doc");
  assert.ok(rules.length >= 30, `expected >=30 rules from the doc, got ${rules.length}`);
  assert.ok(rules.some((r) => r.id === "lex.delve"));
  assert.ok(rules.some((r) => r.kind === "metric"));

  const r = lintVoice("placeholder text for rule counting.");
  assert.ok(r.rulesApplied >= 30, `expected rulesApplied >=30, got ${r.rulesApplied}`);
});

test("fallback ruleset is used when the doc path is wrong, and the tool never breaks", () => {
  const { rules, source } = loadRuleset({ docPath: "/definitely/not/a/real/path/VOICE-RESEARCH.md" });
  assert.equal(source, "fallback");
  assert.deepEqual(rules, FALLBACK_RULESET);
  assert.ok(rules.length >= 8 && rules.length <= 10);

  const r = lintVoice(AI_TEXT, { docPath: "/definitely/not/a/real/path/VOICE-RESEARCH.md" });
  assert.equal(r.rulesSource, "fallback");
  assert.ok(r.aiScore > 0);
  assert.ok(r.findings.some((f) => f.id === "lex.delve"));
});

test("getVoiceProfile reads the project's voiceProfile config (tolerant of absence)", () => {
  const b = tmpBoard();
  const empty = getVoiceProfile(b, "Proj");
  assert.deepEqual(empty, { extraBannedPhrases: [], allowedTells: [], samplesNote: "" });

  setProjectConfig(b, "Proj", {
    voiceProfile: {
      extraBannedPhrases: ["circle back"],
      allowedTells: ["lex.delve"],
      samplesNote: "Match the team's changelog voice.",
    },
  });
  const vp = getVoiceProfile(b, "Proj");
  assert.deepEqual(vp.extraBannedPhrases, ["circle back"]);
  assert.deepEqual(vp.allowedTells, ["lex.delve"]);
  assert.equal(vp.samplesNote, "Match the team's changelog voice.");

  const r = lintVoice("Let's circle back on this delve into the archives.", {
    extraBannedPhrases: vp.extraBannedPhrases,
    allowedTells: vp.allowedTells,
    samplesNote: vp.samplesNote,
  });
  assert.ok(!r.findings.some((f) => f.id === "lex.delve"), "allowedTells should suppress delve");
  assert.ok(r.findings.some((f) => f.id === "custom.banned.circle-back"), "extraBannedPhrases should add circle-back");
  assert.equal(r.profileNote, "Match the team's changelog voice.");
});

test("threshold only changes the summary wording, not which findings fire", () => {
  const low = lintVoice(AI_TEXT, { threshold: 1 });
  const high = lintVoice(AI_TEXT, { threshold: 99 });
  assert.equal(low.findings.length, high.findings.length);
  assert.equal(low.aiScore, high.aiScore);
  assert.notEqual(low.summary, high.summary);
});

test("line-anchored rules fire on middle lines of multi-line text (multiline flag)", () => {
  // The sycophantic opener sits on a MIDDLE line, not at the start of the
  // whole text; the tidy closer sits on an inner line too, not the very end.
  // Without the "m" flag the ^/$ anchors only match the extremes of the
  // string and both rules stay silent.
  const text =
    "Thanks for the draft, I read it twice.\n" +
    "Great question! I think the schema change is the right call.\n" +
    "In summary, we ship it Tuesday.\n" +
    "One more thing: remember to tag the release.";
  const r = lintVoice(text);
  const ids = r.findings.map((f) => f.id);
  assert.ok(ids.includes("struct.sycophant-opener"), `opener on a middle line should fire (got: ${ids.join(", ")})`);
  assert.ok(ids.includes("struct.tidy-closer"), `closer on an inner line should fire (got: ${ids.join(", ")})`);
  const opener = r.findings.find((f) => f.id === "struct.sycophant-opener");
  assert.match(opener.excerpt, /great question/i);
});

test("empty text is clean and never throws", () => {
  const r = lintVoice("");
  assert.equal(r.aiScore, 0);
  assert.equal(r.wordCount, 0);
  assert.deepEqual(r.findings, []);
});
