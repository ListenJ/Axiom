/**
 * ADR-013 内核/外围分域门：**内核不得依赖外围**（依赖倒置）。
 *
 * 依据（docs/decisions/ADR-013-kernel-periphery-partition.md）：高频率/大规模/在线延迟敏感的
 * 部分内聚进**内核**（性能取向）；外围是可选、边缘、I/O 密集、可后台的部分。二者依赖必须是
 * **外围 → 内核**单向；若内核依赖外围，说明职责被放错层（内核被"外围的实现细节"拖拽，更新外围
 * 会反噬内核），且会在热路径上引入不必要的耦合。
 *
 * 本门为**棘轮**：把既有 4 处（已知例外/待收敛）冻结在 `config/kernel-periphery-baseline.json`，
 * 只拦增量；收敛后须同步下调（陈旧在册项也红）。`import type` 运行时擦除，不计。
 */
import { describe, test, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const ROOT = path.resolve(import.meta.dir, "../..");
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config/kernel-periphery-baseline.json"), "utf8")) as {
  kernelDirs: string[]; peripheryDirs: string[]; sites: Array<{ file: string; imports: string[] }>;
};
const PERI = new Set(cfg.peripheryDirs);
const toPosix = (p: string) => p.split(path.sep).join("/");

function walkTs(dir: string, out: string[] = []): string[] {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return out;
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const full = path.join(abs, e.name);
    if (e.isDirectory()) walkTs(path.relative(ROOT, full), out);
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts") && !e.name.endsWith(".test.ts")) out.push(toPosix(path.relative(ROOT, full)));
  }
  return out;
}

function importSpecifiers(src: string): string[] {
  const out: string[] = [];
  const sf = ts.createSourceFile("probe.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!node.importClause?.isTypeOnly) out.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length >= 1 && ts.isStringLiteral(node.arguments[0])
    ) {
      out.push((node.arguments[0] as ts.StringLiteral).text);
    }
    node.forEachChild(visit);
  };
  sf.forEachChild(visit);
  return out;
}

function resolveToRepo(file: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const abs = path.resolve(ROOT, path.dirname(file), spec);
  return toPosix(path.relative(ROOT, abs)).replace(/\.js$/, ".ts");
}

function scan(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const k of cfg.kernelDirs) {
    for (const file of walkTs(`src/${k}`)) {
      const src = fs.readFileSync(path.join(ROOT, file), "utf8");
      const hits = importSpecifiers(src)
        .map((s) => resolveToRepo(file, s))
        .filter((r): r is string => !!r && r.startsWith("src/") && PERI.has(r.split("/")[1]))
        .sort();
      if (hits.length) found.set(file, [...new Set(hits)]);
    }
  }
  return found;
}

describe("ADR-013 内核↔外围分域门（内核不得依赖外围；存量在册，只拦增量）", () => {
  const baselineMap = new Map(cfg.sites.map((s) => [s.file, [...s.imports].sort()]));

  test("扫描文件集 == 在册文件集（内核新增对外围的依赖必须先登记）", () => {
    expect([...scan().keys()].sort()).toEqual([...baselineMap.keys()].sort());
  });

  test("每个内核文件对外围的依赖与在册完全相等（棘轮只允许同步变短）", () => {
    const found = scan();
    const drift: string[] = [];
    for (const [file, imports] of baselineMap) {
      const got = found.get(file) ?? [];
      if (JSON.stringify(got) !== JSON.stringify(imports)) drift.push(`${file} 在册=[${imports.join(", ")}] 实测=[${got.join(", ")}]`);
    }
    if (drift.length) console.log("[kernel-periphery] 漂移：\n" + drift.join("\n"));
    expect(drift).toEqual([]);
  });
});
