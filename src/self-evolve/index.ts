/**
 * Self-evolve 模块入口。
 *
 * 默认工厂 createDefaultSelfEvolve()：
 *   - think   → router.executeWithRole("general-chat")：模型/密钥由用户配置，动态分配、fallback、熔断；
 *   - store   → vault 持久化教训（00-Meta/self-evolve/lessons/）+ 内存索引；
 *               首次 list() 自动回读 vault 已持久化教训（跨进程闭环）；
 *   - retrieve→ 不注入时引擎自动检索自身知识库（store.list）；调用方可注入 web/向量/知识库检索器。
 */

import { router } from "../services/router.js";
import { SelfEvolveEngine, stableHash } from "./engine.js";
import type { SelfEvolveDeps } from "./types.js";

export { SelfEvolveEngine, applySelfThought, startSelfThought, attachSelfThought, formatSelfThought, tokenize, stableHash } from "./engine.js";
export { MindAdvisor, createMindAdvisor, type MindAdvisorOptions, type MindSuggestResult } from "./mind-suggest.js";
export type {
  EvidenceSource,
  Improvement,
  ImproveFeedback,
  ImproveRequest,
  Induction,
  Message,
  SelfEvolveDeps,
  SelfThought,
  SelfThinkRequest,
  TaskTrace,
} from "./types.js";

const LESSON_PREFIX = "00-Meta/self-evolve/lessons";
const REFLECTION_TEMPERATURE = 0.3;

/** store 所需的 vault 最小能力（写 / 枚举 / 读）：默认绑定全局 vault，测试可注入 fake。 */
export interface LessonVaultLike {
  writeNote(
    notePath: string,
    content: string,
    opts?: {
      title?: string;
      tags?: string[];
      type?: string;
      source?: string;
      confidence?: number;
      paraCategory?: "meta";
    }
  ): Promise<unknown>;
  readNote(notePath: string): { content: string } | null;
  getEngine(): { listNotePaths(): string[] };
}

/** 默认 vault 提供方：惰性动态导入全局单例，失败返回 null（不阻断）。 */
async function defaultLessonVault(): Promise<LessonVaultLike | null> {
  try {
    const { getGlobalVault } = await import("../memory/vault-manager.js");
    return getGlobalVault();
  } catch {
    return null;
  }
}

/** 从笔记正文提取教训文本（写路径落盘格式：内置 frontmatter + "# Lesson" 标题）。 */
function extractLessonText(noteBody: string): string | null {
  const marker = "# Lesson";
  const idx = noteBody.indexOf(marker);
  if (idx === -1) return null;
  const text = noteBody.slice(idx + marker.length).trim();
  return text || null;
}

/** 扫描 vault 已持久化教训回填内存索引（跨进程闭环，审计 B2-M2）；单文件失败不阻断。 */
export async function restoreLessonsFromVault(
  lessons: Map<string, string>,
  vault: LessonVaultLike
): Promise<void> {
  let paths: string[];
  try {
    paths = vault.getEngine().listNotePaths();
  } catch {
    return;
  }
  for (const p of paths) {
    if (!p.startsWith(`${LESSON_PREFIX}/`)) continue;
    try {
      const note = vault.readNote(p);
      if (!note) continue;
      const lesson = extractLessonText(note.content);
      if (!lesson) continue;
      // 去重键与运行时写入同源（stableHash(lesson)），回读后重写同教训不会重复
      const key = stableHash(lesson);
      if (!lessons.has(key)) lessons.set(key, lesson);
    } catch {
      // 单个文件读取/解析失败不阻断整体回读
    }
  }
}

/** 默认 store：内存索引 + vault 持久化（写）+ 首次 list() 从 vault 回读（跨进程闭环）。 */
export function createDefaultStore(
  getVault: () => Promise<LessonVaultLike | null> = defaultLessonVault
): NonNullable<SelfEvolveDeps["store"]> {
  const lessons = new Map<string, string>();
  const MAX_LESSONS = 200;
  let restored = false;
  return {
    write: async (lesson: string): Promise<void> => {
      const hash = stableHash(lesson);
      lessons.set(hash, lesson);
      // 内存索引有上限：超出时淘汰最早插入（LRU 近似），vault 持久化不受影响
      if (lessons.size > MAX_LESSONS) {
        const oldest = lessons.keys().next().value;
        if (oldest !== undefined) lessons.delete(oldest);
      }
      try {
        const vault = await getVault();
        if (!vault) return;
        const date = new Date().toISOString().slice(0, 16).replace(/[T:]/g, "-");
        // 完整 stableHash（8 hex）作文件名：内存去重/回读键都是完整 hash，截断 6 位会让
        // hash 前 6 位相同的两个教训写到同一文件互相覆盖（教训静默丢失）
        const path = `${LESSON_PREFIX}/${date}-${hash}.md`;
        await vault.writeNote(
          path,
          [
            "---",
            `type: self-evolve-lesson`,
            `created: ${new Date().toISOString()}`,
            "tags: [self-evolve, auto-generated]",
            "---",
            "",
            "# Lesson",
            "",
            lesson,
            "",
          ].join("\n"),
          {
            title: `Lesson ${hash.slice(0, 8)}`,
            tags: ["self-evolve", "auto-generated"],
            type: "self-evolve-lesson",
            paraCategory: "meta",
            source: "self-evolve",
            confidence: 0.9,
          }
        );
      } catch {
        // vault 不可用时仅保留内存索引，不阻断
      }
    },
    list: async (): Promise<string[]> => {
      // 惰性首次回读：新进程内存索引为空时，从 vault 恢复已持久化教训（写↔读闭环）
      if (!restored) {
        restored = true;
        try {
          const vault = await getVault();
          if (vault) await restoreLessonsFromVault(lessons, vault);
        } catch {
          // 回读失败不阻断
        }
      }
      return [...lessons.values()];
    },
  };
}

/** 默认引擎：router + vault 知识库，无任何硬编码模型名/密钥。 */
export function createDefaultSelfEvolve(): SelfEvolveEngine {
  return new SelfEvolveEngine({
    think: async (messages) => {
      const response = await router.executeWithRole("general-chat", messages, {
        temperature: REFLECTION_TEMPERATURE,
      });
      return response.content ?? "";
    },
    store: createDefaultStore(),
  });
}

let _defaultEngine: SelfEvolveEngine | null = null;

/** 默认引擎单例（chat 路由 / orchestrator 接入点共用，惰性创建）。 */
export function getDefaultSelfEvolve(): SelfEvolveEngine {
  if (!_defaultEngine) _defaultEngine = createDefaultSelfEvolve();
  return _defaultEngine;
}

/** Test seam：重置单例。 */
export function _resetDefaultSelfEvolveForTest(): void {
  _defaultEngine = null;
}
