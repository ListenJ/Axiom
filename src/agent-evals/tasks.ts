/**
 * Agent 能力边界测试集 — 6 个任务族 × 若干真实场景任务。
 * split 用于 held-out 泛化评估：train 模拟"进化经验来源"，held-out 模拟未见任务。
 */
import {
  containsAll,
  containsAllAny,
  containsAny,
  hasJSONKeys,
  minLength,
  notContains,
  type VerifyResult,
} from "./verify.js";

export type TaskFamily = "coding" | "knowledge" | "planning" | "tool-use" | "memory" | "self-evolve";
export type TaskSplit = "train" | "held-out";

export interface TaskContext {
  task: AgentTask;
}

export interface AgentTask {
  id: string;
  family: TaskFamily;
  split: TaskSplit;
  title: string;
  prompt: string;
  systemPrompt?: string;
  verify: (response: string, ctx?: TaskContext) => VerifyResult;
  expectedBehavior?: string;
  maxTokens?: number;
}

const t = (
  id: string,
  family: TaskFamily,
  split: TaskSplit,
  title: string,
  prompt: string,
  verify: AgentTask["verify"],
  extra?: Partial<AgentTask>,
): AgentTask => ({ id, family, split, title, prompt, verify, ...extra });

// ===== coding =====
const coding: AgentTask[] = [
  t("CODING-01", "coding", "train", "TS 防抖函数",
    "写一个 TypeScript 函数 debounce(fn, delay)，要求：返回带 this 绑定的新函数、用 setTimeout/clearTimeout、支持立即执行一次（immediate 可选参数）。不要用任何库。",
    (r) => containsAll(r, ["function debounce", "setTimeout", "clearTimeout", "apply"]),
    { maxTokens: 512 }),
  t("CODING-02", "coding", "train", "SQL 聚合查询",
    "表 orders(id, user_id, amount, created_at)。写一条 SQL：统计每个用户的总金额与订单数，只返回金额大于 100 的用户，按金额降序。",
    (r) => containsAll(r, ["select", "group by", "sum", "count", "order by"]),
    { maxTokens: 512 }),
  t("CODING-03", "coding", "held-out", "正则提取手机号",
    "写一段 JavaScript 代码，从任意文本中提取中国大陆手机号（11 位，1 开头），返回去重数组。",
    (r) => containsAllAny(r, [["match"], ["regexp", "正则"], ["set"]]),
    { maxTokens: 512 }),
  t("CODING-04", "coding", "held-out", "复杂度优化建议",
    "给定函数：function findDup(arr){ for(let i=0;i<arr.length;i++){ for(let j=i+1;j<arr.length;j++){ if(arr[i]===arr[j]) return arr[i]; } } return null; } 说明它的时间复杂度，并给出 O(n) 的优化实现。",
    (r) => containsAllAny(r, [["o(n"], ["set", "哈希"], ["map", "object", "字典", "hash"]]),
    { maxTokens: 512 }),
  t("CODING-05", "coding", "train", "JSON 容错解析",
    "写一个 TypeScript 函数 safeParse(json: string)：解析 JSON，无效输入返回 null 而不是抛异常。",
    (r) => containsAllAny(r, [["json.parse"], ["try", "catch"], ["null"]]),
    { maxTokens: 512 }),
  t("CODING-06", "coding", "held-out", "并发请求合并",
    "写一段 JavaScript/TypeScript：并发请求两个 URL（fetch），用 Promise.all 等待，返回两个响应文本的拼接。",
    (r) => containsAllAny(r, [["promise.all"], ["fetch"], ["async", "await"]]),
    { maxTokens: 512 }),
  t("CODING-07", "coding", "held-out", "内存泄漏排查（难）",
    "一个 Node 服务在生产环境内存持续上涨。给出完整排查路径：按顺序列出用什么工具/命令、每步看什么指标（如 heap 快照、--inspect、profiler、GC 日志），直到定位并修复。",
    (r) => containsAllAny(r, [["heap", "快照"], ["inspect", "profiler", "gc"], ["定位", "排查", "分析"]]),
    { maxTokens: 768 }),
];

// ===== knowledge =====
const knowledge: AgentTask[] = [
  t("KNOW-01", "knowledge", "train", "CAP 定理",
    "解释分布式系统 CAP 定理：三个保证分别是什么？给出一个选择 CP 的实例。",
    (r) => containsAllAny(r, [["consistency", "一致性"], ["availability", "可用性"], ["partition", "分区"]]),
    { maxTokens: 512 }),
  t("KNOW-02", "knowledge", "train", "Bun 与 Node 差异",
    "简述 Bun 运行时与 Node.js 的三点差异（运行时/包管理/TS 处理）。",
    (r) => containsAllAny(r, [["zig"], ["jsc", "javascriptcore"], ["typescript"]]),
    { maxTokens: 512 }),
  t("KNOW-03", "knowledge", "held-out", "MCP 协议",
    "什么是 Model Context Protocol？它的核心价值是什么？请给出一个实际使用场景。",
    (r) => containsAllAny(r, [["model context protocol", "模型上下文协议"], ["tool", "工具"], ["context", "上下文"]]),
    { maxTokens: 512 }),
  t("KNOW-04", "knowledge", "held-out", "SQLite WAL",
    "SQLite 的 WAL 模式相比默认 journal 模式有什么优势？适合什么场景？",
    (r) => containsAllAny(r, [["wal"], ["write-ahead", "预写日志"], ["read", "读"], ["write", "写"]]),
    { maxTokens: 512 }),
  t("KNOW-05", "knowledge", "train", "容器 vs 虚拟机",
    "简述容器与虚拟机的三点核心区别（隔离粒度/资源开销/启动速度各一句）。",
    (r) => containsAllAny(r, [["共享内核", "宿主机内核"], ["隔离", "namespace", "cgroup"], ["镜像", "image"]]),
    { maxTokens: 512 }),
  t("KNOW-06", "knowledge", "held-out", "OAuth2 授权码流程",
    "简述 OAuth2 授权码模式（authorization code）的核心步骤（至少 3 步，含重定向与令牌交换）。",
    (r) => containsAllAny(r, [["授权码", "authorization code"], ["token", "令牌"], ["重定向", "redirect"]]),
    { maxTokens: 512 }),
  t("KNOW-07", "knowledge", "held-out", "分布式事务方案对比（难）",
    "对比 2PC / Saga / 本地消息表 / 事务发件箱（outbox）四种分布式事务方案的适用场景与权衡（各一句）。",
    (r) => containsAllAny(r, [["2pc", "两阶段"], ["saga"], ["发件箱", "outbox"], ["最终一致", "一致性"]]),
    { maxTokens: 768 }),
];

// ===== planning =====
const planning: AgentTask[] = [
  t("PLAN-01", "planning", "train", "代码评审流程",
    "把「为团队做一次 PR 代码评审」拆成可执行步骤（3-5 步），每步一句话。",
    (r) => containsAny(r, ["1.", "2.", "3.", "步骤", "第一步"]),
    { maxTokens: 512 }),
  t("PLAN-02", "planning", "train", "发布计划",
    "一个 Node 服务要发布到生产：列出从合并到上线的完整步骤（含测试、构建、回滚预案）。",
    (r) => containsAllAny(r, [["test", "测试"], ["build", "构建"], ["deploy", "部署"], ["rollback", "回滚"]]),
    { maxTokens: 512 }),
  t("PLAN-03", "planning", "held-out", "知识库索引计划",
    "一个笔记库要支持语义检索：请列出从原始 Markdown 到可检索索引的处理步骤（含解析、分块、向量化、检索）。",
    (r) => containsAllAny(r, [["解析"], ["分块", "切分"], ["向量", "embedding"], ["索引"]]),
    { maxTokens: 512 }),
  t("PLAN-04", "planning", "held-out", "预算内任务排序",
    "你有 4 小时完成三件事：修一个 P0 bug、写周报、给新人答疑。给出优先级排序和理由（一句）。",
    (r) => containsAllAny(r, [["p0"], ["先"], ["bug"]]),
    { maxTokens: 512 }),
  t("PLAN-05", "planning", "train", "数据库迁移计划",
    "把一个 MySQL 库迁移到 PostgreSQL：列出关键步骤（含 schema 转换、数据迁移、验证、回滚预案）。",
    (r) => containsAllAny(r, [["schema", "结构"], ["迁移", "导出", "导入"], ["回滚", "rollback"]]),
    { maxTokens: 512 }),
  t("PLAN-06", "planning", "held-out", "生产故障恢复",
    "服务在生产环境宕机：列出恢复步骤（含止血、定位、修复、验证、复盘），每步一句话。",
    (r) => containsAllAny(r, [["恢复", "止血", "定位"], ["修复"], ["验证", "复盘"]]),
    { maxTokens: 512 }),
  t("PLAN-07", "planning", "held-out", "零停机架构迁移（难）",
    "一个高流量单体服务要拆分为微服务并零停机上线：列出关键计划步骤（含网关/灰度/兼容层/回滚/验证）。",
    (r) => containsAllAny(r, [["网关", "gateway"], ["灰度", "渐进"], ["回滚", "rollback"], ["兼容", "兼容层"]]),
    { maxTokens: 768 }),
];

// ===== tool-use =====
const toolUse: AgentTask[] = [
  t("TOOL-01", "tool-use", "train", "天气 API 规划",
    "用户问「明天上海天气」。说明你需要的工具/API、请求方式（GET/POST）和关键参数，不要真的调用。",
    (r) => containsAllAny(r, [["api"], ["get", "post", "请求"], ["lat", "lon", "经度", "纬度", "city", "城市", "location", "位置"]]),
    { maxTokens: 512 }),
  t("TOOL-02", "tool-use", "train", "浮点精度",
    "0.1 + 0.2 在 JS 中等于多少？如果要用精确计算，应该使用什么方式/工具？",
    (r) => containsAny(r, ["0.30000000000000004", "decimal", "bigint", "整数"]),
    { maxTokens: 512 }),
  t("TOOL-03", "tool-use", "held-out", "HTTP 请求工具",
    "写一个 Node 环境发起 GET 请求并打印状态码与响应体前 200 字符的最小示例，允许使用 fetch 或 curl。",
    (r) => containsAny(r, ["fetch", "curl", "http"]),
    { maxTokens: 512 }),
  t("TOOL-04", "tool-use", "held-out", "日志检索",
    "要在一个大目录里找所有含「ERROR」的 .log 文件，你会用什么命令或工具？给出精确命令。",
    (r) => containsAll(r, ["grep", "log"]),
    { maxTokens: 512 }),
  t("TOOL-05", "tool-use", "train", "数据库备份命令",
    "给出对 MySQL 做逻辑备份并压缩的命令（用 mysqldump），并说明恢复时怎么用。",
    (r) => containsAllAny(r, [["mysqldump"], ["备份", "dump"], ["恢复", "导入"]]),
    { maxTokens: 512 }),
  t("TOOL-06", "tool-use", "held-out", "Git 冲突解决",
    "给出解决 Git 合并冲突的完整步骤（含查看冲突、手动修改、标记解决、提交）。",
    (r) => containsAllAny(r, [["git"], ["冲突", "conflict"], ["merge", "合并"]]),
    { maxTokens: 512 }),
  t("TOOL-07", "tool-use", "held-out", "CI 全链路设计（难）",
    "设计一条完整 CI 流水线：按顺序列出阶段（lint → 单测 → 集成测试 → 构建 → 安全扫描 → 部署 → 冒烟验证），每个阶段给一个代表命令或工具。",
    (r) => containsAllAny(r, [["lint"], ["测试", "test"], ["构建", "build"], ["部署", "deploy"], ["冒烟", "smoke"]]),
    { maxTokens: 768 }),
];

// ===== memory =====
const memory: AgentTask[] = [
  t("MEM-01", "memory", "train", "上下文保持",
    "先读信息：项目 A 的数据库是 PostgreSQL 15，端口 5432，缓存用 Redis 7。\n现在回答：项目 A 用什么数据库？端口是多少？",
    (r) => containsAll(r, ["postgresql", "5432"]),
    { maxTokens: 256 }),
  t("MEM-02", "memory", "held-out", "约束保持",
    "约束：所有函数必须用 TypeScript 且返回 Promise。\n请写一个读取文件并返回行数的函数，并说明它符合哪些约束。",
    (r) => containsAll(r, ["typescript", "promise"]),
    { maxTokens: 512 }),
  t("MEM-03", "memory", "train", "配置参数保持",
    "先读信息：测试环境的 Redis 端口是 6380，超时阈值 300ms，重试次数 3 次。\n现在回答：重试次数是多少？超时阈值呢？",
    (r) => containsAllAny(r, [["3"], ["300"]]),
    { maxTokens: 256 }),
  t("MEM-04", "memory", "held-out", "日志根因定位",
    "读一段日志：'ERROR connect ECONNREFUSED 127.0.0.1:5432 at TCPConnectWrap... Retry 2/3 failed'。\n回答：最可能的根因是什么？",
    (r) => containsAllAny(r, [["连接", "拒绝", "端口"], ["5432", "database", "数据库"]]),
    { maxTokens: 256 }),
  t("MEM-05", "memory", "train", "约束保持（多条件）",
    "约束：输出必须用 JSON，且包含 name 与 port 两个字段。\n请描述一个 PostgreSQL 服务实例。",
    (r) => hasJSONKeys(r, ["name", "port"]),
    { maxTokens: 512 }),
  t("MEM-06", "memory", "held-out", "版本约束保持",
    "约束：所有代码必须兼容 Node 18（无顶层 await、无 node: 前缀导入）。\n写一段读取环境变量并打印的代码，说明它符合哪些约束。",
    (r) => containsAllAny(r, [["node 18", "node18", "兼容"], ["process.env", "环境变量"]]),
    { maxTokens: 512 }),
  t("MEM-07", "memory", "held-out", "长因果链推理（难）",
    "日志序列：① API 超时 10s ② DB 连接池耗尽 ③ 慢查询积压 ④ 索引缺失 ⑤ 新版本发布删了索引。\n推断完整因果链：从触发动作到最终故障，按顺序列出每一环。",
    (r) => containsAllAny(r, [["索引"], ["连接池", "连接"], ["因果", "链", "导致"], ["发布", "版本"]]),
    { maxTokens: 512 }),
];

// ===== self-evolve =====
const selfEvolve: AgentTask[] = [
  t("EVOLVE-01", "self-evolve", "train", "从失败提取教训",
    "下面是一条失败轨迹：Agent 尝试用 fs.readFileSync 读取一个不存在路径，抛 ENOENT，然后没有检查错误直接继续，最终任务失败。\n请提炼一条可复用的教训（一句话，含「下次」）。",
    (r) => containsAllAny(r, [["下次"], ["检查", "判断"], ["文件", "路径", "错误"]]),
    { maxTokens: 256 }),
  t("EVOLVE-02", "self-evolve", "held-out", "从成功归纳模式",
    "两条成功轨迹：① 用户要总结 PDF，Agent 先抽文本→分块→调摘要模型→汇总；② 用户要总结网页，Agent 先抓 HTML→去标签→分块→调摘要模型→汇总。\n请归纳它们的共同模式（一句话，含「模式」或「步骤」）。",
    (r) => containsAny(r, ["模式", "步骤", "先", "共同"]),
    { maxTokens: 256 }),
  t("EVOLVE-03", "self-evolve", "train", "成功轨迹提炼步骤",
    "一条成功轨迹：用户要生成周报，Agent 先收集 commits → 按项目分组 → 用模板生成 → 让用户确认。\n请提炼为可复用的步骤序列（含「先」「然后」「最后」）。",
    (r) => containsAllAny(r, [["先"], ["然后"], ["最后"]]),
    { maxTokens: 256 }),
  t("EVOLVE-04", "self-evolve", "held-out", "失败轨迹归纳共同教训",
    "两条失败轨迹：① 调用第三方 API 未处理 429 导致任务失败；② 调用第三方 API 未处理超时导致任务失败。\n归纳共同教训（一句话，含「限流」或「重试」）。",
    (r) => containsAny(r, ["限流", "重试", "429", "超时"]),
    { maxTokens: 256 }),
  t("EVOLVE-05", "self-evolve", "train", "限流处理策略",
    "调用 API 遇到 429 限流：给出处理策略（含退避、重试次数、降级）。",
    (r) => containsAllAny(r, [["退避", "backoff"], ["重试"], ["降级", "排队"]]),
    { maxTokens: 256 }),
  t("EVOLVE-06", "self-evolve", "held-out", "工具误用自检清单",
    "Agent 用 rm -rf 删除文件前应检查什么？给出 3 条自检项。",
    (r) => containsAllAny(r, [["路径", "path"], ["确认", "检查"], ["备份", "backup"]]),
    { maxTokens: 256 }),
  t("EVOLVE-07", "self-evolve", "held-out", "多因失败复盘（难）",
    "一次线上事故由三个原因叠加（配置错误 + 缺乏监控 + 没有回滚预案）。给出结构化复盘：What / Why / How / 预防措施（各一句）。",
    (r) => containsAllAny(r, [["复盘", "what", "why"], ["根因", "原因", "cause", "root"], ["预防", "改进", "prevent", "avoid"]]),
    { maxTokens: 512 }),
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
  }
  for (const family of ALL_TASK_FAMILIES) {
    if (!tasks.some((x) => x.family === family && x.split === "train")) errors.push(`family ${family}: no train task`);
    if (!tasks.some((x) => x.family === family && x.split === "held-out")) errors.push(`family ${family}: no held-out task`);
  }
  return errors;
}
