/**
 * 提示词优化器 v2.0 测试 —— 验证 src/agents/prompt-optimizer.ts
 *
 * GLM-4.7-flash 改写 + Skill 专家增强 + 三重闸门：
 *   输出校验（长度/非空/非照抄）→ 语言一致性（确定性）→ 忠实度判别
 * 任一闸门失败或依赖不可用都回退原文。通过 DI fake 测试，不访问真实 API。
 */
import { beforeEach, describe, test, expect } from "bun:test";
import {
  optimizePrompt,
  shouldSkipOptimization,
  detectOptimizationStrategy,
  resetPromptOptimizerCache,
  getPromptOptimizerMetrics,
  type PromptOptimizerDeps,
} from "../src/agents/prompt-optimizer.js";

// 优化结果缓存为进程内共享状态：每个用例前清空缓存与指标，保证用例相互独立
beforeEach(() => {
  resetPromptOptimizerCache();
});

const LONG_INPUT = "帮我分析一下这个项目的知识库检索模块的性能瓶颈在哪里，并给出优化建议";
const GOOD_REWRITE = "请分析本项目知识库检索模块的性能瓶颈，并给出可执行的优化建议。";

/** 构造 DI deps：rewrite 返回 rewriteTo，verify 返回 verifyResult */
function makeDeps(opts: {
  rewriteTo?: string | null;
  verifyResult?: boolean | null;
  skillContext?: string | null;
  rewriteThrows?: boolean;
}) {
  const calls = { rewrite: 0, verify: 0, matchSkill: 0 };
  let capturedSkillContext: string | null | undefined;
  const deps: PromptOptimizerDeps = {
    rewrite: async (_input: string, skillContext: string | null) => {
      calls.rewrite++;
      capturedSkillContext = skillContext;
      if (opts.rewriteThrows) throw new Error("GLM down");
      return opts.rewriteTo ?? null;
    },
    verify: async () => {
      calls.verify++;
      return opts.verifyResult === undefined ? true : opts.verifyResult;
    },
    matchSkill: () => {
      calls.matchSkill++;
      return opts.skillContext ?? null;
    },
  };
  return { deps, calls, getSkillContext: () => capturedSkillContext };
}

describe("shouldSkipOptimization", () => {
  test("短输入跳过", () => {
    expect(shouldSkipOptimization("你好")).toBe(true);
    expect(shouldSkipOptimization("ok 谢谢")).toBe(true);
  });

  test("含代码块跳过", () => {
    expect(shouldSkipOptimization("这段代码为什么报错 ```js\nconsole.log(x)\n``` 帮我看看")).toBe(true);
  });

  test("命令/斜杠前缀跳过", () => {
    expect(shouldSkipOptimization("$ npm run build 失败了")).toBe(true);
    expect(shouldSkipOptimization("/help 看看有什么命令可以用")).toBe(true);
  });

  test("普通长输入不跳过", () => {
    expect(shouldSkipOptimization(LONG_INPUT)).toBe(false);
  });
});

describe("optimizePrompt", () => {
  test("改写忠实时采用（rewrite+verify 各一次）", async () => {
    const { deps, calls } = makeDeps({ rewriteTo: GOOD_REWRITE, verifyResult: true });
    const result = await optimizePrompt(LONG_INPUT, deps);
    expect(calls.rewrite).toBe(1);
    expect(calls.verify).toBe(1);
    expect(result.changed).toBe(true);
    expect(result.text).toContain("性能瓶颈");
  });

  test("命中 skill 时上下文传给改写器", async () => {
    const { deps, getSkillContext } = makeDeps({
      rewriteTo: GOOD_REWRITE,
      verifyResult: true,
      skillContext: "【后端架构师】资深后端架构师人格...",
    });
    const result = await optimizePrompt(LONG_INPUT, deps);
    expect(result.changed).toBe(true);
    expect(getSkillContext()).toContain("后端架构师");
  });

  test("忠实度判别拒绝时回退原文", async () => {
    const { deps } = makeDeps({ rewriteTo: "请提供检索信息以便我帮助你。", verifyResult: false });
    const result = await optimizePrompt(LONG_INPUT, deps);
    expect(result.changed).toBe(false);
    expect(result.text).toBe(LONG_INPUT);
  });

  test("忠实度判别不可用（null）按不忠实回退（安全方向）", async () => {
    const { deps } = makeDeps({ rewriteTo: GOOD_REWRITE, verifyResult: null });
    const result = await optimizePrompt(LONG_INPUT, deps);
    expect(result.changed).toBe(false);
    expect(result.text).toBe(LONG_INPUT);
  });

  test("语言漂移被确定性检查拦截", async () => {
    const { deps, calls } = makeDeps({
      rewriteTo: "Please analyze the performance bottleneck of the knowledge base retrieval module.",
      verifyResult: true,
    });
    const result = await optimizePrompt(LONG_INPUT, deps);
    expect(result.changed).toBe(false);
    expect(result.text).toBe(LONG_INPUT);
    expect(calls.verify).toBe(0); // 语言闸门在忠实度判别之前
  });

  test("照抄原文视为未改写", async () => {
    const { deps } = makeDeps({ rewriteTo: LONG_INPUT, verifyResult: true });
    const result = await optimizePrompt(LONG_INPUT, deps);
    expect(result.changed).toBe(false);
    expect(result.text).toBe(LONG_INPUT);
  });

  test("改写器返回 null（GLM 链全失败）回退原文", async () => {
    const { deps } = makeDeps({ rewriteTo: null });
    const result = await optimizePrompt(LONG_INPUT, deps);
    expect(result.changed).toBe(false);
    expect(result.text).toBe(LONG_INPUT);
  });

  test("改写器抛异常回退原文", async () => {
    const { deps } = makeDeps({ rewriteThrows: true });
    const result = await optimizePrompt(LONG_INPUT, deps);
    expect(result.changed).toBe(false);
    expect(result.text).toBe(LONG_INPUT);
  });

  test("改写返回空内容回退原文", async () => {
    const { deps } = makeDeps({ rewriteTo: "  " });
    const result = await optimizePrompt(LONG_INPUT, deps);
    expect(result.changed).toBe(false);
    expect(result.text).toBe(LONG_INPUT);
  });

  test("改写输出异常膨胀回退原文", async () => {
    const { deps } = makeDeps({ rewriteTo: "扩".repeat(LONG_INPUT.length * 10) });
    const result = await optimizePrompt(LONG_INPUT, deps);
    expect(result.changed).toBe(false);
    expect(result.text).toBe(LONG_INPUT);
  });

  test("跳过的输入不调用改写器", async () => {
    const { deps, calls } = makeDeps({ rewriteTo: "改写结果" });
    const result = await optimizePrompt("你好", deps);
    expect(calls.rewrite).toBe(0);
    expect(result.changed).toBe(false);
    expect(result.text).toBe("你好");
  });

  test("PROMPT_REWRITE=0 时不调用改写器", async () => {
    process.env.PROMPT_REWRITE = "0";
    try {
      const { deps, calls } = makeDeps({ rewriteTo: "改写结果" });
      const result = await optimizePrompt(LONG_INPUT, deps);
      expect(calls.rewrite).toBe(0);
      expect(result.changed).toBe(false);
      expect(result.text).toBe(LONG_INPUT);
    } finally {
      delete process.env.PROMPT_REWRITE;
    }
  });

  test("旧开关 EDGE_PROMPT_REWRITE=0 同样生效（向后兼容）", async () => {
    process.env.EDGE_PROMPT_REWRITE = "0";
    try {
      const { deps, calls } = makeDeps({ rewriteTo: "改写结果" });
      const result = await optimizePrompt(LONG_INPUT, deps);
      expect(calls.rewrite).toBe(0);
      expect(result.changed).toBe(false);
    } finally {
      delete process.env.EDGE_PROMPT_REWRITE;
    }
  });
});

describe("detectOptimizationStrategy", () => {
  test("代码块 → code", () => {
    expect(detectOptimizationStrategy("帮我看看这段代码 ```js\nconsole.log(1)\n``` 有什么问题")).toBe("code");
  });

  test("分析/评估/对比/总结 → analysis", () => {
    expect(detectOptimizationStrategy("帮我分析一下这个项目的性能瓶颈")).toBe("analysis");
    expect(detectOptimizationStrategy("评估两个方案的优劣")).toBe("analysis");
    expect(detectOptimizationStrategy("对比一下这两篇文章")).toBe("analysis");
    expect(detectOptimizationStrategy("总结一下这次会议纪要")).toBe("analysis");
  });

  test("翻译 → translation", () => {
    expect(detectOptimizationStrategy("把这段话翻译成英文")).toBe("translation");
  });

  test("写作意图 → writing", () => {
    expect(detectOptimizationStrategy("帮我撰写一篇产品发布文案")).toBe("writing");
    expect(detectOptimizationStrategy("润色一下这段自我介绍")).toBe("writing");
  });

  test("其余 → general", () => {
    expect(detectOptimizationStrategy("你好，今天天气怎么样")).toBe("general");
  });
});

describe("优化结果去重缓存", () => {
  test("相同输入第二次调用命中缓存：rewrite/verify 不再被调用", async () => {
    const { deps, calls } = makeDeps({ rewriteTo: GOOD_REWRITE, verifyResult: true });
    const first = await optimizePrompt(LONG_INPUT, deps);
    expect(first.changed).toBe(true);
    expect(calls.rewrite).toBe(1);
    expect(calls.verify).toBe(1);

    const second = await optimizePrompt(LONG_INPUT, deps);
    expect(second.changed).toBe(true);
    expect(second.text).toBe(GOOD_REWRITE);
    expect(calls.rewrite).toBe(1); // 缓存命中，未再调用改写
    expect(calls.verify).toBe(1);  // 缓存命中，未再调用判别
  });

  test("归一化（空白/大小写）后命中同一缓存条目", async () => {
    const { deps, calls } = makeDeps({ rewriteTo: GOOD_REWRITE, verifyResult: true });
    const inputA = "请帮我分析这个项目 知识库检索模块的性能瓶颈在哪里";
    const inputB = "请帮我分析这个项目  知识库检索模块的性能瓶颈在哪里";
    await optimizePrompt(inputA, deps);
    await optimizePrompt(inputB, deps);
    expect(calls.rewrite).toBe(1); // 连续空白被归并，命中同一缓存
  });

  test("缓存只在成功时写入：verify=false 第二次仍走 rewrite", async () => {
    const { deps, calls } = makeDeps({ rewriteTo: GOOD_REWRITE, verifyResult: false });
    const first = await optimizePrompt(LONG_INPUT, deps);
    expect(first.changed).toBe(false);
    expect(calls.rewrite).toBe(1);

    const second = await optimizePrompt(LONG_INPUT, deps);
    expect(calls.rewrite).toBe(2); // 失败结果未写缓存，仍走改写
    expect(second.changed).toBe(false);
  });

  test("resetPromptOptimizerCache() 后缓存清空，重新改写", async () => {
    const { deps, calls } = makeDeps({ rewriteTo: GOOD_REWRITE, verifyResult: true });
    await optimizePrompt(LONG_INPUT, deps);
    expect(calls.rewrite).toBe(1);

    resetPromptOptimizerCache();
    await optimizePrompt(LONG_INPUT, deps);
    expect(calls.rewrite).toBe(2);
  });
});

describe("getPromptOptimizerMetrics", () => {
  test("成功路径：cacheMisses/rewritten 累计，缓存命中不重复计 rewritten", async () => {
    const { deps } = makeDeps({ rewriteTo: GOOD_REWRITE, verifyResult: true });
    await optimizePrompt(LONG_INPUT, deps);
    let m = getPromptOptimizerMetrics();
    expect(m.calls).toBe(1);
    expect(m.skipped).toBe(0);
    expect(m.cacheHits).toBe(0);
    expect(m.cacheMisses).toBe(1);
    expect(m.rewritten).toBe(1);

    await optimizePrompt(LONG_INPUT, deps);
    m = getPromptOptimizerMetrics();
    expect(m.calls).toBe(2);
    expect(m.cacheHits).toBe(1);
    expect(m.cacheMisses).toBe(1);
    expect(m.rewritten).toBe(1); // 命中不新增 rewritten
  });

  test("跳过路径计入 skipped", async () => {
    const { deps } = makeDeps({ rewriteTo: GOOD_REWRITE, verifyResult: true });
    await optimizePrompt("你好", deps);
    const m = getPromptOptimizerMetrics();
    expect(m.skipped).toBe(1);
    expect(m.cacheMisses).toBe(0);
    expect(m.rewritten).toBe(0);
  });

  test("三重闸门失败分别计入 gateFailures", async () => {
    // 闸门 1：输出过短
    const { deps: depsOut } = makeDeps({ rewriteTo: "短", verifyResult: true });
    await optimizePrompt(LONG_INPUT, depsOut);

    // 闸门 2：语言漂移
    const { deps: depsLang } = makeDeps({
      rewriteTo: "Please analyze the performance bottleneck of the knowledge base retrieval module.",
      verifyResult: true,
    });
    await optimizePrompt(LONG_INPUT, depsLang);

    // 闸门 3：忠实度拒绝
    const { deps: depsFid } = makeDeps({ rewriteTo: GOOD_REWRITE, verifyResult: false });
    await optimizePrompt(LONG_INPUT, depsFid);

    const m = getPromptOptimizerMetrics();
    expect(m.calls).toBe(3);
    expect(m.gateFailures.output).toBe(1);
    expect(m.gateFailures.language).toBe(1);
    expect(m.gateFailures.fidelity).toBe(1);
    expect(m.rewritten).toBe(0);
  });
});