/**
 * 实践手册（Practice Manual）— 错误记录 + 修复过程 + 效果
 *
 * 需求 4：工具链遇到过的错误与修复（含 Windows/Linux 平台差异）沉淀为
 * 结构化条目，供"LLM 遇到同类问题 → 自动调用确定性推理引擎 → 把约束词
 * 插入输入后传给 LLM"。每条含 keywords（命中触发）与 constraint（注入词）。
 *
 * 同步维护：knowledge-base/practice-manual/entries.md（人类可读镜像）。
 */

export interface PracticeEntry {
  id: string;
  title: string;
  keywords: string[];
  /** 注入给 LLM 的约束词（确定性、可追溯） */
  constraint: string;
  /** 修复过程 */
  fix: string;
  /** 效果与证据 */
  effect: string;
}

export const PRACTICE_ENTRIES: PracticeEntry[] = [
  {
    id: "practice/sqlite-busy",
    title: "SQLite 并发写锁（SQLITE_BUSY / database is locked）",
    keywords: ["sqlite", "busy", "database is locked", "锁", "并发写", "lock"],
    constraint:
      "SQLite 多进程并发写会触发 SQLITE_BUSY。连接须设置 PRAGMA busy_timeout（如 5000）并启用 journal_mode=WAL；写失败应重试而非立即报错。",
    fix: "src/utils/cache.ts（及其他 bun:sqlite 连接）初始化时执行 PRAGMA busy_timeout=5000 + journal_mode=WAL。",
    effect: "并行测试 worker 下 SQLITE_BUSY 消除（full suite 0 fail）。证据：tests/ 并行 8 worker 连续通过。",
  },
  {
    id: "practice/network-test-timeout",
    title: "测试依赖真实网络（github.com / LLM API）导致超时",
    keywords: ["github", "network", "timeout", "api", "超时", "fetch", "zhipu", "llm"],
    constraint:
      "单元测试不得依赖真实网络。外部 fetch 用全局 mock（返回空 Response）；LLM 调用用注入的 fake executor / spy，避免真实 API 限流与超时。",
    fix: "tests/knowledge/* 用 spyOn(globalThis,'fetch')；tests/orchestrator 注入 fake executor + spyOn(router.executeWithRole)。",
    effect: "网络依赖用例从 30s 超时降为毫秒级，全绿。",
  },
  {
    id: "practice/random-flake",
    title: "随机模拟测试偶发失败（随机种子不可复现）",
    keywords: ["random", "seed", "flaky", "随机", "概率", "cross-talk", "hallucination"],
    constraint:
      "含随机/概率的测试必须可复现：用 seeded PRNG（mulberry32，如 params.seed）替代裸 Math.random；对『>0』断言给定种子后确定性成立。",
    fix: "新增 src/testing/scenarios/random.ts；cross-talk/hallucination 场景支持 params.seed，测试传 seed=42。",
    effect: "cluster-test 连续多次全绿（原 ~4% flake）。",
  },
  {
    id: "practice/bun-test-dist-match",
    title: "bun test 误匹配 dist/ 陈旧编译测试",
    keywords: ["bun", "test", "dist", "编译", "stale", "match"],
    constraint:
      "bun test 的目录参数会被当作路径过滤器，可能匹配 dist/ 下的陈旧编译测试。应使用 ./tests 显式路径并限定并行度（--parallel=8），避免误报。",
    fix: "package.json test 改为 bun test --parallel=8 ./tests；清理 dist/tests 陈旧产物。",
    effect: "本地测试基线确定性化（无 dist 噪声）。",
  },
  {
    id: "practice/parallel-module-race",
    title: "高并行下 ESM 模块加载竞态（方法为 Promise/undefined）",
    keywords: ["parallel", "worker", "promise", "undefined", "竞态", "并发", "module", "load"],
    constraint:
      "过高测试并行度（worker = CPU 核数）下 bun 可能返回未就绪模块绑定。测试套件应限定并行 worker 数（--parallel=8），避免模块加载竞态。",
    fix: "测试命令限定 --parallel=8（验证 16 worker → 22 fail，8 worker → 全绿）。",
    effect: "router/skill/runToolLoop 相关用例在高并行下不再报『is an instance of Promise』。",
  },
  {
    id: "practice/platform-command",
    title: "Windows/Linux 平台命令差异（浏览器/文件打开）",
    keywords: ["windows", "linux", "platform", "xdg-open", "cmd", "start", "平台", "browser"],
    constraint:
      "启动浏览器/打开文件的命令因平台而异：Windows 用 cmd /c start，Linux 用 xdg-open，macOS 用 open。跨平台代码必须按平台分支并做纯函数可测试。",
    fix: "src/computer-use/browser-launch.ts：resolveOpenCommand(platform,url) 纯函数 + launchUserBrowser(Bun.spawn)。",
    effect: "Win/Linux 均有测试覆盖；browser_launch 跨平台可用。",
  },
  {
    id: "practice/no-vision-model",
    title: "无视觉模型时前端视觉场景无法判断",
    keywords: ["vision", "视觉", "model", "screenshot", "图片", "没有视觉"],
    constraint:
      "无视觉模型时不得抛错：用 CDP 可交互元素（精确坐标）生成文本引导（任务/元素表/建议操作/验证），并可用 browser_locate/browser_launch 辅助定位与核对。",
    fix: "ComputerUseAgent.analyzeWithFallback 自动降级；browser_guide/browser_locate/browser_launch 工具。",
    effect: "无视觉模型也能对页面做结构化定位与引导（tests/computer-use 15 用例）。",
  },
];

/** 按关键词命中（大小写不敏感，子串匹配） */
export function findPracticeEntries(text: string): PracticeEntry[] {
  const lower = (text ?? "").toLowerCase();
  return PRACTICE_ENTRIES.filter((e) => e.keywords.some((k) => lower.includes(k.toLowerCase())));
}
