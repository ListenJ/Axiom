/**
 * 意图路由器 v2.0
 * 简化为 6 个通用类别：code / research / knowledge / write / plan / chat
 * 零成本意图识别（关键词匹配）→ 返回类别 + 推荐角色
 *
 * 移除 agents-index.json 依赖，内置通用 Agent Prompt
 */
import type { TaskRole } from "../router/model-capability-registry.js";

/** Agent 元数据（供 agent-discovery 使用） */
export interface AgentMeta {
  file: string;
  category: string;
  name: string;
  description: string;
  emoji: string;
  vibe: string;
  tools: string;
}

/** 意图识别结果 */
export interface IntentResult {
  /** 识别的意图类别 */
  intent: string;
  /** 匹配的 Agent 名称 */
  agentName: string;
  /** 匹配置信度 0-1 */
  confidence: number;
  /** 使用的关键词 */
  matchedKeywords: string[];
  /** 推荐的模型角色 */
  recommendedRole: TaskRole;
}

/** 6 大类意图映射规则 */
const CATEGORY_INTENTS: Record<string, {
  keywords: string[];
  label: string;
  agentName: string;
  role: TaskRole;
}> = {
  code: {
    keywords: [
      "代码", "编程", "开发", "bug", "调试", "重构", "api", "数据库", "前端", "后端",
      "架构", "devops", "测试", "部署", "服务器", "函数", "类", "组件", "接口", "性能",
      "优化", "安全", "漏洞", "git", "review", "css", "html", "js", "ts", "react",
      "vue", "angular", "sql", "docker", "k8s", "ci/cd", "webpack", "vite", "node",
      "python", "java", "go", "rust", "c++", "php", "ruby", "swift", "kotlin", "flutter",
      "express", "django", "spring", "microservice", "middleware", "sdk", "library",
      "framework", "redis", "mongodb", "postgres", "mysql", "sqlite", "nginx", "linux",
      "bash", "shell", "script", "algorithm", "http", "rest", "grpc", "graphql",
      "oauth", "jwt", "ssl", "cdn", "lambda", "serverless", "cloud", "aws", "azure",
      "gcp", "集成", "对接", "mcp", "webhook", "插件", "扩展",
    ],
    label: "code",
    agentName: "Code Engineer",
    role: "main_coding",
  },
  research: {
    keywords: [
      "研究", "调研", "分析", "论文", "文献", "学术", "数据", "统计", "假设",
      "综述", "methodology", "experiment", "产品", "需求", "prd", "roadmap",
      "用户故事", "功能", "迭代", "优先级", "竞品", "增长", "营销", "推广",
      "seo", "内容", "文案", "广告", "品牌", "销售", "客户", "谈判", "合同",
      "crm", "战略", "规划", "竞争", "行业", "趋势", "swot", "投资", "融资",
    ],
    label: "research",
    agentName: "Research Analyst",
    role: "research",
  },
  knowledge: {
    keywords: [
      "知识库", "笔记", "知识", "学到", "记住", "记忆", "知识库搜索",
      "之前", "上次", "历史", "记录", "vault", "knowledge",
      "什么是", "解释", "概念", "原理", "定义",
    ],
    label: "knowledge",
    agentName: "Knowledge Navigator",
    role: "research",
  },
  write: {
    keywords: [
      "写", "撰写", "文档", "报告", "总结", "方案", "计划书", "提案", "文案",
      "文章", "博客", "邮件", "通知", "公告", "说明", "教程", "指南", "手册",
      "翻译", "润色", "修改", "校对", "排版", "格式",
    ],
    label: "write",
    agentName: "Technical Writer",
    role: "research",
  },
  plan: {
    keywords: [
      "计划", "安排", "排期", "进度", "里程碑", "甘特图", "项目管理",
      "敏捷", "scrum", "kanban", "风险", "资源", "协作", "交付",
      "目标", "任务", "分解", "优先级", "时间表",
    ],
    label: "plan",
    agentName: "Project Planner",
    role: "coding",
  },
  chat: {
    keywords: [],
    label: "chat",
    agentName: "General Assistant",
    role: "coding",
  },
};

/** 中文停用词 */
const STOP_WORDS = new Set([
  "的", "了", "在", "是", "我", "有", "和", "就", "不", "人", "都", "一", "一个",
  "上", "也", "很", "到", "说", "要", "去", "你", "会", "着", "没有", "看", "好",
  "自己", "这", "那", "个", "之", "为", "以", "与", "及", "或", "但", "而", "如果",
  "因为", "所以", "可以", "需要", "进行", "使用", "通过", "根据", "对于", "关于",
  "作为", "能够", "已经", "正在", "开始", "完成", "实现", "提供", "支持", "包含",
  "具有", "拥有", "基于", "用于", "为了", "帮", "帮我", "来", "一下", "想", "请",
]);

/** 计算关键词匹配数 */
function countKeywordMatches(haystack: string, needles: string[]): number {
  const lower = haystack.toLowerCase();
  let count = 0;
  for (const kw of needles) {
    if (kw.length <= 1) continue;
    const kwLower = kw.toLowerCase();
    if (/[\u4e00-\u9fa5]/.test(kwLower)) {
      if (lower.includes(kwLower)) count++;
    } else {
      const regex = new RegExp(
        `(?:^|[^a-z0-9])${kwLower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[^a-z0-9]|$)`,
        "i"
      );
      if (regex.test(lower)) count++;
    }
  }
  return count;
}

/** 从用户输入中提取候选关键词 */
function extractUserKeywords(input: string): string[] {
  const lower = input.toLowerCase();
  const englishWords = lower.match(/[a-z][a-z0-9+#.]*/g) || [];
  const chineseWords: string[] = [];
  const chineseText = lower.replace(/[^\u4e00-\u9fa5]/g, "");
  for (let len = 2; len <= 3; len++) {
    for (let i = 0; i <= chineseText.length - len; i++) {
      const w = chineseText.slice(i, i + len);
      if (!STOP_WORDS.has(w)) chineseWords.push(w);
    }
  }
  return [...new Set([...englishWords, ...chineseWords].filter((w) => w.length >= 2 && !STOP_WORDS.has(w)))];
}

/**
 * 识别用户意图
 * 返回匹配度最高的类别，如果没有明显匹配则返回 chat
 */
export function recognizeIntent(userInput: string): IntentResult {
  const input = userInput.toLowerCase();
  const userKeywords = extractUserKeywords(input);

  let bestCategory = "chat";
  let bestScore = 0;
  const matchedKeywords: string[] = [];

  for (const [cat, rule] of Object.entries(CATEGORY_INTENTS)) {
    if (cat === "chat") continue; // chat 是默认回退
    const score = countKeywordMatches(input, rule.keywords);
    if (score > bestScore) {
      bestScore = score;
      bestCategory = cat;
      matchedKeywords.length = 0;
      for (const kw of rule.keywords) {
        if (input.includes(kw.toLowerCase()) || countKeywordMatches(input, [kw]) > 0) {
          matchedKeywords.push(kw);
        }
      }
    }
  }

  const rule = CATEGORY_INTENTS[bestCategory];
  const confidence = Math.min(bestScore / 3, 1);

  return {
    intent: bestCategory,
    agentName: rule.agentName,
    confidence,
    matchedKeywords: [...new Set(matchedKeywords)].slice(0, 8),
    recommendedRole: rule.role,
  };
}

/** 构建带意图识别的 Chat Messages */
export function buildAgentMessages(
  userInput: string,
  history: Array<{ role: string; content: string }> = []
): {
  intent: IntentResult;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
} {
  const intent = recognizeIntent(userInput);
  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];

  // 系统提示
  const systemPrompts: Record<string, string> = {
    code: "You are OpenClaw, a disciplined software engineering assistant. Provide accurate, concise technical answers. Use code examples when they help. Maintain a neutral, serious tone. Do not express emotion, enthusiasm, or empathy.",
    research: "You are OpenClaw, a research analyst. Investigate and report findings objectively. Cite sources when possible. Keep a neutral, serious tone without emotion.",
    knowledge: "You are OpenClaw, a knowledge navigator. Answer from the provided context only. If the context is insufficient, state so plainly. Use a neutral, serious tone. Do not express emotion.",
    write: "You are OpenClaw, a technical writer. Produce clear, structured, and professional content. Maintain a neutral, serious tone. Avoid emotional or enthusiastic language.",
    plan: "You are OpenClaw, a project planner. Provide structured, actionable plans. Keep the tone neutral, serious, and free of emotion.",
    chat: "You are OpenClaw. Answer accurately and concisely. Maintain a neutral, serious tone. Do not use emotional, enthusiastic, or empathetic language.",
  };

  messages.push({
    role: "system",
    content: systemPrompts[intent.intent] || systemPrompts.chat,
  });

  // 历史对话（最近 6 条）
  for (const h of history.slice(-6)) {
    messages.push({ role: h.role as "system" | "user" | "assistant", content: h.content });
  }

  // 当前输入
  messages.push({ role: "user", content: userInput });

  return { intent, messages };
}

/** 将意图映射为模型角色 */
export function mapIntentToRole(intentResult: IntentResult): TaskRole {
  return intentResult.recommendedRole || "coding";
}

/** 列出所有可用类别 */
export function listAgentCategories(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(CATEGORY_INTENTS).map(([cat, rule]) => [cat, rule.agentName])
  );
}
