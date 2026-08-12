/**
 * 技能深化：从失败评测任务提炼「自检 + 溯源 + 路径规划」方法论技能。
 *
 * 方法论来源（已整理合并）：
 *  - ascetic-breaker（苦行僧破执术）：缺口检测 / 资源获取路由 / 不编造缺失信息 / 破执三层
 *  - Master-skill：source-grounded 溯源铁律 / 二阶段独立审查 / 保真度自检 / 渐进式披露
 *
 * 设计：全部确定性（无 LLM 依赖），深模块小接口；输出 SkillDefinition 供注册与注入。
 */
import type { SkillDefinition } from "../skills/types.js";
import type { TaskResult } from "./metrics.js";
import type { AgentTask } from "./tasks.js";

/** 失败分析：失败原因 + 缺口自检项 + 任务路径 */
export interface FailureAnalysis {
  taskId: string;
  family: AgentTask["family"];
  reason: string;
  gaps: GapCheck[];
  path: string[];
}

/** 缺口自检项 */
export interface GapCheck {
  category: string;
  question: string;
  impact: "高" | "中" | "低";
}

/** 缺口分类规则（按 verify 失败原因关键词匹配，确定性） */
const GAP_RULES: Array<{ category: string; keywords: string[]; question: string; impact: GapCheck["impact"] }> = [
  { category: "API/接口", keywords: ["api", "fetch", "endpoint", "http", "参数", "签名"], question: "API 端点/签名/认证方式是否已查官方文档确认？", impact: "高" },
  { category: "版本/兼容", keywords: ["version", "版本", "兼容", "依赖"], question: "依赖/语言/环境版本是否明确并兼容？", impact: "高" },
  { category: "语法/结构", keywords: ["缺少", "未提及", "未匹配", "包含", "遗漏", "未含"], question: "输出是否完整覆盖验证期望的每个关键点？", impact: "高" },
  { category: "数据/输入", keywords: ["数据", "格式", "输入", "编码"], question: "输入数据格式/样例/边界是否确认？", impact: "中" },
  { category: "领域知识", keywords: ["协议", "标准", "规范", "概念"], question: "涉及的专业概念/标准是否用权威资料核对？", impact: "中" },
];

/** 任务路径规划的确定性骨架（结合任务目标与验证期望） */
const PATH_SKELETON = [
  "明确任务目标与最终产出",
  "检索项目内已有实现（Glob/Grep）与官方文档（不重复造轮子）",
  "按验证期望逐项实现/回答，标注每个关键点",
  "对照自检清单复查，缺口补全或显式标注",
];

/**
 * 对失败结果做自检分析：从 verify 失败原因提取缺口类别并生成自检项。
 */
export function selfCheckFailures(results: TaskResult[], tasks: AgentTask[]): FailureAnalysis[] {
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const analyses: FailureAnalysis[] = [];
  for (const r of results) {
    if (r.passed) continue;
    const task = taskById.get(r.taskId);
    const reason = r.reason ?? "未知失败原因";
    const lower = reason.toLowerCase();
    const gaps: GapCheck[] = [];
    for (const rule of GAP_RULES) {
      if (rule.keywords.some((k) => lower.includes(k.toLowerCase()))) {
        gaps.push({ category: rule.category, question: rule.question, impact: rule.impact });
      }
    }
    if (gaps.length === 0) {
      gaps.push({ category: "输出完整性", question: "回答是否覆盖任务全部要求并给出可验证的具体内容？", impact: "高" });
    }
    analyses.push({
      taskId: r.taskId,
      family: r.family,
      reason,
      gaps,
      path: [...PATH_SKELETON],
    });
  }
  return analyses;
}

/**
 * 由失败分析生成方法论技能（SkillDefinition）。
 * id 确定性：auto-fix-<family>-<taskId 小写>；同 id 幂等。
 */
export function craftFailureSkill(analysis: FailureAnalysis, task: AgentTask | undefined): SkillDefinition {
  const id = `auto-fix-${analysis.family}-${analysis.taskId.toLowerCase()}`;
  const taskTitle = task?.title ?? analysis.taskId;
  const promptTemplate = [
    `这是一个从失败任务「${taskTitle}」中提炼的「自检 + 溯源 + 路径规划」方法论技能。`,
    `失败原因（可复现验证信号）：${analysis.reason}`,
    "",
    "## 自检清单（执行前逐项核对）",
    ...analysis.gaps.map((g) => `- [${g.impact}] ${g.question}`),
    "",
    "## 溯源铁律（不编造缺失信息）",
    "- 官方文档 / API 签名 / 版本号必须查证后使用，禁止用「应该是 / 大概 / 通常」填充关键事实缺口；",
    "- 项目内已有实现优先 Glob/Grep 复用，不重复造轮子；",
    "- 信息无法补全时显式标注缺口，不悄悄当事实。",
    "",
    "## 任务路径规划",
    ...analysis.path.map((s, i) => `${i + 1}. ${s}`),
    "",
    "## 方法论（破执三层 + 二阶段审查）",
    "- 即心即佛：先检索外部/项目内方案，不埋头硬推；",
    "- 非心非佛：检索到的方案要对照验证期望评分校验，不盲目照搬；",
    "- 无佛可求：缺口无法补全时显式标注；",
    "- 完成前二阶段自审：内容准确性 → 风格/格式一致性，FAIL 修复后再交付。",
    "",
    "用户请求: {{input}}",
  ].join("\n");
  return {
    id,
    name: `自检溯源: ${taskTitle}`,
    description: `失败任务「${taskTitle}」的方法论技能：自检清单 + 官方文档溯源 + 任务路径规划。`,
    triggers: [taskTitle],
    promptTemplate,
    requiredTools: [],
    outputFormat: "text",
    version: "1.0-craft",
    source: "hermes",
  };
}

/**
 * 从失败结果批量生成方法论技能（幂等：同 id 已存在则跳过）。
 * @param results 评测结果（失败项）
 * @param tasks   任务定义（用于映射标题）
 * @param has     幂等检查（同 skill-promotion deps.has 语义）
 * @param register 注册函数
 * @returns 新建的 SkillDefinition 列表
 */
export function craftFailureSkills(
  results: TaskResult[],
  tasks: AgentTask[],
  has: (id: string) => boolean,
  register: (skill: SkillDefinition) => void,
): SkillDefinition[] {
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const created: SkillDefinition[] = [];
  for (const analysis of selfCheckFailures(results, tasks)) {
    const skill = craftFailureSkill(analysis, taskById.get(analysis.taskId));
    if (has(skill.id)) continue;
    register(skill);
    created.push(skill);
  }
  return created;
}
