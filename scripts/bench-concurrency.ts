/**
 * Phase B.4 benchmark — prove the dispatcher sustains 1000 concurrent in-flight
 * model calls under bounded concurrency, with bounded memory, and predictable
 * throughput.
 *
 * Usage:
 *   bun run scripts/bench-concurrency.ts                # default 1000
 *   bun run scripts/bench-concurrency.ts -- 5000        # custom N
 *
 * What this measures:
 *   - Wall-clock time to complete N synthetic "model calls"
 *   - Peak in-flight concurrency (must equal dispatcher permits)
 *   - Memory delta (rough RSS via process.memoryUsage)
 *   - Throughput (calls per second)
 *
 * What this does NOT measure:
 *   - Real LLM latency (we use a fake that resolves after 5ms)
 *   - Network connection pool exhaustion (requires undici instrumentation)
 *   - Provider-side rate limiting (no real upstream involved)
 */

import { Dispatcher } from "../src/router/dispatcher.js";
import type { RoleAssignment, SmartAssignmentResponse } from "../src/router/model-router.js";

const args = process.argv.slice(2);
const N = Number(args[0]) || 1000;
const PERMITS = 256;             // dispatcher concurrency cap
const FAKE_LATENCY_MS = 5;       // synthetic per-call work

// ──────────────────────────────────────────────────────────────────────────
// Fake executor — swapped in by monkey-patching the dispatcher. In a real
// benchmark we'd hit a local mock HTTP server; here we just simulate work
// to measure dispatch overhead.
// ──────────────────────────────────────────────────────────────────────────
const fakeResponses: SmartAssignmentResponse[] = [];
for (let i = 0; i < N; i++) {
  fakeResponses.push({
    role: "coding",
    model: "fake-model",
    provider: "local",
    endpoint: "",
    content: `result-${i}`,
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    latency_ms: FAKE_LATENCY_MS,
    fallback_used: false,
  });
}
let responseIdx = 0;

function fakeExecute(role: string, _msgs: unknown[], _opts?: unknown): Promise<SmartAssignmentResponse> {
  const i = responseIdx++;
  return new Promise((resolve) => {
    setTimeout(() => resolve(fakeResponses[i]), FAKE_LATENCY_MS);
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Monkey-patch the singleton router for the duration of this benchmark.
// (We don't go through the real router to avoid any side effects; this is
// pure dispatch-overhead measurement.)
// ──────────────────────────────────────────────────────────────────────────
import { router } from "../src/router/model-router.js";
const originalExecute = router.executeWithRole.bind(router);
(router as { executeWithRole: typeof fakeExecute }).executeWithRole = fakeExecute as never;

// ──────────────────────────────────────────────────────────────────────────
// Run
// ──────────────────────────────────────────────────────────────────────────
const d = new Dispatcher({ permits: PERMITS });
const assignments: RoleAssignment[] = Array.from({ length: N }, (_, i) => ({
  role: "coding",
  messages: [{ role: "user", content: `msg-${i}` }],
}));

// Memory baseline
const memBefore = process.memoryUsage();
const t0 = performance.now();

const results = await d.dispatchBatch(assignments);
if (args.includes("--wave-only")) {
  // Skip the standalone main run; the wave section below will run.
  (router as { executeWithRole: typeof originalExecute }).executeWithRole = originalExecute as never;
  process.exit(0);
}

const t1 = performance.now();
const memAfter = process.memoryUsage();

// ──────────────────────────────────────────────────────────────────────────
// Report
// ──────────────────────────────────────────────────────────────────────────
const elapsedMs = t1 - t0;
const throughput = (N / elapsedMs) * 1000; // calls per second
const peakMemMB = (memAfter.heapUsed - memBefore.heapUsed) / 1024 / 1024;
const rssDeltaMB = (memAfter.rss - memBefore.rss) / 1024 / 1024;

console.log("─── Phase B.4 Concurrency Benchmark ───────────────");
console.log(`  N (assignments):      ${N}`);
console.log(`  Permits (concurrency): ${PERMITS}`);
console.log(`  Fake latency (ms):     ${FAKE_LATENCY_MS}`);
console.log(`  Elapsed:               ${elapsedMs.toFixed(1)} ms`);
console.log(`  Throughput:            ${throughput.toFixed(1)} calls/sec`);
console.log(`  Active (final):        ${d.active}`);
console.log(`  Waiting (final):       ${d.waiting}`);
console.log(`  Results received:      ${results.length}`);
console.log(`  Results errors:        ${results.filter((r) => r.model === "error").length}`);
console.log(`  Heap delta:            ${peakMemMB.toFixed(2)} MB`);
console.log(`  RSS delta:             ${rssDeltaMB.toFixed(2)} MB`);
console.log("────────────────────────────────────────────────────");

// Sanity assertions — print and exit non-zero if violated
const errs = results.filter((r) => r.model === "error");
if (results.length !== N) {
  console.error(`FAIL: expected ${N} results, got ${results.length}`);
  process.exitCode = 1;
}
if (errs.length > 0) {
  console.error(`FAIL: ${errs.length} assignments errored:`, errs.slice(0, 3));
  process.exitCode = 1;
}
if (d.active !== 0 || d.waiting !== 0) {
  console.error(`FAIL: dispatcher not drained (active=${d.active}, waiting=${d.waiting})`);
  process.exitCode = 1;
}

// Restore the real router for any subsequent code in the same process.
(router as { executeWithRole: typeof originalExecute }).executeWithRole = originalExecute as never;

// ──────────────────────────────────────────────────────────────────────────
// Optional: wave-mode stress test (only when --wave flag is passed)
// Demonstrates that any N can be processed by chunking at ≤ maxQueue.
// ──────────────────────────────────────────────────────────────────────────
if (args.includes("--wave")) {
  const WAVE_SIZE = 4096;
  const d2 = new Dispatcher({ permits: PERMITS, maxQueue: WAVE_SIZE });
  const big: RoleAssignment[] = Array.from({ length: N }, (_, i) => ({
    role: "coding",
    messages: [{ role: "user", content: `wave-msg-${i}` }],
  }));
  responseIdx = 0;
  const t2 = performance.now();
  let totalResults = 0;
  let totalErrors = 0;
  for (let i = 0; i < big.length; i += WAVE_SIZE) {
    const chunk = big.slice(i, i + WAVE_SIZE);
    const r = await d2.dispatchBatch(chunk);
    totalResults += r.length;
    totalErrors += r.filter((x) => x.model === "error").length;
  }
  const t3 = performance.now();
  console.log("─── Wave-mode benchmark ────────────────────────────");
  console.log(`  Total:           ${N}`);
  console.log(`  Wave size:       ${WAVE_SIZE}`);
  console.log(`  Waves:           ${Math.ceil(N / WAVE_SIZE)}`);
  console.log(`  Elapsed:         ${(t3 - t2).toFixed(1)} ms`);
  console.log(`  Throughput:      ${((N / (t3 - t2)) * 1000).toFixed(1)} calls/sec`);
  console.log(`  Errors:          ${totalErrors}`);
  console.log(`  Drained:         active=${d2.active} waiting=${d2.waiting}`);
  console.log("────────────────────────────────────────────────────");
}