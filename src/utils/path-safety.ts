/**
 * 路径围栏守卫（P0-1，2026-08-29）— 唯一围栏语义源。
 * 原位于 src/mcp/tools/filesystem.ts；为消除 tools<->mcp 循环依赖迁至 utils 叶子层，
 * filesystem.ts 经 re-export 保持兼容。
 */
import * as fsSync from "node:fs";
import * as path from "node:path";
import { logger } from "./logger.js";

/**
 * 唯一 containment 原语（T3，2026-09-18）：`target` 是否落在 `base` 目录之内。
 *
 * 背景：本判定在本仓库被重复实现过 6 处（platform.escapesBase、db-guard.validatePath、
 * document-ingest.isWithinAnyRoot、terminal.isCwdWithinWorkspace、
 * skill-tools.resolveSkillPath、vision 内联），"唯一围栏语义源"的自我描述当时并不成立。
 * 现统一到此处，其余各处只保留薄包装。
 *
 * 跨平台要点（沿用历史 lessons learned，语义与重构前逐项一致）：
 *   - Windows 下 `path.relative("D:\\proj", "C:\\Users")` 返回**绝对路径**而非 `".."`，
 *     只查 `startsWith("..")` 会被绕过 → 必须同时查 `path.isAbsolute`。
 *   - 二者均为绝对路径时按 `path.resolve` 归一化后比较。
 *
 * 已知过度严格（**沿用旧行为，本轮不修**）：base 内名为 `..foo` 的目录会被判为逃逸
 * （因为 `"..foo".startsWith("..")` 为真）。收紧/放宽它属安全语义变更，需单独评审。
 */
export function isWithinBase(base: string, target: string): boolean {
  const rel = path.relative(path.resolve(base), path.resolve(target));
  if (rel === '') return true;
  if (rel.startsWith('..') || rel === '..' || path.isAbsolute(rel)) return false;
  return true;
}

export function resolvePath(filePath: string): string {
  if (path.isAbsolute(filePath)) {
    return filePath;
  }
  return path.resolve(process.cwd(), filePath);
}

/**
 * 路径围栏守卫（P0-1，2026-08-29 起导出供 tools/read-tool、tools/write-tool 复用）：
 * 唯一围栏语义源——cwd 限制 + 敏感区域拒绝 + symlink realpath 校验。
 * 工具层不各自发明第二套围栏。
 */
export function isPathSafe(targetPath: string): { safe: boolean; error?: string } {
  try {
    const resolved = path.resolve(targetPath);
    const cwd = process.cwd();
    const relative = path.relative(cwd, resolved);

    // Check 1 + 2：containment 判定收敛到唯一原语 isWithinBase（".." 逃逸 / Windows 跨盘符）
    if (!isWithinBase(cwd, resolved)) {
      return {
        safe: false,
        error: `Path '${targetPath}' escapes working directory. Only paths within the project are allowed.`,
      };
    }

    // 安全（2026-07-26 审查修复）：沙箱内敏感区域拒绝访问。
    // fs 工具沙箱根 = 仓库根，.env / 数据库 / git 元数据含密钥与运行状态，
    // 不得经 agent 工具读取或改写。
    const DENIED_SEGMENTS: Array<{ pattern: RegExp; label: string }> = [
      { pattern: /(^|[\\/])\.env([\\/].*)?$|(^|[\\/])\.env\.[^\\/]+$/i, label: ".env 密钥文件" },
      { pattern: /(^|[\\/])\.git([\\/]|$)/i, label: ".git 元数据" },
      { pattern: /(^|[\\/])data[\\/][^\\/]*\.db(-\w+)?$/i, label: "运行时数据库" },
      { pattern: /(^|[\\/])data[\\/]model-config\.json$/i, label: "模型密钥配置" },
    ];
    for (const { pattern, label } of DENIED_SEGMENTS) {
      if (pattern.test(relative)) {
        return { safe: false, error: `Path '${targetPath}' is in a denied area (${label}).` };
      }
    }

    // Check 3: resolve symlinks to prevent symlink-based traversal
    // A symlink within cwd could point outside cwd, bypassing the relative check above.
    // Only check if the path exists (writeFile to a new file won't exist yet).
    try {
      const realPath = fsSync.realpathSync(resolved);
      const realRelative = path.relative(cwd, realPath);
      if (realRelative.startsWith("..") || realRelative === ".." || path.isAbsolute(realRelative)) {
        return {
          safe: false,
          error: `Path '${targetPath}' resolves to a location outside the working directory (symlink escape).`,
        };
      }
    } catch {
      try {
        const parent = path.dirname(resolved);
        const realParent = fsSync.realpathSync(parent);
        const realRelative = path.relative(cwd, path.join(realParent, path.basename(resolved)));
        if (realRelative.startsWith("..") || realRelative === ".." || path.isAbsolute(realRelative)) {
          return {
            safe: false,
            error: `Path '${targetPath}' parent directory resolves outside the working directory (symlink parent escape).`,
          };
        }
      } catch (err) {
        // 守卫语义：目标路径与其父目录均无法 realpath（通常是尚未创建的新路径），
        // 此处保守放行（fail-open）而非拒绝——新建文件属合法场景；
        // 残余风险（父目录链上的 symlink 竞态）由 writeFile/moveFile 在
        // mkdir 后的 isPathSafe TOCTOU 重校验兜底。
        logger.debug("[Filesystem] isPathSafe parent realpath failed, allowing (fail-open)", {
          path: resolved,
          error: String(err),
        });
      }
    }

    return { safe: true };
  } catch {
    return { safe: false, error: "Invalid path" };
  }
}

