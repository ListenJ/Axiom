/**
 * Vault 索引新鲜度判定（2026-10-19 从 vault-manager 抽出）。
 *
 * 背景：`VaultManager.reindexAll()` 原先仅凭 **vault 目录 mtime** 判断是否需要重建引擎索引。
 * 该启发式有两个真实缺陷（已实测）：
 *   1. 目录 mtime 与上次记录相同时（NTFS 目录时间戳惰性更新 / 粗粒度文件系统），
 *      文件**删除**不会被发现 → 引擎仍返回已删路径 → 删除清理不触发 → FTS/反链残留；
 *   2. 文件**原地编辑**不改变目录条目 → 目录 mtime 常不变 → wiki 出链不重算 → 反链陈旧。
 *
 * 因此本模块把判定升级为两层：目录 mtime 差异（快路径） + 对索引已知笔记逐条 `stat` 核对
 * （文件消失或 mtime 变化均判为需要重建）。第二层只在快路径认为"未变"时执行，
 * 173 文件量级实测 1~3ms，远小于一次全量重建的 100ms+。
 *
 * 抽成独立模块的原因：让这条正确性判据有唯一实现点、可单测，且避免 vault-manager 继续变胖
 * （仓库有"单文件不超过 1000 行"的结构门禁）。
 */
import fs from "node:fs";
import path from "node:path";

export interface IndexFreshnessInput {
  /** vault 根目录绝对路径 */
  vaultPath: string;
  /** 本次 `fs.statSync(vaultPath).mtimeMs` */
  currentDirMtimeMs: number;
  /** 上一次成功 reload 时记录的目录 mtime（首次为 undefined） */
  lastDirMtimeMs: number | undefined;
  /** 已索引笔记的相对路径 → 上次索引时观测到的文件 mtime */
  indexedMtimes: ReadonlyMap<string, number>;
}

/**
 * 是否需要重建引擎索引。
 *
 * @returns true = 需要 `engine.reload()`；false = 可安全跳过全量重建。
 */
export function shouldReloadIndex(input: IndexFreshnessInput): boolean {
  if (input.currentDirMtimeMs !== input.lastDirMtimeMs) return true;

  for (const [relPath, prevMtime] of input.indexedMtimes) {
    try {
      const stat = fs.statSync(path.join(input.vaultPath, relPath));
      // 与 reindexAll 增量逻辑的容差保持一致（1ms 内视为未变，防浮点抖动）
      if (Math.abs(stat.mtimeMs - prevMtime) >= 1) return true;
    } catch {
      // 文件已消失（被删除）：必须重建，否则删除永远不会被发现
      return true;
    }
  }
  return false;
}

/**
 * 删除已消失的笔记并返回删除条数。
 *
 * `known` 必须同时包含**本地增量登记表**与**数据库已知路径**：`writeNote` 落盘的笔记
 * 不一定出现在增量登记表里，若只按登记表做差集，这类笔记被外部删除后会留下幽灵行
 * （FTS 与 wiki 反链都指向一个已不存在的文件）。
 */
export function applyDeletedPaths(
  known: Iterable<string>,
  currentSet: ReadonlySet<string>,
  deleteNote: (path: string) => boolean,
  forget: (path: string) => void,
): number {
  let deleted = 0;
  for (const prevPath of known) {
    if (currentSet.has(prevPath)) continue;
    try {
      if (deleteNote(prevPath)) deleted++;
    } catch {
      /* 单条删除失败不阻断其余清理 */
    }
    forget(prevPath);
  }
  return deleted;
}
