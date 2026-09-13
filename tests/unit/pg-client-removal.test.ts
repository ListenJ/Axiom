import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

describe("pg-client-removal H-M1-03", () => {
  test("grep pg-client src/ 命中应为 0 (含动态 import)", () => {
    // 审计修复（可移植性 + 有效性）：原实现首选
    //   execSync('rg -n "pg-client" src --glob "*.ts" --no-heading 2>nul | find /c /v ""')
    // 这是**纯 Windows** 写法，在 Linux/macOS 上有两个后果：
    //   1) `2>nul` 不是重定向而是**创建一个名为 `nul` 的文件** —— 实测每次跑测试都会
    //      在仓库根目录留下它，内容为 `/bin/sh: 1: rg: not found`；
    //   2) `find /c /v ""` 是 Windows 的 find.exe，Linux 上的 find 语义完全不同，
    //      整条命令会"成功"返回空串，被下一行当成 "0" ⇒ **断言空转通过**，
    //      即该检查在 Linux 上从未真正执行过（假阴性）。
    // 现改为纯 Node 文件遍历：无 shell、无外部命令、跨平台，且真正读取文件计数。
    const { readdirSync } = require("fs");
    let count = 0;
    function walk(dir: string) {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === "node_modules" || e.name === ".git") continue;
          walk(p);
        } else if (e.name.endsWith(".ts")) {
          if (readFileSync(p, "utf8").includes("pg-client")) count++;
        }
      }
    }
    walk("src");
    expect(count).toBe(0);
  });

  test("src/db/pg-client.ts 应已删除", () => {
    expect(existsSync("src/db/pg-client.ts")).toBe(false);
  });

  test("docs/ARCHITECTURE.md:58 不应再声称 PG 完全移除与文件残留矛盾，应为 PG 可选/已迁移或 SQLite 唯一且无 pg-client 残留说明", () => {
    const arch = readFileSync("docs/ARCHITECTURE.md", "utf8");
    // 旧文案 "PostgreSQL 已完全移除, SQLite 是唯一数据库" 若保留则必须无 pg-client 文件；新文案应说明 PG 可选/已迁移
    // 只要 grep 为 0 且文件已删，旧文案亦可接受；此处仅确保不再出现矛盾：若旧文案保留则 pg-client 必须不存在（上一测试已保证）
    // 额外断言：文档中若提及 PostgreSQL，应明确其状态（可选/已迁移/仅 schema 保留）而非简单矛盾
    // 最小断言：文档存在且包含数据库章节
    expect(arch.includes("数据库")).toBe(true);
    // 审计整改 R1（2026-08-24）：pg-client.ts 已删，旧绝对化文案失去存在许可；
    // 文档必须使用"可选/迁移/历史/归档"等新口径描述 PG 状态。
    const hasOld = arch.includes("PostgreSQL 已完全移除");
    const hasNew = arch.includes("可选") || arch.includes("迁移") || arch.includes("历史") || arch.includes("归档") || arch.includes("pgvector 可选");
    expect(hasNew).toBe(true);
    expect(hasOld).toBe(false);
  });
});
