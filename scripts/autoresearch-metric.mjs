#!/usr/bin/env node
/**
 * autoresearch-metric.mjs (FBMCPF-246) — default objective for the auto-research
 * loop: median wall time (ms) of the board hot path (parse + listTasks over a
 * 500-ticket board), printed as `METRIC <ms>`. Lower is better.
 *
 * Same philosophy as strengthen.mjs's perf stage: a deterministic synthetic
 * board in a temp dir, timed over several iterations, median reported so one
 * GC pause doesn't decide an experiment. Swap in any other command via
 * autoresearch.config.json → objective.command as long as it prints a line
 * matching objective.parse.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Board } from "../server/storage.js";

const TICKETS = 500;
const ITERS = 7;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-armetric-"));
fs.mkdirSync(path.join(dir, "P"));

// deterministic synthetic board (no RNG — identical input every run)
const lines = ["# Feature List"];
for (let i = 1; i <= TICKETS; i++) {
  const status = i % 3 === 0 ? "x" : i % 3 === 1 ? " " : "-";
  lines.push(
    `- [${status}] [PF-${i}] **Ticket ${i} with a reasonably long title about module ${i % 17}**: ` +
    `description body ${"lorem ".repeat(12)}#${i} ` +
    `[Product: ${["Core", "CRM", "Site", "Media"][i % 4]}] [Labels: model:${["haiku", "sonnet", "opus"][i % 3]}, cap:${(i % 9) + 1}0000, sprint:S${i % 5}] [Priority: ${(i % 10) + 1}]`
  );
}
fs.writeFileSync(path.join(dir, "P", "featurelist.md"), lines.join("\n") + "\n");
fs.writeFileSync(path.join(dir, "P", "buglist.md"), "# Bug List\n");

const board = new Board(dir);
const times = [];
for (let i = 0; i < ITERS; i++) {
  const t0 = process.hrtime.bigint();
  const tasks = board.listTasks("P", {});
  const t1 = process.hrtime.bigint();
  if (!tasks || tasks.length !== TICKETS) {
    console.error(`sanity failed: expected ${TICKETS} tickets, got ${tasks && tasks.length}`);
    process.exit(1);
  }
  times.push(Number(t1 - t0) / 1e6);
}
times.sort((a, b) => a - b);
const median = times.length % 2 ? times[(times.length - 1) / 2] : (times[times.length / 2 - 1] + times[times.length / 2]) / 2;
console.log(`METRIC ${median.toFixed(3)}`);
