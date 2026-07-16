import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Board } from "../server/storage.js";
import { setProjectConfig, getProjectConfig, resolveGitTargets, getWorkPacket } from "../server/metadata.js";

// FBMCPF-149 — git targets: explicit per-project commit destinations.

function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fbgt-"));
  fs.mkdirSync(path.join(dir, "Proj"));
  fs.writeFileSync(path.join(dir, "Proj", "featurelist.md"), "# Feature List\n");
  fs.writeFileSync(path.join(dir, "Proj", "buglist.md"), "# Bug List\n");
  return new Board(dir);
}

test("setProjectConfig round-trips stage + gitTargets", () => {
  const b = tmpBoard();
  const gitTargets = {
    codeRepo: { path: "/repos/code", remote: "origin", branch: "main" },
    padRepo: { path: "/repos/pad", branch: "master" },
  };
  setProjectConfig(b, "Proj", { stage: "graduated", gitTargets });
  const cfg = getProjectConfig(b, "Proj");
  assert.equal(cfg.stage, "graduated");
  assert.deepEqual(cfg.gitTargets, gitTargets);
});

test("resolveGitTargets defaults: incubating, codeLocation fallback, pad = project dir", () => {
  const b = tmpBoard();
  setProjectConfig(b, "Proj", { codeLocation: "/repos/mycode" });
  const t = resolveGitTargets(b, "Proj");
  assert.equal(t.stage, "incubating");
  assert.equal(t.codeRepo.path, "/repos/mycode");
  assert.equal(t.padRepo.path, b.projectDir("Proj"));
  assert.match(t.padRepo.note, /projectpad/i);
  // preflight mentions both paths
  assert.ok(t.preflight.includes("/repos/mycode"), "preflight has code path");
  assert.ok(t.preflight.includes(b.projectDir("Proj")), "preflight has pad path");
  assert.ok(t.preflight.includes("incubating"), "preflight has stage");
});

test("resolveGitTargets: explicit gitTargets win over codeLocation", () => {
  const b = tmpBoard();
  setProjectConfig(b, "Proj", {
    codeLocation: "/repos/mycode",
    stage: "graduated",
    gitTargets: { codeRepo: { path: "/repos/explicit" }, padRepo: { path: "/repos/pad" } },
  });
  const t = resolveGitTargets(b, "Proj");
  assert.equal(t.stage, "graduated");
  assert.equal(t.codeRepo.path, "/repos/explicit");
  assert.equal(t.padRepo.path, "/repos/pad");
});

test("getWorkPacket includes gitTargets with a preflight", () => {
  const b = tmpBoard();
  setProjectConfig(b, "Proj", { codeLocation: "/repos/mycode" });
  const task = b.addTask("Proj", "feature", { title: "Do a thing" });
  const packet = getWorkPacket(b, "Proj", task.ticketNumber);
  assert.ok(packet.gitTargets, "packet has gitTargets");
  assert.equal(packet.gitTargets.stage, "incubating");
  assert.equal(packet.gitTargets.codeRepo.path, "/repos/mycode");
  assert.ok(typeof packet.gitTargets.preflight === "string" && packet.gitTargets.preflight.length > 0);
});
