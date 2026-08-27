/**
 * Self-evolve 模块入口。
 *
 * 默认工厂 createDefaultSelfEvolve()：
 *   - think   → router.executeWithRole("general-chat")：模型/密钥由用户配置，动态分配、fallback、熔断；
 *   - store   → vault 持久化教训（00-Meta/self-evolve/lessons/）+ 内存索引；
 *   - retrieve→ 不注入时引擎自动检索自身知识库（store.list）；调用方可注入 web/向量/知识库检索器。
 */

import { router } from "../services/router.js";
import { SelfEvolveEngine, stableHash } from "./engine.js";
import type { SelfEvolveDeps } from "./types.js";

export { SelfEvolveEngine, applySelfThought, formatSelfThought, tokenize, stableHash } from "./engine.js";
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

function createDefaultStore(): SelfEvolveDeps["store"] {
  const lessons = new Map<string, string>();
  const MAX_LESSONS = 200;
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
        const { getGlobalVault } = await import("../memory/vault-manager.js");
        const date = new Date().toISOString().slice(0, 16).replace(/[T:]/g, "-");
        const path = `${LESSON_PREFIX}/${date}-${hash.slice(0, 6)}.md`;
        await getGlobalVault().writeNote(
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
    list: async (): Promise<string[]> => [...lessons.values()],
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
