/**
 * 架构守卫：Laya 决策链只服务**开发流程**，不得进入项目运行时热路径（2026-09-28 方向修正）
 *
 * 背景：src/decision/{laya-http,laya-triage,audit-chain}.ts 是开发流程决策链
 * （decide:laya CLI / audit:chain，ADR-008，见 skills/laya-local-decision-model），
 * 服务开发期分诊/审计/批量核查。它们不是运行时组件：per-message 热路径（风险初筛/
 * 意图分类/记忆/知识检索）不得引用——4-5 QPS CPU 推理无容量纪律，confidence 未校准
 * 无语义依据。运行时的灰区初筛/显著性等由 src/local-llm（默认全关）与规则路径承担。
 *
 * 三条边界：
 *   R1 src/ 下除 decision 自链外，任何文件不得 import Laya 链模块
 *   R2 运行时灰区初筛归 local-llm（decision/risk-screen 这类运行时适配层不得存在）
 *   R3 package.json 生命周期脚本（start/dev/test）不得挂 Laya（只允许显式 CLI）
 */
import { describe, it, expect } from "bun:test";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const LAYA_CHAIN_FILES = ["laya-http", "laya-triage", "audit-chain", "laya-cli"];

function* walk(dir: string): Generator<string> {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === "dist") continue;
      yield* walk(p);
    } else if (name.endsWith(".ts")) {
      yield p;
    }
  }
}

/** 判定一次 import 是否指向 Laya 链模块（相对/别名/裸路径/无空格/副作用/require/.ts 变体都算） */
function importsLayaChain(code: string, importerRel: string): boolean {
  const inDecisionSelfChain = importerRel.startsWith("src/decision/");
  // from"..." 无空格 | from "..." 常规 | import "..."/import("...") 副作用与动态 | require("...")
  const re = /from\s*["']([^"']+)["']|import\s*\(?\s*["']([^"']+)["']|require\(\s*["']([^"']+)["']\s*\)/g;
  for (const m of code.matchAll(re)) {
    const spec = (m[1] ?? m[2] ?? m[3] ?? "").replace(/(\.js|\.ts)+(\?[^"']*)?$/, "");
    const base = spec.split("/").pop() ?? spec;
    if (LAYA_CHAIN_FILES.some((f) => base === f)) {
      // decision 自链内部互引合法
      if (inDecisionSelfChain) continue;
      return true;
    }
  }
  return false;
}

describe("Laya 运行时隔离守卫（开发流程专用）", () => {
  it("R1: src/ 下除 decision 自链外不得 import Laya 链模块", () => {
    const offenders: string[] = [];
    for (const file of walk(join(ROOT, "src"))) {
      const rel = relative(ROOT, file).replaceAll("\\", "/");
      const text = readFileSync(file, "utf8");
      // 剥行注释（路径出现在注释里不算使用点，同 D7 引用形态纪律）
      const code = text.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
      if (importsLayaChain(code, rel)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("R1+: 检测器对绕过形态的自检（无空格/副作用/require/.ts 变体全部命中）", () => {
    const evasions = [
      'import { x } from"./laya-http.js";',
      'import "./laya-http.js";',
      'const m = require("./laya-http.js");',
      'import { x } from "../decision/laya-http.ts";',
      'import { x } from "./laya-http.js.js";',
      'await import("./decision/laya-triage.js");',
    ];
    for (const code of evasions) {
      expect(importsLayaChain(code, "src/agents/somewhere.ts")).toBe(true);
    }
    // decision 自链内部互引合法
    expect(importsLayaChain('import { layaHealth } from "./laya-http.js";', "src/decision/laya-cli.ts")).toBe(false);
    // 注释中的路径不算使用点
    expect(importsLayaChain('// see src/decision/laya-http.js', "src/agents/somewhere.ts")).toBe(false);
  });

  it("R2: 运行时灰区初筛归 local-llm/risk-screen；decision/ 下不得有运行时适配层", () => {
    expect(existsSync(join(ROOT, "src", "local-llm", "risk-screen.ts"))).toBe(true);
    expect(existsSync(join(ROOT, "src", "decision", "risk-screen.ts"))).toBe(false);
  });

  it("R3: 生命周期脚本不挂 Laya（开发流程显式 CLI 白名单除外）", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const layaScripts = Object.entries(pkg.scripts ?? {})
      .filter(([k, v]) => /laya/i.test(`${k}${v}`))
      .map(([k]) => k);
    // R3 口径：scripts 键中含 laya 的必须是白名单内的显式 CLI（防生命周期脚本暗挂）
    // 白名单 = 开发流程显式 CLI（分诊/审计链/标定），全部人工发起、不进自动化生命周期
    for (const k of layaScripts) {
      expect(["decide:laya", "audit:chain", "calibrate:laya"]).toContain(k);
    }
  });
});
