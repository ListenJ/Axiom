/**
 * MCP 工具计数（权威静态统计）
 *
 * 背景：docs 多处宣称的工具数（历史 133/150/173/172）与实际注册不符，
 * 且旧验证脚本 scripts/count-tools.mjs 已不存在、验证测试为硬编码同义反复。
 * 本模块按 README 权威口径扫描：
 *   - src/mcp/server/*.ts + src/mcp/register-external-tools.ts 的 registry.add 字面名
 *   - src/mcp/server.ts 内联注册 + 经 adaptTool 注册的 3 个基础工具（read/write/query）
 * 输出去重总数、重复名与分文件明细，供文档一致性测试与 CI 使用。
 */
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

export interface ToolCountResult {
  /** 去重后的工具总数 */
  total: number;
  /** 字面 name 提取总数（未去重） */
  literalCount: number;
  /** 重复注册名 */
  duplicates: string[];
  /** 分文件字面名数量 */
  breakdown: Record<string, number>;
}

const NAME_LINE_RE = /^\s*name:\s*"([a-z][a-z0-9_]*)",?\s*$/;

function collectNamesFromFile(path: string): string[] {
  const content = readFileSync(path, "utf8");
  const names: string[] = [];
  for (const line of content.split("\n")) {
    const m = line.match(NAME_LINE_RE);
    if (m) names.push(m[1]);
  }
  return names;
}

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listTsFiles(p));
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

/** 统计当前仓库实际注册的 MCP 工具总数 */
export function countMcpTools(rootDir: string = process.cwd()): ToolCountResult {
  const mcpDir = join(rootDir, "src", "mcp");
  const files = [
    ...listTsFiles(join(mcpDir, "server")),
    join(mcpDir, "server.ts"),
    join(mcpDir, "register-external-tools.ts"),
    // adaptTool 注册的三个基础工具
    join(rootDir, "src", "tools", "read-tool.ts"),
    join(rootDir, "src", "tools", "write-tool.ts"),
    join(rootDir, "src", "tools", "query-tool.ts"),
  ].filter((f) => {
    try {
      readdirSync(join(f, ".."));
      return true;
    } catch {
      return false;
    }
  });

  const all: string[] = [];
  const breakdown: Record<string, number> = {};
  for (const f of files) {
    const names = collectNamesFromFile(f);
    if (names.length === 0) continue;
    const rel = f.slice(rootDir.length + 1);
    breakdown[rel] = names.length;
    all.push(...names);
  }

  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const n of all) {
    if (seen.has(n)) dup.add(n);
    seen.add(n);
  }

  return {
    total: seen.size,
    literalCount: all.length,
    duplicates: [...dup],
    breakdown,
  };
}
