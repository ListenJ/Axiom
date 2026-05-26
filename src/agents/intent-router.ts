/**
 * Agency Agents 意图路由器 v1.0
 * 基于 agency-agents-main 的 150+ Agent Prompt 模板
 * 零成本意图识别（关键词匹配）→ 加载对应 Agent System Prompt → 调用模型
 *
 * 所有 API Key 通过环境变量注入
 */
import fs from "fs";
import path from "path";
import { logger } from "../utils/logger.js";

/** Agent 元数据 */
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
  /** 匹配的 Agent 元数据 */
  agent: AgentMeta;
  /** 匹配置信度 0-1 */
  confidence: number;
  /** 使用的关键词 */
  matchedKeywords: string[];
}

/** 大类意图映射规则 */
const CATEGORY_INTENTS: Record<string, { keywords: string[]; label: string; defaultAgent?: string }> = {
  engineering: {
    keywords: ["代码", "编程", "开发", "bug", "调试", "重构", "api", "数据库", "前端", "后端", "架构", "devops", "测试", "部署", "服务器", "函数", "类", "组件", "接口", "性能", "优化", "安全", "漏洞", "git", "代码审查", "review", "css", "html", "js", "ts", "react", "vue", "angular", "sql", "docker", "k8s", "ci/cd", "webpack", "vite", "node", "python", "java", "go", "rust", "c++", "csharp", "php", "ruby", "swift", "kotlin", "flutter", "express", "django", "spring", "laravel", "microservice", "middleware", "sdk", "library", "framework", "redis", "mongodb", "postgres", "mysql", "sqlite", "elasticsearch", "nginx", "apache", "linux", "bash", "shell", "script", "algorithm", "data structure", "leetcode", "http", "rest", "grpc", "graphql", "websocket", "oauth", "jwt", "ssl", "https", "cdn", "lambda", "serverless", "cloud", "aws", "azure", "gcp"],
    label: "engineering",
    defaultAgent: "Backend Architect",
  },
  design: {
    keywords: ["设计", "ui", "ux", "界面", "视觉", "配色", "排版", "logo", "品牌", "figma", "原型", "交互", "用户体验", "图标", "动画", "样式", "css", "美观", "布局"],
    label: "design",
    defaultAgent: "UX Architect",
  },
  product: {
    keywords: ["产品", "需求", "prd", " roadmap", "用户故事", "功能", "迭代", "优先级", "mvp", "发布", "上线", "策略", "调研", "竞品", "增长", "留存", "转化", "漏斗"],
    label: "product",
    defaultAgent: "Product Manager",
  },
  marketing: {
    keywords: ["营销", "推广", "seo", "内容", "文案", "广告", "投放", "社媒", "品牌", "传播", "获客", "流量", "曝光", "campaign", "landing page", "邮件营销", "市场", "受众", "转化率", "漏斗", "用户画像", "增长黑客", "growth hacking", "内容营销", "influencer", "kol", "koc", "短视频", "直播", "小红书", "抖音", "b站", "微博", "微信", "公众号", "社群", "私域", "公域", "裂变", "拉新", "留存", "活跃", "dau", "mau", "gmv", "roi", "kpi", "品牌策略", "定位", "差异化", "usp", "slogan", "tagline"],
    label: "marketing",
    defaultAgent: "Growth Hacker",
  },
  sales: {
    keywords: ["销售", "客户", "报价", "谈判", "合同", "线索", "crm", "跟进", "成交", "b2b", "渠道", "分销", "电销", "话术", "异议处理", "数据", "分析", "报表", "业绩", "销售额", "收入", "pipeline", "funnel", "转化率", "复购", " upsell", "cross-sell", "客户成功", "account", "saas", "订阅", "客单价", "ltv", "cac", "销售预测", "配额", "commission", "佣金", "折扣", "返点", "大客户", "ka", "smb", "enterprise"],
    label: "sales",
    defaultAgent: "Pipeline Analyst",
  },
  "project-management": {
    keywords: ["项目管理", "计划", "里程碑", "甘特图", "进度", "风险", "资源", "敏捷", "scrum", "kanban", "排期", "工时", "协作", "团队", "交付", "pm"],
    label: "project-management",
    defaultAgent: "Sprint Prioritizer",
  },
  testing: {
    keywords: ["测试", "qa", "用例", "自动化测试", "回归", "覆盖率", "bug", "缺陷", "验收", "a/b test", "性能测试", "压力测试", "selenium", "cypress", "playwright"],
    label: "testing",
    defaultAgent: "API Tester",
  },
  support: {
    keywords: ["客服", "支持", "工单", "售后", "faq", "帮助文档", "用户反馈", "投诉", "满意度", "响应时间", "sla"],
    label: "support",
    defaultAgent: "Support Responder",
  },
  academic: {
    keywords: ["学术", "论文", "研究", "文献", "引用", "期刊", "实验", "数据", "统计", "假设", "综述", "methodology", "arxiv", "毕业论文", "开题报告", "文献综述", "定量分析", "定性分析", "问卷调查", "访谈", "案例研究", "比较研究", "meta分析", "影响因子", "同行评审", "peer review", "thesis", "dissertation", "research", "publication", "sci", "ssci", "ei", "核心期刊", "知网", "万方", "pubmed", "google scholar"],
    label: "academic",
    defaultAgent: "Historian",
  },
  "game-development": {
    keywords: ["游戏", "unity", "unreal", "godot", "关卡", "玩法", "机制", "npc", "ai", "物理", "渲染", "shader", "粒子", "音效", "原画", "3d", "2d", "手游", "端游"],
    label: "game-development",
    defaultAgent: "Unity Shader Graph Artist",
  },
  strategy: {
    keywords: ["战略", "规划", "竞争", "行业", "趋势", "swot", "pest", "波特五力", "商业模式", "盈利", "融资", "投资", "并购"],
    label: "strategy",
    defaultAgent: "Deal Strategist",
  },
  "spatial-computing": {
    keywords: ["ar", "vr", "mr", "元宇宙", "空间", "三维", "虚拟", "增强现实", "混合现实", "头显", "quest", "vision pro", "hololens"],
    label: "spatial-computing",
    defaultAgent: "Unity Shader Graph Artist",
  },
  specialized: {
    keywords: ["专业", "专项", "定制", "特殊", "顾问", "咨询", "专家", "行业"],
    label: "specialized",
  },
  integrations: {
    keywords: ["集成", "对接", "mcp", "api", "webhook", "插件", "扩展", "连接器", "sdk"],
    label: "integrations",
  },
  "paid-media": {
    keywords: ["付费", "投放", "sem", "信息流", "dsp", "rtb", "cpa", "cpc", "cpm", "roi", "广告预算", "出价", "素材"],
    label: "paid-media",
    defaultAgent: "Growth Hacker",
  },
};

let agentsIndex: AgentMeta[] | null = null;

/** 加载 Agent 索引 */
function loadAgentsIndex(): AgentMeta[] {
  if (agentsIndex) return agentsIndex;
  const indexPath = process.env.AGENTS_INDEX_PATH || "./data/agents-index.json";
  if (!fs.existsSync(indexPath)) {
    logger.warn("[IntentRouter] Agents index not found, using fallback", { path: indexPath });
    return [];
  }
  try {
    const raw = fs.readFileSync(indexPath, "utf-8");
    agentsIndex = JSON.parse(raw) as AgentMeta[];
    logger.info("[IntentRouter] Loaded agents index", { count: agentsIndex.length });
    return agentsIndex;
  } catch (e: any) {
    logger.error("[IntentRouter] Failed to load index", e, { message: e.message });
    return [];
  }
}

/** 中文停用词 */
const STOP_WORDS = new Set(["的", "了", "在", "是", "我", "有", "和", "就", "不", "人", "都", "一", "一个", "上", "也", "很", "到", "说", "要", "去", "你", "会", "着", "没有", "看", "好", "自己", "这", "那", "个", "之", "为", "以", "与", "及", "或", "但", "而", "如果", "因为", "所以", "可以", "需要", "进行", "使用", "通过", "根据", "对于", "关于", "作为", "能够", "已经", "正在", "开始", "完成", "实现", "提供", "支持", "包含", "具有", "拥有", "基于", "用于", "为了", "由于", "随着", "以及", "或者", "并且", "虽然", "然后", "接着", "最后", "首先", "同时", "此外", "另外", "其他", "一些", "这些", "那些", "什么", "怎么", "如何", "为什么", "哪里", "谁", "哪", "几", "多少", "帮", "帮我", "写", "做", "来", "一下", "个", "想", "请"]);

/** 计算 haystack 中包含 needles 中多少个关键词（英文要求单词边界，中文直接包含） */
function countKeywordMatches(haystack: string, needles: string[]): number {
  const lower = haystack.toLowerCase();
  let count = 0;
  for (const kw of needles) {
    if (kw.length <= 1) continue;
    const kwLower = kw.toLowerCase();
    if (/[\u4e00-\u9fa5]/.test(kwLower)) {
      // 中文：直接子串匹配
      if (lower.includes(kwLower)) count++;
    } else {
      // 英文/技术术语：要求单词边界（避免 "ts" 匹配 "assets"）
      const regex = new RegExp(`(?:^|[^a-z0-9])${kwLower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[^a-z0-9]|$)`, "i");
      if (regex.test(lower)) count++;
    }
  }
  return count;
}

/** 从用户输入中提取候选关键词（中英文混合） */
function extractUserKeywords(input: string): string[] {
  const lower = input.toLowerCase();
  // 提取英文单词和技术术语
  const englishWords = lower.match(/[a-z][a-z0-9+#.]*/g) || [];

  // 中文：滑动窗口提取 2-3 字词组（避免 4 字截断问题）
  const chineseWords: string[] = [];
  const chineseText = lower.replace(/[^\u4e00-\u9fa5]/g, "");
  for (let len = 2; len <= 3; len++) {
    for (let i = 0; i <= chineseText.length - len; i++) {
      const w = chineseText.slice(i, i + len);
      if (!STOP_WORDS.has(w)) chineseWords.push(w);
    }
  }

  // 合并并去重
  const all = [...englishWords, ...chineseWords].filter((w) => w.length >= 2 && !STOP_WORDS.has(w));
  return [...new Set(all)];
}

/** 提取用户输入中命中类别词典的关键词（短英文词使用单词边界，避免子串误匹配） */
function extractCategoryKeywords(input: string): string[] {
  const lower = input.toLowerCase();
  const matched: string[] = [];
  for (const rule of Object.values(CATEGORY_INTENTS)) {
    for (const kw of rule.keywords) {
      const kwLower = kw.toLowerCase();
      if (/[\u4e00-\u9fa5]/.test(kwLower)) {
        // 中文：子串匹配
        if (lower.includes(kwLower)) matched.push(kw);
      } else if (kwLower.length <= 3) {
        // 短英文（如 ts, ei, api, js）：单词边界匹配，防止 "ei" 匹配 "recognizeIntent"
        const esc = kwLower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const re = new RegExp(`(?:^|[^a-z0-9])${esc}(?:[^a-z0-9]|$)`, "i");
        if (re.test(lower)) matched.push(kw);
      } else {
        // 长英文：子串匹配（保留兼容性）
        if (lower.includes(kwLower)) matched.push(kw);
      }
    }
  }
  return [...new Set(matched)];
}

/** 识别用户意图 */
export function recognizeIntent(userInput: string): IntentResult | null {
  const agents = loadAgentsIndex();
  if (agents.length === 0) return null;

  const input = userInput.toLowerCase();
  const userKeywords = extractUserKeywords(input);
  let bestCategory = "";
  let bestCategoryScore = 0;

  // 第一步：识别大类意图
  for (const [cat, rule] of Object.entries(CATEGORY_INTENTS)) {
    const score = countKeywordMatches(input, rule.keywords);
    if (score > bestCategoryScore) {
      bestCategoryScore = score;
      bestCategory = cat;
    }
  }
  // 如果多个类别同分，选择匹配关键词更"独特"的类别（关键词在其他类别中出现频率更低）
  if (bestCategoryScore > 0) {
    const tiedCategories = Object.entries(CATEGORY_INTENTS).filter(
      ([, rule]) => countKeywordMatches(input, rule.keywords) === bestCategoryScore
    );
    if (tiedCategories.length > 1) {
      // 计算每个类别的独特度 = 匹配的关键词中，在其他类别中不出现的比例
      let bestUniqueness = -1;
      for (const [cat, rule] of tiedCategories) {
        const matched = rule.keywords.filter((kw) => input.includes(kw.toLowerCase()));
        let uniqueness = 0;
        for (const kw of matched) {
          const appearsInOthers = Object.entries(CATEGORY_INTENTS).some(
            ([otherCat, otherRule]) => otherCat !== cat && otherRule.keywords.includes(kw)
          );
          if (!appearsInOthers) uniqueness += 2;
          else uniqueness += 1;
        }
        if (uniqueness >= bestUniqueness) {
          bestUniqueness = uniqueness;
          bestCategory = cat;
        }
      }
    }
  }

  // 第二步：在大类中匹配最佳 Agent
  let bestAgent: AgentMeta | null = null;
  let bestAgentScore = 0;
  const matchedKeywords: string[] = [];
  const categoryKeywords = CATEGORY_INTENTS[bestCategory]?.keywords || [];
  const catMatchedKeywords = extractCategoryKeywords(input);

  const categoryAgents = agents.filter((a) => a.category.endsWith(bestCategory) || a.category.includes("\\" + bestCategory));

  for (const agent of categoryAgents) {
    const agentText = `${agent.name} ${agent.description} ${agent.vibe} ${agent.tools}`.toLowerCase();

    // 用户关键词在 agent 描述中的匹配数
    const descScore = countKeywordMatches(agentText, userKeywords);

    // 额外加分：用户输入直接包含 agent name（英文/中文）
    const nameVariants = [
      agent.name.toLowerCase(),
      ...agent.name.toLowerCase().split(/[\s\-_]+/), // Backend Architect -> [backend, architect]
    ];
    const nameScore = nameVariants.filter((n) => n.length > 2 && input.includes(n)).length * 4;

    // 额外加分：类别词典命中用户输入中的词，且出现在 agent 描述中
    const directCatScore = catMatchedKeywords.filter((kw) => countKeywordMatches(agentText, [kw]) > 0).length * 2;

    const totalScore = descScore + nameScore + directCatScore;
    if (totalScore > bestAgentScore) {
      bestAgentScore = totalScore;
      bestAgent = agent;
      matchedKeywords.length = 0;
      // 记录匹配的关键词（使用与 countKeywordMatches 一致的严格规则）
      for (const kw of userKeywords) {
        if (countKeywordMatches(agentText, [kw]) > 0) matchedKeywords.push(kw);
      }
      for (const kw of catMatchedKeywords) {
        if (input.includes(kw.toLowerCase())) matchedKeywords.push(kw);
      }
    }
  }

  // 如果大类匹配正确但 agent 级别匹配分数低，选择 defaultAgent 或类别下第一个作为回退
  if (bestCategoryScore >= 1 && (!bestAgent || bestAgentScore < 1)) {
    const defaultAgentName = CATEGORY_INTENTS[bestCategory]?.defaultAgent;
    if (defaultAgentName && categoryAgents.length > 0) {
      bestAgent = categoryAgents.find((a) => a.name === defaultAgentName) || categoryAgents[0] || null;
    } else if (categoryAgents.length > 0) {
      bestAgent = categoryAgents[0] || null;
    }
    bestAgentScore = Math.max(bestAgentScore, 0.3);
    if (bestAgent) {
      matchedKeywords.push(...catMatchedKeywords);
    }
  }

  // 如果没有大类匹配，尝试全局匹配
  if (!bestAgent) {
    for (const agent of agents) {
      const agentText = `${agent.name} ${agent.description} ${agent.vibe}`.toLowerCase();
      const descScore = countKeywordMatches(agentText, userKeywords);
      const nameVariants = [
        agent.name.toLowerCase(),
        ...agent.name.toLowerCase().split(/[\s\-_]+/),
      ];
      const nameScore = nameVariants.filter((n) => n.length > 2 && input.includes(n)).length * 4;
      const directCatScore = catMatchedKeywords.filter((kw) => countKeywordMatches(agentText, [kw]) > 0).length * 2;
      const totalScore = descScore + nameScore + directCatScore;
      if (totalScore > bestAgentScore) {
        bestAgentScore = totalScore;
        bestAgent = agent;
        matchedKeywords.length = 0;
        for (const kw of userKeywords) {
          if (countKeywordMatches(agentText, [kw]) > 0) matchedKeywords.push(kw);
        }
        for (const kw of catMatchedKeywords) {
          if (input.includes(kw.toLowerCase())) matchedKeywords.push(kw);
        }
      }
    }
  }

  // 阈值过滤：如果没有明显匹配，返回 null（使用通用 agent）
  if (!bestAgent || bestAgentScore < 0.3) {
    return null;
  }

  const confidence = Math.min(bestAgentScore / 4, 1);
  const label = CATEGORY_INTENTS[bestCategory]?.label || bestAgent.category.split(/[\\/]/).pop() || "general";

  return {
    intent: label,
    agentName: bestAgent.name,
    agent: bestAgent,
    confidence,
    matchedKeywords: [...new Set(matchedKeywords)].slice(0, 8),
  };
}

/** 从 AgentMeta 合成 System Prompt（当文件不可用时回退） */
function synthesizeAgentPrompt(agent: AgentMeta): string {
  return `# ${agent.emoji} ${agent.name} Agent Personality

You are **${agent.name}**, ${agent.description}.

## Vibe
${agent.vibe}

## Your Mission
Use your specialized expertise to help the user with their request. Stay in character as ${agent.name} throughout the conversation.`;
}

/** 加载 Agent 的 System Prompt（去掉 frontmatter） */
export function loadAgentPrompt(agentFile: string, agent?: AgentMeta): string {
  try {
    if (fs.existsSync(agentFile)) {
      const content = fs.readFileSync(agentFile, "utf-8");
      // 去掉 YAML frontmatter
      const cleaned = content.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
      return cleaned;
    }
  } catch (e: any) {
    logger.warn("[IntentRouter] Failed to load agent prompt file, using synthesis", { file: agentFile, message: e.message });
  }
  // 文件不存在或读取失败时，使用元数据合成
  if (agent) {
    return synthesizeAgentPrompt(agent);
  }
  return "You are a helpful assistant.";
}

/** 构建带意图识别的 Chat Messages */
export function buildAgentMessages(userInput: string, history: Array<{ role: string; content: string }> = []): {
  intent: IntentResult | null;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
} {
  const intent = recognizeIntent(userInput);
  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];

  if (intent) {
    const systemPrompt = loadAgentPrompt(intent.agent.file, intent.agent);
    messages.push({
      role: "system",
      content: `${systemPrompt}\n\n[Intent Detection] You are activated as "${intent.agent.emoji} ${intent.agent.name}" (${intent.intent}). User intent confidence: ${(intent.confidence * 100).toFixed(0)}%.`,
    });
    logger.info("[IntentRouter] Agent activated", {
      agent: intent.agent.name,
      intent: intent.intent,
      confidence: intent.confidence,
    });
  } else {
    messages.push({
      role: "system",
      content: "You are a helpful general assistant. Answer user questions accurately and concisely.",
    });
  }

  // 添加历史对话
  for (const h of history.slice(-6)) {
    messages.push({ role: h.role as any, content: h.content });
  }

  // 添加当前输入
  messages.push({ role: "user", content: userInput });

  return { intent, messages };
}

/** 列出所有可用 Agent 分类 */
export function listAgentCategories(): Record<string, number> {
  const agents = loadAgentsIndex();
  const cats: Record<string, number> = {};
  for (const a of agents) {
    const cat = a.category.split("\\").pop() || "unknown";
    cats[cat] = (cats[cat] || 0) + 1;
  }
  return cats;
}

/** 列出某分类下的 Agents */
export function listAgentsByCategory(category: string): AgentMeta[] {
  const agents = loadAgentsIndex();
  return agents.filter((a) => a.category.endsWith(category) || a.category.includes("\\" + category));
}
