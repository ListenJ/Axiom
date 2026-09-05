/**
 * Agent 能力边界测试集 — 6 个任务族 × 若干真实场景任务。
 * split 用于 held-out 泛化评估：train 模拟"进化经验来源"，held-out 模拟未见任务。
 */
import {
  assertSpecErrors,
  compileAssertion,
  containsAll,
  containsAllAny,
  containsAny,
  hasJSONKeys,
  minLength,
  notContains,
  type AssertionSpec,
  type VerifyResult,
} from "./verify.js";

export type TaskFamily = "coding" | "knowledge" | "planning" | "tool-use" | "memory" | "self-evolve";
export type TaskSplit = "train" | "held-out";

export interface TaskContext {
  task: AgentTask;
}

/** verify 闭包类型（显式闭包与 assert 派生闭包的统一形态） */
export type TaskVerify = (response: string, ctx?: TaskContext) => VerifyResult | Promise<VerifyResult>;

export interface AgentTask {
  id: string;
  family: TaskFamily;
  split: TaskSplit;
  title: string;
  prompt: string;
  systemPrompt?: string;
  /**
   * 声明式结构化断言（可序列化、可被 validateTasks 内省）。
   * 显式 verify 闭包最高优先、原样保留（老任务不迁）；
   * 传 assert 时由 t() 经 compileAssertion 自动派生 verify（S4 新任务用）。
   * 派生闭包与显式闭包同形，runner 的 await task.verify(content) 调用口径不变。
   */
  assert?: AssertionSpec;
  verify: TaskVerify;
  expectedBehavior?: string;
  maxTokens?: number;
}

function t(
  id: string,
  family: TaskFamily,
  split: TaskSplit,
  title: string,
  prompt: string,
  verify: TaskVerify,
  extra?: Partial<AgentTask>,
): AgentTask;
function t(
  id: string,
  family: TaskFamily,
  split: TaskSplit,
  title: string,
  prompt: string,
  assert: AssertionSpec,
  extra?: Partial<AgentTask>,
): AgentTask;
function t(
  id: string,
  family: TaskFamily,
  split: TaskSplit,
  title: string,
  prompt: string,
  verifyOrAssert: TaskVerify | AssertionSpec,
  extra?: Partial<AgentTask>,
): AgentTask {
  const isFn = typeof verifyOrAssert === "function";
  return {
    id,
    family,
    split,
    title,
    prompt,
    ...extra,
    assert: isFn ? undefined : verifyOrAssert,
    verify: isFn ? verifyOrAssert : compileAssertion(verifyOrAssert),
  };
}

// ===== coding =====
const coding: AgentTask[] = [
  t("CODING-01", "coding", "train", "TS 防抖函数",
    "写一个 TypeScript 函数 debounce(fn, delay)，要求：返回带 this 绑定的新函数、用 setTimeout/clearTimeout、支持立即执行一次（immediate 可选参数）。不要用任何库。",
    (r) => containsAllAny(r, [["function debounce", "debounce =", "const debounce", "debounce("], ["setTimeout"], ["clearTimeout"], ["apply", "...args", "call("]]),
    { maxTokens: 512,
      expectedBehavior: "输出包含 debounce 函数声明（function/const/箭头任一）与 setTimeout + clearTimeout 的定时器实现，并用 apply/call/...args 处理 this 绑定" }),
  t("CODING-02", "coding", "train", "SQL 聚合查询",
    "表 orders(id, user_id, amount, created_at)。写一条 SQL：统计每个用户的总金额与订单数，只返回金额大于 100 的用户，按金额降序。",
    (r) => containsAll(r, ["select", "group by", "sum", "count", "order by"]),
    { maxTokens: 512,
      expectedBehavior: "输出 SELECT 聚合语句，含 GROUP BY 分组、SUM/COUNT 两个聚合函数与 ORDER BY 排序（金额降序）；金额过滤条件（HAVING/WHERE）不强制校验" }),
  t("CODING-03", "coding", "held-out", "正则提取手机号",
    "写一段 JavaScript 代码，从任意文本中提取中国大陆手机号（11 位，1 开头），返回去重数组。",
    (r) => containsAllAny(r, [["match"], ["regexp", "正则"], ["set"]]),
    { maxTokens: 512,
      expectedBehavior: "输出使用 match 匹配、以 RegExp/正则字面量表达手机号模式、并用 Set 去重的提取实现" }),
  t("CODING-04", "coding", "held-out", "复杂度优化建议",
    "给定函数：function findDup(arr){ for(let i=0;i<arr.length;i++){ for(let j=i+1;j<arr.length;j++){ if(arr[i]===arr[j]) return arr[i]; } } return null; } 请完成：① 说明原函数的时间复杂度；② 给出 O(n) 的优化实现；③ 标定实现目标、优化后的时间复杂度和空间复杂度。",
    (r) => containsAllAny(r, [["o(n"], ["set", "哈希"], ["map", "object", "字典", "hash", "哈希", "set"], ["时间复杂度", "o("], ["空间复杂度", "空间"]]),
    { maxTokens: 512,
      expectedBehavior: "说明原函数复杂度为 O(n) 量级，给出基于 Set/哈希或 Map 的优化实现，并标定时间复杂度与空间复杂度" }),
  t("CODING-05", "coding", "train", "JSON 容错解析",
    "写一个 TypeScript 函数 safeParse(json: string)：解析 JSON，无效输入返回 null 而不是抛异常。请标定实现目标（输入/输出/约束）与时间复杂度、空间复杂度。",
    (r) => containsAllAny(r, [["json.parse"], ["try", "catch"], ["null"], ["时间复杂度", "o("], ["空间复杂度", "空间"]]),
    { maxTokens: 512,
      expectedBehavior: "输出 safeParse 实现，含 JSON.parse 与 try/catch 容错、无效输入返回 null，并标定时间与空间复杂度" }),
  t("CODING-06", "coding", "held-out", "并发请求合并",
    "写一段 JavaScript/TypeScript：并发请求两个 URL（fetch），用 Promise.all 等待，返回两个响应文本的拼接。请标定实现目标与时间复杂度、空间复杂度。",
    (r) => containsAllAny(r, [["promise.all"], ["fetch"], ["async", "await"], ["时间复杂度", "o("], ["空间复杂度", "空间"]]),
    { maxTokens: 512,
      expectedBehavior: "输出 fetch 并发请求实现，含 Promise.all 并发等待与 async/await，并标定时间与空间复杂度" }),
  t("CODING-07", "coding", "held-out", "内存泄漏排查（难）",
    "一个 Node 服务在生产环境内存持续上涨。给出完整排查路径：按顺序列出用什么工具/命令、每步看什么指标（如 heap 快照、--inspect、profiler、GC 日志），直到定位并修复。",
    (r) => containsAllAny(r, [["heap", "快照", "堆"], ["inspect", "profiler", "gc", "--inspect", "内存分析"], ["定位", "排查", "分析", "诊断"]]),
    { maxTokens: 768,
      expectedBehavior: "给出内存泄漏排查路径，覆盖堆内存/heap 快照与 inspect/profiler/GC 日志等诊断手段，并落到定位环节" }),
  t("CODING-08", "coding", "held-out", "带退避重试的异步请求（难）",
    "写一个 TypeScript 函数 fetchWithRetry(url, options?)：请求失败时指数退避重试，最多 3 次（重试前等待 2^n × 100ms）。标定实现目标与时间复杂度、空间复杂度。",
    (r) => containsAllAny(r, [["fetch", "请求", "http"], ["重试", "retry"], ["退避", "backoff", "延迟", "等待", "settimeout", "sleep"], ["复杂度", "o("]]),
    { maxTokens: 768,
      expectedBehavior: "输出 fetch 请求封装，含失败重试、指数退避/延迟等待逻辑，并给出复杂度说明" }),
  t("CODING-09", "coding", "train", "1MiB 字节换算（声明式断言）",
    "计算 1 MiB（mebibyte，二进制容量单位）等于多少字节，并写出一行换算过程（如 1024 × 1024 = 1048576）。回答必须以具体数字结尾，便于自动校验。",
    { mustReturnNumber: { min: 1048576, max: 1048576 } },
    { maxTokens: 256,
      expectedBehavior: "输出以 1048576 结尾的换算过程（1024 × 1024 = 1048576），末尾数值精确等于 1 MiB 的字节数" }),
  t("CODING-10", "coding", "held-out", "改动前备份流程（工程纪律）",
    "工程纪律（规则 2）：改动文件前必须备份。给定待修复文件 src/utils/config.ts（只改 1 行），请按规范给出改动前操作顺序：先备份（说出备份放置路径）、再改动、最后验证并清理。",
    { containsAllAny: [["备份", "backup", "copy", "快照"], ["验证", "测试", "运行", "检查"]] },
    { maxTokens: 256,
      expectedBehavior: "给出改动前备份→验证→清理的流程：包含备份概念（路径/backup/copy/快照）与验证概念（验证/测试/运行/检查）" }),
  t("CODING-11", "coding", "train", "最小改动判定（工程纪律）",
    "规则（规则 1）：改动必须保持最小范围。某次提交改动清单：① 修复了 bug 本身；② 顺手把与 bug 无关的变量重命名；③ 重构了一个无关工具函数。请判定该提交是否符合「最小改动」，并一句话说明理由。",
    { containsAllAny: [["越界", "超出", "无关", "多余", "过度", "不相关"], ["不合规", "违规", "违反", "应只改", "应当只改", "应聚焦", "最小改动"]] },
    { maxTokens: 256,
      expectedBehavior: "判定提交不合规/越出最小改动范围：指出无关改动（无关/越界/多余等）并给出越界理由（应只改/不合规/最小改动）" }),
];

// ===== knowledge =====
const knowledge: AgentTask[] = [
  t("KNOW-01", "knowledge", "train", "CAP 定理",
    "解释分布式系统 CAP 定理：三个保证分别是什么？给出一个选择 CP 的实例。",
    (r) => containsAllAny(r, [["consistency", "一致性"], ["availability", "可用性"], ["partition", "分区"]]),
    { maxTokens: 512,
      expectedBehavior: "说明 CAP 三个保证：一致性（Consistency）、可用性（Availability）、分区容错性（Partition Tolerance）" }),
  t("KNOW-02", "knowledge", "train", "Bun 与 Node 差异",
    "简述 Bun 运行时与 Node.js 的三点差异（运行时/包管理/TS 处理）。",
    (r) => containsAllAny(r, [["zig"], ["jsc", "javascriptcore"], ["typescript"]]),
    { maxTokens: 512,
      expectedBehavior: "说明 Bun 基于 Zig 构建、使用 JavaScriptCore（JSC）引擎、原生支持 TypeScript 等与 Node.js 的差异" }),
  t("KNOW-03", "knowledge", "held-out", "MCP 协议",
    "什么是 Model Context Protocol？它的核心价值是什么？请给出一个实际使用场景。",
    (r) => containsAllAny(r, [["model context protocol", "模型上下文协议", "mcp"], ["tool", "工具", "工具调用"], ["context", "上下文", "语境"]]),
    { maxTokens: 512,
      expectedBehavior: "说明 Model Context Protocol 是标准化上下文/工具接入协议，并给出工具调用或上下文共享等实际场景" }),
  t("KNOW-04", "knowledge", "held-out", "SQLite WAL",
    "SQLite 的 WAL 模式相比默认 journal 模式有什么优势？适合什么场景？",
    (r) => containsAllAny(r, [["wal"], ["write-ahead", "预写日志", "日志先行", "先写日志", "追加写入"], ["read", "读"], ["write", "写"]]),
    { maxTokens: 512,
      expectedBehavior: "说明 WAL（Write-Ahead Log）预写日志机制的优势，并覆盖读写并发与适用场景" }),
  t("KNOW-05", "knowledge", "train", "容器 vs 虚拟机",
    "简述容器与虚拟机的三点核心区别（隔离粒度/资源开销/启动速度各一句）。",
    (r) => containsAllAny(r, [["共享内核", "宿主机内核"], ["隔离", "namespace", "cgroup"], ["镜像", "image"]]),
    { maxTokens: 512,
      expectedBehavior: "说明容器共享宿主机内核、以 namespace/cgroup 隔离、镜像分发等与虚拟机的区别" }),
  t("KNOW-06", "knowledge", "held-out", "OAuth2 授权码流程",
    "简述 OAuth2 授权码模式（authorization code）的核心步骤（至少 3 步，含重定向与令牌交换）。",
    (r) => containsAllAny(r, [["授权码", "authorization code"], ["token", "令牌"], ["重定向", "redirect"]]),
    { maxTokens: 512,
      expectedBehavior: "说明 OAuth2 授权码模式含授权码获取、令牌交换与授权服务器重定向三个核心步骤" }),
  t("KNOW-07", "knowledge", "held-out", "分布式事务方案对比（难）",
    "对比 2PC / Saga / 本地消息表 / 事务发件箱（outbox）四种分布式事务方案的适用场景与权衡（各一句）。",
    (r) => containsAllAny(r, [["2pc", "两阶段"], ["saga"], ["发件箱", "outbox"], ["最终一致", "一致性"]]),
    { maxTokens: 768,
      expectedBehavior: "对比 2PC / Saga / 本地消息表 / 事务发件箱（outbox）四方案的适用场景与权衡，并涉及最终一致性取舍" }),
  t("KNOW-08", "knowledge", "held-out", "混合检索 Hybrid Search（难）",
    "解释混合检索（关键词 BM25 + 向量检索）相比纯向量检索的优势，并给出融合排序的一个实现要点（如 RRF 或加权）。",
    (r) => containsAllAny(r, [["bm25", "关键词", "稀疏"], ["向量", "embedding", "dense"], ["混合", "融合", "rrf", "加权"]]),
    { maxTokens: 512,
      expectedBehavior: "解释混合检索中 BM25 稀疏/关键词匹配与向量 embedding 的融合（RRF 或加权）等实现要点" }),
  t("KNOW-09", "knowledge", "held-out", "CAP 定理两三句解释（声明式断言）",
    "用 2 到 3 句话解释分布式系统的 CAP 定理，必须分别提到「一致性」「可用性」「分区容错性」三个术语，不要展开举例、不要列长清单。",
    { outputLength: { min: 15, max: 200 }, containsAll: ["一致性", "可用性", "分区容错性"] },
    { maxTokens: 512,
      expectedBehavior: "2-3 句（15-200 字）解释 CAP 定理，同时出现「一致性」「可用性」「分区容错性」三个术语" }),
  t("KNOW-10", "knowledge", "train", "model-router 角色路由与降级（Agent 本体知识）",
    "Agent 能力自述：当用户请求被映射为不同 TaskRole（如 code-review / research / decision），model-router 如何选择模型？主模型失败时的兜底机制是什么？各用一句话回答。",
    { containsAllAny: [["model-router", "模型路由", "角色路由", "路由", "taskrole"], ["fallback", "降级", "备用", "兜底", "重试", "备选"]] },
    { maxTokens: 256,
      expectedBehavior: "说明 model-router 按 TaskRole/角色路由选择模型，并给出主模型失败时 fallback/降级/备用/兜底的兜底机制" }),
  t("KNOW-11", "knowledge", "held-out", "git 安全护栏（规则 9）",
    "Agent 工程纪律（规则 9）：列出至少两条被明令禁止的 git 高危操作（force 推送 / 硬重置等），不要展开其他内容。",
    { containsAllAny: [["force push", "push --force", "--force", "force-push"], ["reset --hard", "reset hard", "硬重置", "硬回退"]] },
    { maxTokens: 256,
      expectedBehavior: "列出至少两条被禁 git 高危操作：一条是 force 推送（force push / push --force / --force），一条是硬重置（reset --hard / 硬重置）" }),
];

// ===== planning =====
const planning: AgentTask[] = [
  t("PLAN-01", "planning", "train", "代码评审流程",
    "把「为团队做一次 PR 代码评审」拆成可执行步骤（3-5 步），每步一句话。",
    (r) => containsAny(r, ["1.", "2.", "3.", "步骤", "第一步"]),
    { maxTokens: 512,
      expectedBehavior: "将代码评审拆为若干编号步骤或「第一步」式表述的可执行序列" }),
  t("PLAN-02", "planning", "train", "发布计划",
    "一个 Node 服务要发布到生产：列出从合并到上线的完整步骤（含测试、构建、回滚预案）。",
    (r) => containsAllAny(r, [["test", "测试"], ["build", "构建"], ["deploy", "部署"], ["rollback", "回滚"]]),
    { maxTokens: 512,
      expectedBehavior: "发布计划覆盖测试、构建、部署与回滚预案四个环节" }),
  t("PLAN-03", "planning", "held-out", "知识库索引计划",
    "一个笔记库要支持语义检索：请列出从原始 Markdown 到可检索索引的处理步骤（含解析、分块、向量化、检索）。",
    (r) => containsAllAny(r, [["解析"], ["分块", "切分"], ["向量", "embedding"], ["索引"]]),
    { maxTokens: 512,
      expectedBehavior: "知识库索引流程覆盖解析、分块、向量化与索引构建四个步骤" }),
  t("PLAN-04", "planning", "held-out", "预算内任务排序",
    "你有 4 小时完成三件事：修一个 P0 bug、写周报、给新人答疑。给出优先级排序和理由（一句）。",
    (r) => containsAllAny(r, [["p0", "优先级", "最重要", "最高"], ["先", "首先", "优先"], ["bug", "缺陷", "故障", "问题"]]),
    { maxTokens: 512,
      expectedBehavior: "给出优先级排序：将 P0 级别问题/缺陷置于首位并给出优先理由" }),
  t("PLAN-05", "planning", "train", "数据库迁移计划",
    "把一个 MySQL 库迁移到 PostgreSQL：列出关键步骤（含 schema 转换、数据迁移、验证、回滚预案）。",
    (r) => containsAllAny(r, [["schema", "结构"], ["迁移", "导出", "导入"], ["回滚", "rollback"]]),
    { maxTokens: 512,
      expectedBehavior: "迁移计划覆盖 schema 结构转换、数据迁移（导出/导入）与回滚预案" }),
  t("PLAN-06", "planning", "held-out", "生产故障恢复",
    "服务在生产环境宕机：列出恢复步骤（含止血、定位、修复、验证、复盘），每步一句话。",
    (r) => containsAllAny(r, [["恢复", "止血", "定位", "先恢复"], ["修复", "解决"], ["验证", "复盘", "确认", "总结"]]),
    { maxTokens: 512,
      expectedBehavior: "故障恢复步骤覆盖先恢复/止血定位、修复与验证或复盘确认环节" }),
  t("PLAN-07", "planning", "held-out", "零停机架构迁移（难）",
    "一个高流量单体服务要拆分为微服务并零停机上线：列出关键计划步骤（含网关/灰度/兼容层/回滚/验证）。",
    (r) => containsAllAny(r, [["网关", "gateway"], ["灰度", "渐进"], ["回滚", "rollback"], ["兼容", "兼容层"]]),
    { maxTokens: 768,
      expectedBehavior: "零停机拆分计划覆盖网关、灰度渐进、回滚与兼容层四类关键措施" }),
  t("PLAN-08", "planning", "held-out", "数据库灾难恢复演练（难）",
    "设计一次数据库灾难恢复（DR）演练计划：目标、前置准备、执行步骤（备份验证/故障注入/恢复/RTO-RPO 测量/复盘）各一句。",
    (r) => containsAllAny(r, [["备份"], ["恢复", "还原"], ["rto", "rpo", "指标", "时间"], ["演练", "复盘", "验证", "注入"]]),
    { maxTokens: 768,
      expectedBehavior: "演练计划覆盖备份、恢复/还原、RTO-RPO 指标与演练复盘或故障注入等环节" }),
  t("PLAN-09", "planning", "train", "上线前检查清单（声明式断言）",
    "把「服务上线前检查」拆成 3 到 5 个编号步骤，每步以数字加点或顿号开头（形如 1. 或 1、），每步一句话，不要超过 400 字。",
    { matchesAll: ["^\\d+[.、]\\s*"], outputLength: { max: 400 } },
    { maxTokens: 512,
      expectedBehavior: "输出 3-5 个以数字加标点开头的编号步骤，总长不超过 400 字" }),
  t("PLAN-10", "planning", "train", "code-review 角色评审流程",
    "以「代码评审者」角色执行一次 PR 评审：请列出你执行 code-review 时的标准流程（含先看什么、如何给建议、如何复核修改是否落地），按顺序 3 步，每步一句话。",
    { containsAllAny: [["diff", "改动", "变更", "修改", "评审", "review"], ["建议", "意见", "反馈"], ["复核", "确认", "验证", "跟进"]] },
    { maxTokens: 256,
      expectedBehavior: "code-review 流程覆盖三环节：读 diff/改动（评审内容）、给建议/意见/反馈、复核/确认修改落地" }),
  t("PLAN-11", "planning", "held-out", "self-evolve 闭环评测规划",
    "为自进化 Agent 设计一轮闭环评测（带 --evolve 能力）：按顺序列出 4 个环节——先建立 train 基线、再归纳技能、再在 held-out 上注入验证、最后回归对比。每环节一句话。",
    { containsAllAny: [["train", "训练", "基线", "baseline"], ["归纳", "提炼", "技能", "教训"], ["held-out", "未见", "留出", "泛化", "注入"], ["回归", "regression", "对比", "验证"]] },
    { maxTokens: 256,
      expectedBehavior: "闭环评测规划覆盖四环节：train 基线、技能归纳、held-out 注入验证、回归对比" }),
];

// ===== tool-use =====
const toolUse: AgentTask[] = [
  t("TOOL-01", "tool-use", "train", "天气 API 规划",
    "用户问「明天上海天气」。说明你需要的工具/API、请求方式（GET/POST）和关键参数，不要真的调用。",
    (r) => containsAllAny(r, [["api"], ["get", "post", "请求"], ["lat", "lon", "经度", "纬度", "city", "城市", "location", "位置"]]),
    { maxTokens: 512,
      expectedBehavior: "说明天气 API 的选择、请求方法（GET/POST）与定位参数（经纬度或城市名）" }),
  t("TOOL-02", "tool-use", "train", "浮点精度",
    "0.1 + 0.2 在 JS 中等于多少？如果要用精确计算，应该使用什么方式/工具？",
    (r) => containsAny(r, ["0.30000000000000004", "decimal", "bigint", "整数"]),
    { maxTokens: 512,
      expectedBehavior: "识别 0.1 + 0.2 的浮点精度问题（0.30000000000000004）或给出 decimal/BigInteger 等精确计算替代方案" }),
  t("TOOL-03", "tool-use", "held-out", "HTTP 请求工具",
    "写一个 Node 环境发起 GET 请求并打印状态码与响应体前 200 字符的最小示例，允许使用 fetch 或 curl。",
    (r) => containsAllAny(r, [["fetch", "curl", "http"], ["打印", "console", "输出"], ["状态码", "status", "响应"]]),
    { maxTokens: 512,
      expectedBehavior: "给出基于 fetch/curl/http 的 GET 请求示例，并打印状态码与响应内容" }),
  t("TOOL-04", "tool-use", "held-out", "日志检索",
    "要在一个大目录里找所有含「ERROR」的 .log 文件，你会用什么命令或工具？给出精确命令。",
    (r) => containsAll(r, ["grep", "log"]),
    { maxTokens: 512,
      expectedBehavior: "给出检索 .log 文件中 ERROR 关键字的命令，包含 grep 与 log 文件名" }),
  t("TOOL-05", "tool-use", "train", "数据库备份命令",
    "给出对 MySQL 做逻辑备份并压缩的命令（用 mysqldump），并说明恢复时怎么用。",
    (r) => containsAllAny(r, [["mysqldump"], ["备份", "dump"], ["恢复", "导入"]]),
    { maxTokens: 512,
      expectedBehavior: "给出 mysqldump 逻辑备份并压缩的命令，并说明恢复时如何导入" }),
  t("TOOL-06", "tool-use", "held-out", "Git 冲突解决",
    "给出解决 Git 合并冲突的完整步骤（含查看冲突、手动修改、标记解决、提交）。",
    (r) => containsAllAny(r, [["git", "版本控制", "代码库", "仓库"], ["冲突", "conflict", "conflicts"], ["merge", "合并", "解决冲突"]]),
    { maxTokens: 512,
      expectedBehavior: "给出 Git 冲突解决步骤，覆盖仓库上下文、冲突识别与合并解决流程" }),
  t("TOOL-07", "tool-use", "held-out", "CI 全链路设计（难）",
    "设计一条完整 CI 流水线：按顺序列出阶段（lint → 单测 → 集成测试 → 构建 → 安全扫描 → 部署 → 冒烟验证），每个阶段给一个代表命令或工具。",
    (r) => containsAllAny(r, [["lint", "静态检查", "代码检查"], ["测试", "test", "单测", "单元测试"], ["构建", "build", "编译"], ["部署", "deploy", "发布"], ["冒烟", "smoke", "验证"]]),
    { maxTokens: 768,
      expectedBehavior: "CI 流水线按序覆盖 lint 检查、测试、构建、部署与冒烟验证五个阶段" }),
  t("TOOL-08", "tool-use", "held-out", "Docker 容器排障（难）",
    "一个容器启动后立即退出（exit code 非 0）。列出完整排查步骤（含 docker ps -a / docker logs / docker inspect / docker exec，逐项看什么），直到定位根因。",
    (r) => containsAllAny(r, [["docker"], ["logs", "日志"], ["inspect", "exec", "ps"], ["退出", "exit", "崩溃", "根因", "原因"]]),
    { maxTokens: 768,
      expectedBehavior: "容器排障步骤覆盖 docker 命令、日志查看与 inspect/exec/ps 等根因定位手段" }),
  t("TOOL-09", "tool-use", "train", "0.1 + 0.2 浮点精确值（声明式断言）",
    "给出 0.1 + 0.2 在 IEEE 754 双精度浮点下的实际计算结果（写出精确字面值或近似值），一句话即可。答案中必须包含该结果数字。",
    { mustReturnNumber: { min: 0.3, max: 0.30000000000000005 } },
    { maxTokens: 256,
      expectedBehavior: "给出 0.1 + 0.2 的实际结果数字（0.3 或 0.30000000000000004 等浮点精度写法）" }),
  t("TOOL-10", "tool-use", "held-out", "web_search 工具参数构造",
    "工具调用：你需要使用 web_search 工具检索「2026 年 RAG 最新综述」。工具要求以 JSON 形式传参，唯一必填字段是 query。请直接输出要传给工具的 JSON 参数对象（不要加多余说明）。",
    { hasJSONKeys: ["query"] },
    { maxTokens: 256,
      expectedBehavior: "输出含 query 键的工具参数 JSON 对象（代码块包裹同样通过）" }),
  t("TOOL-11", "tool-use", "train", "容器启动即退出排障（快速路径）",
    "一个 Docker 容器启动后立即退出（exit code 非 0）。给出排查第一步与第二步的精确命令：先看容器状态与退出码，再看启动日志。",
    { containsAllAny: [["docker ps", "ps -a", "容器状态"], ["docker logs", "logs", "日志"]] },
    { maxTokens: 256,
      expectedBehavior: "两步命令：先用 docker ps -a / ps -a 看容器状态与退出码，再用 docker logs / 日志查看启动日志" }),
];

// ===== memory =====
const memory: AgentTask[] = [
  t("MEM-01", "memory", "train", "上下文保持",
    "先读信息：项目 A 的数据库是 PostgreSQL 15，端口 5432，缓存用 Redis 7。\n现在回答：项目 A 用什么数据库？端口是多少？",
    (r) => containsAll(r, ["postgresql", "5432"]),
    { maxTokens: 256,
      expectedBehavior: "回答项目 A 使用 PostgreSQL 数据库，端口为 5432（保持上下文提供值）" }),
  t("MEM-02", "memory", "held-out", "约束保持",
    "约束：所有函数必须用 TypeScript 且返回 Promise。\n请写一个读取文件并返回行数的函数，并说明它符合哪些约束。",
    (r) => containsAll(r, ["typescript", "promise"]),
    { maxTokens: 512,
      expectedBehavior: "输出实现符合 TypeScript 与返回 Promise 两个约束，并说明其合规性" }),
  t("MEM-03", "memory", "train", "配置参数保持",
    "先读信息：测试环境的 Redis 端口是 6380，超时阈值 300ms，重试次数 3 次。\n现在回答：重试次数是多少？超时阈值呢？",
    (r) => containsAllAny(r, [["3"], ["300"]]),
    { maxTokens: 256,
      expectedBehavior: "回答保持上下文配置：重试次数为 3、超时阈值为 300ms" }),
  t("MEM-04", "memory", "held-out", "日志根因定位",
    "读一段日志：'ERROR connect ECONNREFUSED 127.0.0.1:5432 at TCPConnectWrap... Retry 2/3 failed'。\n回答：最可能的根因是什么？",
    (r) => containsAllAny(r, [["连接", "拒绝", "端口"], ["5432", "database", "数据库"]]),
    { maxTokens: 256,
      expectedBehavior: "根因定位到连接被拒绝/端口 5432 的数据库不可达（ECONNREFUSED）" }),
  t("MEM-05", "memory", "train", "约束保持（多条件）",
    "约束：输出必须用 JSON，且包含 name 与 port 两个字段。\n请描述一个 PostgreSQL 服务实例。",
    (r) => hasJSONKeys(r, ["name", "port"]),
    { maxTokens: 512,
      expectedBehavior: "输出为 JSON 格式且同时包含 name 与 port 两个字段" }),
  t("MEM-06", "memory", "held-out", "版本约束保持",
    "约束：所有代码必须兼容 Node 18（无顶层 await、无 node: 前缀导入）。\n写一段读取环境变量并打印的代码，说明它符合哪些约束。",
    (r) => containsAllAny(r, [["node 18", "node18", "兼容"], ["process.env", "环境变量"]]),
    { maxTokens: 512,
      expectedBehavior: "输出代码使用 process.env 读取环境变量，并保持 Node 18 兼容约束" }),
  t("MEM-07", "memory", "held-out", "长因果链推理（难）",
    "日志序列：① API 超时 10s ② DB 连接池耗尽 ③ 慢查询积压 ④ 索引缺失 ⑤ 新版本发布删了索引。\n推断完整因果链：从触发动作到最终故障，按顺序列出每一环。",
    (r) => containsAllAny(r, [["索引"], ["连接池", "连接"], ["因果", "链", "导致"], ["发布", "版本"]]),
    { maxTokens: 512,
      expectedBehavior: "推断完整因果链，涉及索引缺失、连接池耗尽与版本发布等环节及因果表述" }),
  t("MEM-08", "memory", "held-out", "多轮状态整合（难）",
    "多轮对话上下文：① 数据库是 MySQL，端口 3306 ② 连接超时 5 秒 ③ 连接池上限 20。请写一条 MySQL 连接配置（DSN 或 JSON），必须同时包含上述三个值，并逐项标注来源轮次。",
    (r) => containsAllAny(r, [["3306"], ["20"], ["5", "5s", "5 秒"], ["mysql", "配置", "dsn", "json"]]),
    { maxTokens: 512,
      expectedBehavior: "输出 MySQL 连接配置同时包含 3306、20、5（秒）三个值并涉及 mysql 配置或 DSN/JSON 形式" }),
  t("MEM-09", "memory", "held-out", "记忆状态快照（声明式断言）",
    "把当前对话记住的信息整理成一个 JSON 对象输出，必须包含 count 字段（正整数，表示已记住的条目数量）。",
    { hasJSONKeys: ["count"], mustReturnNumber: { positive: true } },
    { maxTokens: 256,
      expectedBehavior: "输出 JSON 对象且包含正值 count 字段（count > 0）" }),
  t("MEM-10", "memory", "train", "角色与模型约束保持（JSON 键）",
    "约束：① 你当前扮演的角色是 code-review；② 调用模型必须是 glm-4.7-flash；③ 输出必须是 JSON 且必须包含 model 与 costUsd 两个字段。请用 JSON 描述当前角色的模型配置。",
    { hasJSONKeys: ["model", "costUsd"] },
    { maxTokens: 256,
      expectedBehavior: "输出 JSON 对象且同时包含 model 与 costUsd 两个字段（保持约束指定的键）" }),
  t("MEM-11", "memory", "held-out", "多约束整合配置（数值保持）",
    "约束四则：① provider=opencode ② model=deepseek-v4-flash ③ 并发 concurrency=2 ④ 重试 retry=2。请一次性输出同时满足四条约束的配置（JSON 或 key=value 均可），数值必须原样保留。",
    { containsAll: ["provider", "model"], containsAllAny: [["opencode"], ["deepseek"]], containsAny: ["concurrency", "retry", "并发", "重试"], mustReturnNumber: { min: 2, max: 2 } },
    { maxTokens: 256,
      expectedBehavior: "输出同时含 provider=opencode 与 model=deepseek 的配置，提及并发/重试（concurrency/retry）且末尾数值为 2" }),
];

// ===== self-evolve =====
const selfEvolve: AgentTask[] = [
  t("EVOLVE-01", "self-evolve", "train", "从失败提取教训",
    "下面是一条失败轨迹：Agent 尝试用 fs.readFileSync 读取一个不存在路径，抛 ENOENT，然后没有检查错误直接继续，最终任务失败。\n请提炼一条可复用的教训（一句话，含「下次」）。",
    (r) => containsAllAny(r, [["下次"], ["检查", "判断"], ["文件", "路径", "错误"]]),
    { maxTokens: 256,
      expectedBehavior: "提炼出含「下次」的可复用教训，涉及检查/判断与文件路径或错误处理" }),
  t("EVOLVE-02", "self-evolve", "held-out", "从成功归纳模式",
    "两条成功轨迹：① 用户要总结 PDF，Agent 先抽文本→分块→调摘要模型→汇总；② 用户要总结网页，Agent 先抓 HTML→去标签→分块→调摘要模型→汇总。\n请归纳它们的共同模式（一句话，含「模式」或「步骤」）。",
    (r) => containsAllAny(r, [["模式", "步骤", "共同"], ["分块", "摘要", "总结", "汇总"]]),
    { maxTokens: 256,
      expectedBehavior: "归纳出「模式」或共同步骤的表述，涉及分块与摘要汇总等实质内容" }),
  t("EVOLVE-03", "self-evolve", "train", "成功轨迹提炼步骤",
    "一条成功轨迹：用户要生成周报，Agent 先收集 commits → 按项目分组 → 用模板生成 → 让用户确认。\n请提炼为可复用的步骤序列（含「先」「然后」「最后」）。",
    (r) => containsAllAny(r, [["先"], ["然后"], ["最后"]]),
    { maxTokens: 256,
      expectedBehavior: "提炼为「先…然后…最后…」顺序的可复用步骤序列" }),
  t("EVOLVE-04", "self-evolve", "held-out", "失败轨迹归纳共同教训",
    "两条失败轨迹：① 调用第三方 API 未处理 429 导致任务失败；② 调用第三方 API 未处理超时导致任务失败。\n归纳共同教训（一句话，含「限流」或「重试」）。",
    (r) => containsAllAny(r, [["限流", "重试", "429", "超时"], ["处理", "检查", "捕获", "防护", "降级"]]),
    { maxTokens: 256,
      expectedBehavior: "归纳出共同教训，涉及限流/重试/429/超时与对应的处理或降级措施" }),
  t("EVOLVE-05", "self-evolve", "train", "限流处理策略",
    "调用 API 遇到 429 限流：给出处理策略（含退避、重试次数、降级）。",
    (r) => containsAllAny(r, [["退避", "backoff"], ["重试"], ["降级", "排队"]]),
    { maxTokens: 256,
      expectedBehavior: "给出 429 限流处理策略，同时包含退避、重试与降级或排队" }),
  t("EVOLVE-06", "self-evolve", "held-out", "工具误用自检清单",
    "Agent 用 rm -rf 删除文件前应检查什么？给出 3 条自检项。",
    (r) => containsAllAny(r, [["路径", "path"], ["确认", "检查", "验证"], ["备份", "backup", "保存", "快照"]]),
    { maxTokens: 256,
      expectedBehavior: "给出 rm -rf 前 3 条自检项，覆盖路径确认、检查验证与备份手段" }),
  t("EVOLVE-07", "self-evolve", "held-out", "多因失败复盘（难）",
    "一次线上事故由三个原因叠加（配置错误 + 缺乏监控 + 没有回滚预案）。给出结构化复盘：What / Why / How / 预防措施（各一句）。",
    (r) => containsAllAny(r, [["复盘", "what", "why"], ["根因", "原因", "cause", "root", "导致", "引发", "因为", "由于", "叠加"], ["预防", "改进", "prevent", "avoid"]]),
    { maxTokens: 512,
      expectedBehavior: "给出结构化复盘（What/Why），涉及叠加成因分析并包含预防改进措施" }),
  t("EVOLVE-08", "self-evolve", "held-out", "跨案例抽象通用原则（难）",
    "三个成功案例：① 总结 PDF（抽文本→分块→调摘要模型→汇总）② 总结网页（抓 HTML→去标签→分块→调摘要模型→汇总）③ 生成周报（收集 commits→分组→模板生成→确认）。请抽象一条跨案例的通用原则（含「收集」「处理」「汇总」），并说明它还能适用于哪类任务。",
    (r) => containsAllAny(r, [["收集", "获取", "采集"], ["处理", "分块", "解析", "整理"], ["汇总", "总结", "生成"], ["适用", "通用", "复用", "其他"]]),
    { maxTokens: 512,
      expectedBehavior: "抽象出「收集→处理→汇总」的跨案例通用原则，并说明其适用范围或可复用场景" }),
  t("EVOLVE-09", "self-evolve", "train", "改动前验证与回滚规则归纳（声明式断言）",
    "把三条近期改动经验归纳为「下次改动前要先验证什么、要提前确认哪条回滚路径」的可复用规则：给出至少 2 条编号规则，每条含一个具体验证动作与对应的回滚确认点。",
    // 2026-09-05 校准：原断言（必须字面「下次」+ 数字≥2）误伤合格回答——真实重跑
    // 中 zhipu 用「规则一/规则二」中文序号（无数字）、sensenova 用「规则 1/2/3」且均未
    // 复述「下次」，但都含验证动作 + 回滚确认点。放宽为「改动上下文/验证/回滚」三组
    // 同义词 + 「≥2 编号标记」正则（兼容阿拉伯/中文序号/第X条），替代 mustReturnNumber。
    { containsAllAny: [
      ["改动", "变更", "修改", "更新", "迁移", "发布", "上线", "下次", "以后", "未来", "后续", "之后"],
      ["验证", "检查", "确认", "测试", "核实"],
      ["回滚", "回退", "恢复", "rollback"],
    ], matchesAll: [
      "(?:第\\s*[一二两三四五六七八九十百\\d]+[条项点]|规则\\s*[一二两三四五六七八九十百\\d]+|(?:^|\\n)\\s*[一二两三四五六七八九十]+[、.．]|\\d+\\s*[.、．)）])(?:[\\s\\S]*?)(?:第\\s*[一二两三四五六七八九十百\\d]+[条项点]|规则\\s*[一二两三四五六七八九十百\\d]+|(?:^|\\n)\\s*[一二两三四五六七八九十]+[、.．]|\\d+\\s*[.、．)）])",
    ] },
    { maxTokens: 512,
      expectedBehavior: "输出至少 2 条编号规则，覆盖改动/下次上下文、验证点与回滚确认点" }),
  t("EVOLVE-10", "self-evolve", "held-out", "从 eval 失败提炼教训（含「下次」）",
    "下面是一条 eval 失败轨迹：模型在 EVOLVE 任务里只描述了「工具调用意图」而没有输出工具参数，导致断言校验失败。请提炼一条可复用的教训（一句话，必须以「下次」开头）。",
    { containsAllAny: [["下次", "以后", "下一次"], ["参数", "json", "输出", "格式", "结构", "检查"]] },
    { maxTokens: 256,
      expectedBehavior: "提炼出以「下次/以后」开头的教训，并涉及工具参数/JSON 输出/格式检查等实质内容" }),
  t("EVOLVE-11", "self-evolve", "train", "调试纪律：先建立反馈回路再提假设",
    "工程调试纪律（规则 6）：遇到一个难以定位的 bug，第一步做什么、第二步做什么？要求先建立可复现的反馈回路，再提出可证伪的假设。请按「先…后…」表述。",
    { containsAllAny: [["复现", "重现", "最小复现", "回放", "复现命令"], ["假设", "怀疑", "原因", "推断", "判断"]] },
    { maxTokens: 256,
      expectedBehavior: "调试两步走：先复现/建立反馈回路，再提出假设/怀疑；同时覆盖复现概念与假设概念" }),
];

export const ALL_AGENT_TASKS: AgentTask[] = [
  ...coding,
  ...knowledge,
  ...planning,
  ...toolUse,
  ...memory,
  ...selfEvolve,
];

export const ALL_TASK_FAMILIES: TaskFamily[] = ["coding", "knowledge", "planning", "tool-use", "memory", "self-evolve"];

export function getTasksByFamily(family?: TaskFamily, split?: TaskSplit): AgentTask[] {
  return ALL_AGENT_TASKS.filter(
    (task) => (!family || task.family === family) && (!split || task.split === split),
  );
}

/** 按 id 精确挑选任务（保持目录顺序；未知 id 忽略），供 --tasks 单任务/精确子集评测 */
export function getTasksByIds(ids: string[]): AgentTask[] {
  const wanted = new Set(ids);
  return ALL_AGENT_TASKS.filter((task) => wanted.has(task.id));
}

export function getTaskFamilies(tasks: AgentTask[]): TaskFamily[] {
  return [...new Set(tasks.map((task) => task.family))];
}

export function validateTasks(tasks: AgentTask[] = ALL_AGENT_TASKS): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const task of tasks) {
    if (seen.has(task.id)) errors.push(`duplicate id: ${task.id}`);
    seen.add(task.id);
    if (!task.title || !task.prompt) errors.push(`${task.id}: missing title/prompt`);
    if (task.split !== "train" && task.split !== "held-out") errors.push(`${task.id}: invalid split`);
    if (typeof task.verify !== "function") errors.push(`${task.id}: missing verify`);
    // S4：assert 声明式断言良构校验（复用 verify.ts 单一实现，错误带上任务 id 便于定位）
    if (task.assert) {
      const specErrors = assertSpecErrors(task.assert);
      if (specErrors.length) errors.push(...specErrors.map((e) => `${task.id}: ${e}`));
    }
    // S4 质量门：每个任务必须说明「验证什么行为」，供人工评审与自动进化对齐
    if (!task.expectedBehavior || !String(task.expectedBehavior).trim()) {
      errors.push(`${task.id}: 缺少 expectedBehavior（一句话说明本任务验证什么行为）`);
    }
  }
  for (const family of ALL_TASK_FAMILIES) {
    if (!tasks.some((x) => x.family === family && x.split === "train")) errors.push(`family ${family}: no train task`);
    if (!tasks.some((x) => x.family === family && x.split === "held-out")) errors.push(`family ${family}: no held-out task`);
  }
  return errors;
}
