/**
 * ADR-012 §3.1 门禁：外围组件不得直连『核心内部』（统一 API 管理，防更新打挂外围）。
 *
 * 规则：`src/dre/**` 里只有**契约面**允许被外围 import —— `src/dre/port/**`（端口协议）
 * 与 `src/dre/host.ts`（客户端接口持有槽）；其余（engine/kernel/runtime/桶 index/factory/…）
 * 均属"核心内部"，外围只能经契约面或 daemon HTTP 访问。
 *
 * 本门是**棘轮**（仿 outbound-fetch-ratchet）：把既有耦合冻结在
 * `config/periphery-core-boundary-baseline.json`，**只拦增量**；收敛后须同步下调在册项
 * （陈旧在册项也会红）。这样"存量"不阻塞，而"新耦合"必被看见。
 */
import { describe, test, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const ROOT = path.resolve(import.meta.dir, "../..");
const baseline = JSON.parse(fs.readFileSync(path.join(ROOT, "config/periphery-core-boundary-baseline.json"), "utf8")) as {
  allowedCoreSurfaces: string[];
  peripheryDirs: string[];
  sites: Array<{ file: string; imports: string[] }>;
};

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

/** 抽出文件里所有 import 的模块 specifier（静态 `from "..."` + 动态 `import("...")`） */
function importSpecifiers(src: string): string[] {
  const out: string[] = [];
  const sf = ts.createSourceFile("probe.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      // `import type { … }` 运行时被擦除，不构成"更新打挂外围"的**运行期**耦合，故不计。
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

/** specifier 解析为仓库相对 .ts 路径；非相对（裸包）返回 null */
function resolveToRepo(file: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const abs = path.resolve(ROOT, path.dirname(file), spec);
  return toPosix(path.relative(ROOT, abs)).replace(/\.js$/, ".ts");
}

const allowed = (rel: string): boolean => baseline.allowedCoreSurfaces.some((p) => rel === p || rel.startsWith(p));

/** 扫描得到 { file -> [核心内部 import] }（已排除契约面与在册豁免） */
function scanCoupling(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const dir of baseline.peripheryDirs) {
    for (const file of walkTs(dir)) {
      const src = fs.readFileSync(path.join(ROOT, file), "utf8");
      const hits = importSpecifiers(src)
        .map((s) => resolveToRepo(file, s))
        .filter((r): r is string => !!r && r.startsWith("src/dre/") && !allowed(r))
        .sort();
      if (hits.length) found.set(file, [...new Set(hits)]);
    }
  }
  return found;
}

describe("ADR-012 外围↔核心边界门（存量在册，只拦增量）", () => {
  const baselineMap = new Map(baseline.sites.map((s) => [s.file, [...s.imports].sort()]));

  test("判据自证：契约面（src/dre/port、src/dre/host.ts）不被判违规", () => {
    expect(allowed("src/dre/port/index.ts")).toBe(true);
    expect(allowed("src/dre/host.ts")).toBe(true);
    expect(allowed("src/dre/runtime/scheduler.ts")).toBe(false);
    expect(allowed("src/dre/index.ts")).toBe(false);
  });

  test("扫描文件集 == 在册文件集（新增耦合文件必须先登记再合并）", () => {
    const scanned = [...scanCoupling().keys()].sort();
    const registered = [...baselineMap.keys()].sort();
    expect(scanned).toEqual(registered);
  });

  test("每个文件的核心内部 import 与在册完全相等（棘轮只允许同步变短）", () => {
    const found = scanCoupling();
    const drift: string[] = [];
    for (const [file, imports] of baselineMap) {
      const got = found.get(file) ?? [];
      if (JSON.stringify(got) !== JSON.stringify(imports)) drift.push(`${file} 在册=[${imports.join(", ")}] 实测=[${got.join(", ")}]`);
    }
    if (drift.length) console.log("[periphery-core-boundary] 漂移：\n" + drift.join("\n"));
    expect(drift).toEqual([]);
  });
});
