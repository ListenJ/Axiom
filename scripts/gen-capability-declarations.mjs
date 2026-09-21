/**
 * 工具能力声明登记表生成器（单一事实源）
 *
 * 抽取器与渲染器在 `src/testing/tool-declarations.ts`；`tests/doc-contract.test.ts` 的 D10 门
 * 要求仓库里的 `docs/security/tool-capability-declarations.md` 与本脚本 `--write` 的结果逐字一致，
 * 因此文档里不可能出现手抄的声明数或判据。
 *
 * 用法：
 *   - `bun run scripts/gen-capability-declarations.mjs` —— 只打印统计，不改文件
 *   - `bun run scripts/gen-capability-declarations.mjs --write` —— 重写登记表文档
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectToolDeclarations, renderDeclarationsDoc } from "../src/testing/tool-declarations.ts";

// 尾斜杠必须剥掉：抽取器按 `root.length + 1` 截相对路径，带斜杠会削掉首字符。
const root = fileURLToPath(new URL("..", import.meta.url)).replace(/\/+$/, "");
const docPath = join(root, "docs", "security", "tool-capability-declarations.md");
const rows = collectToolDeclarations(root);

if (process.argv.includes("--write")) {
  mkdirSync(dirname(docPath), { recursive: true });
  writeFileSync(docPath, renderDeclarationsDoc(rows), "utf8");
  console.log(`已写入 ${docPath.replace(root + "/", "")}`);
}

const bundled = new Set(rows.filter((r) => r.bundle).map((r) => r.file));
const literal = rows.filter((r) => r.nameKind === "literal" && !r.bundle);
const procExec = literal.filter((r) => r.capability.includes("proc.exec"));
console.log(
  JSON.stringify(
    {
      固定名注册: literal.length,
      动态名注册: rows.filter((r) => r.nameKind === "dynamic" && !r.bundle).length,
      打包产物: [...bundled].sort(),
      声明ProcExec: procExec.length,
      目标由实现固定: procExec.filter((r) => r.payloadFieldsText.includes("fixed")).length,
      未声明能力: literal.filter((r) => r.capability.length === 0).length,
      schema不可静态核: literal.filter((r) => r.inputFields === null).length,
      输出文件: docPath,
    },
    null,
    2,
  ),
);
