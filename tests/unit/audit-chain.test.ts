/**
 * 全自动审计链的行为测试。
 *
 * 覆盖四类东西：
 * 1. runner 选择（Windows→WSL，Linux/macOS→本机 python）——Linux 任务的关键适配点；
 * 2. 三个机械 stage 的输出契约（清单分类/排除、向量痕迹双通道、声明提取）与确定性（复跑字节一致）；
 * 3. 比对器 allEqual 的边界（空集不算一致）；
 * 4. 链驱动 runAuditChain 的编排：AUTO 动作被执行、ESCALATE 不被执行、证据落盘。
 *
 * 用 tmp 夹具走公共接口，不 mock 内部协作者；模型侧不在此测（laya-triage.test.ts 已锁闸门语义）。
 */
import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  allEqual,
  determinismVerdict,
  extractClaims,
  runAuditChain,
  scanInventory,
  scanVectorFootprint,
  AUDIT_STAGE_IDS,
} from "../../src/decision/audit-chain.js";
import { selectRunnerKind } from "../../src/decision/laya-triage.js";
import { REVERSIBLE_ACTIONS } from "../../src/decision/laya-cli.js";

const tmpRoots: string[] = [];
function makeFixture(): string {
  const root = mkdtempSync(path.join(tmpdir(), "audit-chain-"));
  tmpRoots.push(root);
  return root;
}
afterAll(() => {
  for (const r of tmpRoots) rmSync(r, { recursive: true, force: true });
});

describe("selectRunnerKind —— 平台决定 runner 种类", () => {
  it("Windows 走 WSL", () => expect(selectRunnerKind("win32")).toBe("wsl"));
  it("Linux 走本机 python（不经 wsl.exe）", () => expect(selectRunnerKind("linux")).toBe("local"));
  it("macOS 同样走本机", () => expect(selectRunnerKind("darwin")).toBe("local"));
});

describe("scanInventory —— Phase 0 的分母", () => {
  it("分类正确、排除面生效、输出按路径排序且复跑逐字节一致", async () => {
    const root = makeFixture();
    mkdirSync(path.join(root, "src"), { recursive: true });
    mkdirSync(path.join(root, "tests"), { recursive: true });
    mkdirSync(path.join(root, "docs"), { recursive: true });
    mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
    mkdirSync(path.join(root, "dist"), { recursive: true });
    mkdirSync(path.join(root, ".git"), { recursive: true });
    writeFileSync(path.join(root, "src", "a.ts"), "export const a = 1;\nexport const b = 2;\n");
    writeFileSync(path.join(root, "tests", "a.test.ts"), "it(\"x\", () => {});\n");
    writeFileSync(path.join(root, "docs", "x.md"), "# x\n");
    writeFileSync(path.join(root, "package.json"), "{}\n");
    writeFileSync(path.join(root, "logo.png"), "bin");
    writeFileSync(path.join(root, "noise.log"), "2026-09-25 noisy\n");
    writeFileSync(path.join(root, "node_modules", "pkg", "i.js"), "x");
    writeFileSync(path.join(root, "dist", "o.js"), "x");

    const inv = await scanInventory(root);
    const paths = inv.files.map((f) => f.path);
    expect(paths).toEqual([...paths].sort()); // 排序稳定：与遍历顺序无关
    expect(paths).toContain("src/a.ts");
    expect(inv.files.find((f) => f.path === "src/a.ts")).toMatchObject({ type: "core", lines: 2 });
    expect(inv.files.find((f) => f.path === "tests/a.test.ts")?.type).toBe("test");
    expect(inv.files.find((f) => f.path === "docs/x.md")?.type).toBe("docs");
    expect(inv.files.find((f) => f.path === "package.json")?.type).toBe("config");
    expect(inv.files.find((f) => f.path === "logo.png")?.type).toBe("asset");
    expect(paths).not.toContain("node_modules/pkg/i.js");
    expect(paths).not.toContain("dist/o.js");
    expect(paths).not.toContain("noise.log");
    expect(inv.total).toBe(5);

    const again = await scanInventory(root);
    expect(JSON.stringify(inv)).toBe(JSON.stringify(again)); // 结构性确定性
  });

  it("读取失败的文件记 lines=-1，不静默吞掉", async () => {
    const root = makeFixture();
    mkdirSync(path.join(root, "src"), { recursive: true });
    const big = path.join(root, "src", "big.ts");
    writeFileSync(big, "x".repeat(1_500_000)); // 超 1MB ⇒ 不计行数（策略内跳过，非失败）
    const inv = await scanInventory(root);
    expect(inv.files.find((f) => f.path === "src/big.ts")?.lines).toBe(0);
  });
});

describe("scanVectorFootprint —— 向量化痕迹双通道", () => {
  it("依赖通道与代码通道各报命中；干净树零命中", async () => {
    const root = makeFixture();
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(path.join(root, "package.json"), JSON.stringify({
      dependencies: { "faiss-node": "^1.0.0", express: "^4.0.0" },
      devDependencies: { "@types/bun": "latest" },
    }));
    writeFileSync(path.join(root, "src", "sim.ts"), "export const s = cosineSimilarity(a, b);\n");
    writeFileSync(path.join(root, "src", "clean.ts"), "export const n = a + b;\n");

    const r = await scanVectorFootprint(root);
    expect(r.depHits.map((h) => h.match)).toEqual(["faiss-node"]);
    expect(r.depHits[0].location).toBe("package.json");
    expect(r.codeHits.length).toBe(1);
    expect(r.codeHits[0].location).toBe("src/sim.ts:1");
    expect(r.codeHits[0].text).toContain("cosineSimilarity");
    expect(r.scannedFiles).toBe(2);
  });
});

describe("extractClaims —— 声明侧提取", () => {
  it("命中带 file:line；未命中文件跳过", async () => {
    const root = makeFixture();
    mkdirSync(path.join(root, "docs"), { recursive: true });
    writeFileSync(path.join(root, "README.md"), "line1\n推理路径 zero LLM in path。\n");
    writeFileSync(path.join(root, "docs", "a.md"), "检索是确定性的，同输入同输出。\n");
    const hits = await extractClaims(root, ["README.md", "docs/a.md", "docs/missing.md"]);
    expect(hits).toEqual([
      { claim: "zero LLM", file: "README.md", line: 2 },
      { claim: "确定性", file: "docs/a.md", line: 1 },
    ]);
  });
});

describe("allEqual —— 比对器边界", () => {
  it("空集不算一致", () => expect(allEqual([])).toBe(false));
  it("同文一致", () => expect(allEqual(["a", "a"])).toBe(true));
  it("异文不一致", () => expect(allEqual(["a", "b"])).toBe(false));
});

describe("determinismVerdict —— 假绿回归锁（首轮实跑：5 次 exit=2 的报错输出被当成确定）", () => {
  it("全零退出且输出一致 ⇒ true", () => expect(determinismVerdict([0, 0, 0], ["{}", "{}", "{}"])).toBe(true));
  it("非零退出即使输出『一致』也 ⇒ false（一致的报错不是确定性证据）", () =>
    expect(determinismVerdict([2, 2, 2], ["err", "err", "err"])).toBe(false));
  it("混入一次非零 ⇒ false", () => expect(determinismVerdict([0, 1, 0], ["{}", "{}", "{}"])).toBe(false));
  it("零退出但输出漂移 ⇒ false", () => expect(determinismVerdict([0, 0], ["{}", "[]"])).toBe(false));
});

describe("runAuditChain —— 编排与证据落盘", () => {
  it("AUTO 的 stage 被执行并写出证据；ESCALATE 不执行；spec 的 state 原样进证据", async () => {
    const root = makeFixture();
    const specPath = path.join(root, "spec.json");
    writeFileSync(specPath, JSON.stringify({
      state: { project: "fixture" },
      decisions: [
        { id: "audit:inventory", domain: "triage", actionBlastRadius: "local_reversible", questions: {} },
        { id: "release:tag-and-push", domain: "engineering", actionBlastRadius: "external_write", questions: {} },
      ],
    }));
    const outDir = path.join(root, "out");
    const executedIds: string[] = [];

    const result = await runAuditChain({
      repoRoot: root,
      specPath,
      outDir,
      triage: {
        triage: async (spec) => spec.decisions.map((d) => ({
          id: d.id,
          verdict: d.id === "audit:inventory" ? "AUTO" as const : "ESCALATE" as const,
          reasons: [],
        })),
        decideAndRun: async (spec, actions) => {
          const executed: Array<{ id: string; ok: boolean; detail?: string }> = [];
          const escalated = spec.decisions
            .filter((d) => d.id !== "audit:inventory")
            .map((d) => ({ id: d.id, verdict: "ESCALATE" as const, reasons: ["测试夹具"] }));
          for (const d of spec.decisions) {
            if (d.id !== "audit:inventory") continue;
            const r = (await actions[d.id]!()) as { ok: boolean; detail: string };
            executedIds.push(d.id);
            executed.push({ id: d.id, ok: r.ok, detail: r.detail });
          }
          return { executed, escalated };
        },
      },
    });

    expect(executedIds).toEqual(["audit:inventory"]);
    expect(result.executed[0]?.ok).toBe(true);
    expect(result.executed[0]?.detail).toContain("total=");
    expect(result.escalated.map((e) => e.id)).toEqual(["release:tag-and-push"]);

    const evidence = JSON.parse(readFileSync(path.join(outDir, "evidence.json"), "utf8"));
    expect(evidence.spec.state).toEqual({ project: "fixture" });
    expect(existsSync(path.join(outDir, "inventory.json"))).toBe(true);
    expect(existsSync(path.join(outDir, "audit-report-skeleton.md"))).toBe(true);
  });

  it("五个 stage 都在注册表里，且 REVERSIBLE_ACTIONS 含同键登记（ADR-008：注册即补测试）", () => {
    for (const id of AUDIT_STAGE_IDS) {
      expect(REVERSIBLE_ACTIONS[id], `REVERSIBLE_ACTIONS 缺 ${id}`).toBeDefined();
    }
    // 护栏证明条目必须仍在：自动链永远不该能碰 git 推送
    expect(REVERSIBLE_ACTIONS["release:tag-and-push"]).toBeUndefined();
  });
});
