#!/usr/bin/env node
/**
 * run-tests.mjs — parallel node:test runner (FBMCPF-161).
 *
 * `node --test` isolates each test file in its own child process, but its
 * default --test-concurrency is os.availableParallelism() - 1. On a 2-core
 * box that's 1 — effectively serial, "solo-queueing one core" while 486
 * tests wait behind it one at a time.
 *
 * This suite is I/O-bound (fs.mkdtemp + small file writes/reads per test,
 * a handful of child_process.spawnSync git calls) rather than CPU-bound, so
 * concurrency well beyond the physical core count keeps paying off: each
 * process spends most of its time blocked on I/O, not competing for CPU.
 * Measured on this repo's 2-core sandbox (52 files / 486 tests):
 *
 *   --test-concurrency=1 (== old default on 2 cores): ~14.7s
 *   --test-concurrency=2 (== core count):              ~10.8s
 *   --test-concurrency=4:                               ~9.5s
 *   --test-concurrency=6 (3x core count):                ~8.0s  <- sweet spot
 *   --test-concurrency=8:                               ~10.3s (regresses —
 *       process-spawn overhead starts to dominate)
 *
 * So the default here is 3x the core count, floored at 4 and capped at 32
 * (52 test files is the practical ceiling; going wider than that just adds
 * idle child processes on bigger boxes). Override with TEST_CONCURRENCY=N
 * if a different value suits your machine.
 *
 * Any extra CLI args (e.g. --test-name-pattern=foo) are forwarded to
 * `node --test` untouched.
 */
import { spawn } from "node:child_process";
import os from "node:os";

const cores = os.availableParallelism ? os.availableParallelism() : os.cpus().length;
const computed = Math.max(4, cores * 3);
const concurrency = Math.min(32, Number(process.env.TEST_CONCURRENCY) || computed);

const args = ["--test", `--test-concurrency=${concurrency}`, ...process.argv.slice(2)];

console.error(`[run-tests] ${cores} core(s) detected -> --test-concurrency=${concurrency}`);

const child = spawn(process.execPath, args, { stdio: "inherit" });
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code == null ? 1 : code);
});
child.on("error", (err) => {
  console.error("[run-tests] failed to launch node --test:", err);
  process.exit(1);
});
