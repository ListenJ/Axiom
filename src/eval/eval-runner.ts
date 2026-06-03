/**
 * Model Evaluation Runner — CLI entry point
 * Usage: bun run src/eval/eval-runner.ts [--model deepseek-v4-flash-free] [--dimension capability]
 */
import { ALL_TEST_CASES, getTestCasesByDimension, getTestCasesByCategory, ALL_CATEGORIES, type EvalDimension, type EvalTestCase } from "./test-cases.js";
import { evaluateResponse, type ModelResponse, type EvaluatedResponse } from "./judge.js";
import { generateReport, toMarkdown, toJSON, type EvalReport } from "./reporter.js";
import { existsSync, mkdirSync, writeFileSync } from "fs";

// ===== Config =====
const OUTPUT_DIR = "./eval-results";
const DEFAULT_MODELS = [
  "deepseek/deepseek-chat-v3-0324:free",   // DeepSeek V3 (最强综合)
  "nousresearch/hermes-3-llama-3.1-405b:free", // Hermes 405B (深度研究)
  "qwen/qwen3-coder-480b-a35b-instruct-turbo:free", // Qwen3 480B (代码)
];
const CONCURRENCY = 3; // parallel test execution

// ===== CLI Args =====
const args = Bun.argv.slice(2);
const modelFilter = args.find((a) => a.startsWith("--model="))?.split("=")[1];
const dimensionFilter = args.find((a) => a.startsWith("--dimension="))?.split("=")[1] as EvalDimension | undefined;
const categoryFilter = args.find((a) => a.startsWith("--category="))?.split("=")[1];
const dryRun = args.includes("--dry-run");
const noJudge = args.includes("--no-judge"); // skip LLM judge, just run
const outputFormat = args.includes("--json") ? "json" : "md";
const helpRequested = args.includes("--help") || args.includes("-h");

if (helpRequested) {
  console.log(`
OpenClaw Model Evaluation Runner
=================================
Usage: bun run src/eval/eval-runner.ts [options]

Options:
  --model=<id>     Evaluate specific model (default: all free models)
  --dimension=<d>  Filter by dimension (capability|safety|performance|robustness)
  --category=<c>   Filter by category (coding, writing, reasoning, etc.)
                   Available: ${ALL_CATEGORIES.join(", ")}
  --dry-run        Show test plan without executing
  --no-judge       Skip LLM judge scoring (just call models)
  --json           Output JSON instead of Markdown
  --help           Show this help

Examples:
  bun run src/eval/eval-runner.ts --dry-run
  bun run src/eval/eval-runner.ts --category=coding
  bun run src/eval/eval-runner.ts --dimension=capability --no-judge
  bun run src/eval/eval-runner.ts --model=deepseek/deepseek-v4-flash-free --json
`);
  process.exit(0);
}

// ===== Model API Calling =====

async function callModel(
  model: string,
  testCase: EvalTestCase
): Promise<ModelResponse> {
  const t0 = performance.now();

  const key = process.env.OPENROUTER_API_KEY;
  const base = "https://openrouter.ai/api/v1";

  const messages = [];
  if (testCase.systemPrompt) {
    messages.push({ role: "system" as const, content: testCase.systemPrompt });
  }
  messages.push({ role: "user" as const, content: testCase.prompt });

  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${key}`,
      "HTTP-Referer": "https://openclaw.dev",
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: testCase.maxTokens || 512,
      temperature: testCase.temperature ?? 0,
      ...(testCase.dimension === "performance" ? { stream: false } : {}),
    }),
    signal: AbortSignal.timeout(60000),
  });

  const latencyMs = Math.round(performance.now() - t0);

  if (!res.ok) {
    const errText = await res.text().catch(() => "unknown");
    return {
      testId: testCase.id,
      model,
      content: `[ERROR ${res.status}] ${errText.slice(0, 200)}`,
      tokensUsed: 0,
      latencyMs,
      ttftMs: latencyMs,
      timestamp: new Date().toISOString(),
      cost: 0,
    };
  }

  const data = await res.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number; input_tokens?: number; output_tokens?: number } };
  const content = data.choices?.[0]?.message?.content || "[EMPTY RESPONSE]";
  // OpenCode doesn't always return total_tokens; try various paths
  const tokensUsed = data.usage?.total_tokens
    || (data.usage?.prompt_tokens || 0) + (data.usage?.completion_tokens || 0)
    || (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0)
    || 0;

  // Estimate cost (free models = $0)
  const cost = model.includes(":free")
    ? 0
    : tokensUsed * 0.000001; // rough estimate for non-free models

  return {
    testId: testCase.id,
    model,
    content,
    tokensUsed,
    latencyMs,
    ttftMs: Math.round(latencyMs * 0.3), // approximate, no streaming info
    timestamp: new Date().toISOString(),
    cost,
  };
}

// ===== Concurrency =====

async function runWithConcurrency<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number
): Promise<R[]> {
  const results: R[] = [];
  const queue = [...items];

  const worker = async (): Promise<void> => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      results.push(await fn(item));
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

// ===== Main =====

async function main() {
  // Prepare test cases
  const testCases = categoryFilter
    ? getTestCasesByCategory(categoryFilter)
    : dimensionFilter
      ? getTestCasesByDimension(dimensionFilter)
      : ALL_TEST_CASES;

  const models = modelFilter ? [modelFilter] : DEFAULT_MODELS;
  const judgeModel = process.env.JUDGE_MODEL || "anthropic/claude-sonnet-4.6";

  const filterLabel = categoryFilter || dimensionFilter || "all";
  console.log(`\n🔬 OpenClaw Model Evaluation`);
  console.log(`   Models: ${models.join(", ")}`);
  console.log(`   Test cases: ${testCases.length} (${filterLabel})`);
  console.log(`   Judge: ${noJudge ? "disabled" : judgeModel}`);
  console.log(`   Concurrency: ${CONCURRENCY}`);
  console.log(`   Total calls: ${models.length * testCases.length}\n`);

  if (dryRun) {
    console.log("📋 Test Plan:");
    let i = 1;
    for (const model of models) {
      for (const tc of testCases) {
        console.log(`   ${i++}. [${tc.dimension}] ${tc.id}: ${tc.category} → ${model}`);
      }
    }
    console.log(`\n   (Dry run — no API calls made)`);
    return;
  }

  // Ensure output directory
  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

  // Step 1: Call models for all test cases
  const allModels = models.flatMap((model) =>
    testCases.map((tc) => ({ model, testCase: tc }))
  );

  console.log("📡 Calling models...");
  const tStart = performance.now();

  const modelResponses = await runWithConcurrency(
    allModels,
    async ({ model, testCase }) => {
      const idx = allModels.findIndex((m) => m.model === model && m.testCase === testCase) + 1;
      process.stdout.write(`   [${idx}/${allModels.length}] ${testCase.id} → ${model.split("/").pop()}... `);
      const response = await callModel(model, testCase);
      console.log(`${response.latencyMs}ms (${response.tokensUsed} tok)`);
      return response;
    },
    CONCURRENCY
  );

  const modelTime = Math.round(performance.now() - tStart);
  console.log(`\n✅ Model calls complete in ${modelTime}ms\n`);

  // Step 2: Judge responses
  const evaluated: EvaluatedResponse[] = [];

  if (!noJudge) {
    console.log("⚖️  Judge scoring...");
    const tJudgeStart = performance.now();

    const evalResults = await runWithConcurrency(
      modelResponses,
      async (response) => {
        const tc = testCases.find((t) => t.id === response.testId)!;
        const idx = modelResponses.indexOf(response) + 1;
        process.stdout.write(`   [${idx}/${modelResponses.length}] ${tc.id} ← ${response.model.split("/").pop()}... `);
        const result = await evaluateResponse(response, tc);
        console.log(`${result.overallScore}/100 (${result.grade})`);
        return result;
      },
      CONCURRENCY
    );

    evaluated.push(...evalResults);
    const judgeTime = Math.round(performance.now() - tJudgeStart);
    console.log(`\n✅ Judge scoring complete in ${judgeTime}ms\n`);
  } else {
    // --no-judge: create pseudo-evaluated entries from raw responses
    evaluated.push(...modelResponses.map((response) => {
      const tc = testCases.find((t) => t.id === response.testId)!;
      return {
        response,
        testCase: tc,
        scores: [{ dimension: tc.dimension, score: 0, explanation: "No judge — raw response only", passed: false }],
        overallScore: 0,
        grade: "N/A" as const,
      };
    }));
  }

  // Step 3: Generate report
  const report = generateReport(evaluated, models, judgeModel);

  // Write output
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const suffix = categoryFilter ? `-${categoryFilter}` : dimensionFilter ? `-${dimensionFilter}` : "";

  if (outputFormat === "json") {
    const jsonPath = `${OUTPUT_DIR}/eval-${timestamp}${suffix}.json`;
    writeFileSync(jsonPath, toJSON(report));
    console.log(`📄 Report: ${jsonPath}`);
  } else {
    const mdPath = `${OUTPUT_DIR}/eval-${timestamp}${suffix}.md`;
    writeFileSync(mdPath, toMarkdown(report));
    console.log(`📄 Report: ${mdPath}`);
  }

  // Summary
  console.log(`\n📊 Summary:`);
  for (const s of report.summaries) {
    console.log(`   ${s.model}: ${s.overallScore}/100 (${s.grade}) — ${s.latency.avgMs}ms avg, $${s.cost.total.toFixed(4)}`);
  }
}

main().catch((err) => {
  console.error(`\n❌ Fatal error:`, err.message);
  process.exit(1);
});
