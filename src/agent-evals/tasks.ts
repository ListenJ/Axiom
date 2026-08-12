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
];

// ===== planning =====
const planning: AgentTask[] = [
  t("PLAN-01", "planning", "train", "代码评审流程",
    "把「为团队做一次 PR 代码评审」拆成可执行步骤（3-5 步），每步一句话。",
    (r) => containsAny(r, ["1.", "2.", "3.", "步骤", "第一步"]),
    { maxTokens: 512 }),
  t("PLAN-02", "planning", "train", "发布计划",
    "一个 Node 服务要发布到生产：列出从合并到上线的完整步骤（含测试、构建、回滚预案）。",
    (r) => containsAll(r, ["test", "build", "deploy", "rollback"]),
    { maxTokens: 512 }),
  t("PLAN-03", "planning", "held-out", "知识库索引计划",
    "一个笔记库要支持语义检索：请列出从原始 Markdown 到可检索索引的处理步骤（含解析、分块、向量化、检索）。",
    (r) => containsAllAny(r, [["解析"], ["分块", "切分"], ["向量", "embedding"], ["索引"]]),
    { maxTokens: 512 }),
  t("PLAN-04", "planning", "held-out", "预算内任务排序",
    "你有 4 小时完成三件事：修一个 P0 bug、写周报、给新人答疑。给出优先级排序和理由（一句）。",
    (r) => containsAllAny(r, [["p0"], ["先"], ["bug"]]),
    { maxTokens: 512 }),
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
