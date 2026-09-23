/**
 * dist/ 产物清单（CHECKSUMS.txt）的唯一实现。
 *
 * 为什么要抽出来：清单原先只在 `build:matrix` 末尾生成，而 Linux 包由
 * `package:linux` 单独产出 —— 按 ADR-009 的文档顺序跑完打包，三种包**根本不在清单里**，
 * 收件人无从校验。两个入口都要刷新同一份清单，就不允许各写一份哈希逻辑。
 */
import { createHash } from "crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const MANIFEST = "CHECKSUMS.txt";

function collectFiles(dir: string, base: string = dir): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFiles(fullPath, base));
    } else if (entry.isFile() && path.relative(base, fullPath) !== MANIFEST) {
      // 清单不得给自己记账：那会把上一版清单的哈希写进本版，收件人无从校验
      results.push(path.relative(base, fullPath).replace(/\\/g, "/"));
    }
  }
  return results;
}

/** 扫描 distDir 生成 SHA256 清单；返回被记账的文件数，dist 不存在或为空时返回 0。 */
export function generateChecksums(distDir: string): number {
  if (!existsSync(distDir)) {
    console.log("\n[checksums] dist/ 不存在，跳过校验和生成");
    return 0;
  }
  const files = collectFiles(distDir).sort();
  if (files.length === 0) {
    console.log("\n[checksums] dist/ 为空，跳过校验和生成");
    return 0;
  }
  const lines: string[] = [`# axiom-agent build checksums`, `# generated: ${new Date().toISOString()}`, ``];
  for (const relPath of files) {
    const hash = createHash("sha256").update(readFileSync(path.join(distDir, relPath))).digest("hex");
    lines.push(`${hash}  ${relPath}`);
  }
  writeFileSync(path.join(distDir, MANIFEST), lines.join("\n") + "\n", "utf-8");
  console.log(`\n[checksums] 已生成 ${path.join(distDir, MANIFEST)}（${files.length} 个文件）`);
  return files.length;
}
