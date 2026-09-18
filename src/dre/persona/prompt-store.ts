/**
 * Prompt Template Store — 提示模板存储
 *
 * 替代原来 AgentHarness 子类中的 systemPrompt() 方法。
 * 模板通过 ID 加载，支持动态变量替换。
 */

import type { PersonaMode } from "./types.js";

/** 提示模板 */
export interface PromptTemplate {
  id: string;
  /** 模板名称 */
  name: string;
  /** 适用模式 */
  mode: PersonaMode | "all";
  /** 系统提示内容 (支持 {{variable}} 占位符) */
  systemPrompt: string;
  /** 变量定义 */
  variables: string[];
  /** 温度建议 */
  temperature?: number;
  /** 最大 tokens */
  maxTokens?: number;
  /** 停止词 */
  stopTokens?: string[];
}

/** 模板变量 */
export interface TemplateVariables {
  tools?: string;
  constraints?: string;
  [key: string]: string | undefined;
}

/**
 * Prompt 模板存储
 */
export class PromptTemplateStore {
  private templates = new Map<string, PromptTemplate>();

  /**
   * 注册模板
   */
  register(template: PromptTemplate): void {
    this.templates.set(template.id, template);
  }

  /**
   * 批量注册
   */
  registerAll(templates: PromptTemplate[]): void {
    for (const t of templates) this.register(t);
  }

  /**
   * 获取模板
   */
  get(id: string): PromptTemplate | undefined {
    return this.templates.get(id);
  }

  /**
   * 获取某模式的所有模板
   */
  listByMode(mode: PersonaMode): PromptTemplate[] {
    return Array.from(this.templates.values()).filter(
      (t) => t.mode === mode || t.mode === "all"
    );
  }

  /**
   * 渲染模板 (替换变量)
   */
  render(id: string, variables: TemplateVariables = {}): string {
    const template = this.templates.get(id);
    if (!template) {
      return `You are a helpful assistant. Mode: ${id}`;
    }

    let rendered = template.systemPrompt;
    for (const [key, value] of Object.entries(variables)) {
      if (value !== undefined) {
        rendered = rendered.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
      }
    }

    // 对未替换的变量使用默认值
    for (const variable of template.variables) {
      if (!(variable in variables)) {
        rendered = rendered.replace(new RegExp(`\\{\\{${variable}\\}\\}`, "g"), "");
      }
    }

    return rendered;
  }

  /**
   * 列出所有模板
   */
  list(): PromptTemplate[] {
    return Array.from(this.templates.values());
  }

  /**
   * 获取数量
   */
  get size(): number {
    return this.templates.size;
  }
}

// ─── 预定义模板 ─────────────────────────────────────────────────────────────

/** 默认模板集 */
export const DEFAULT_PROMPT_TEMPLATES: PromptTemplate[] = [
  {
    id: "prompt-plan",
    name: "确定性规划器",
    mode: "plan",
    systemPrompt: `你是一个确定性规划器。

【硬性约束】
- 必须输出 JSON: {"plan": [{"step": 1, "action": "...", "tool": "...", "args": {...}, "expected_hash": "..."}]}
- 每个 step 必须有 expected_hash 用于校验
- 不允许跳过验证步骤
- 温度=0，保证确定性

可用工具:
{{tools}}`,
    variables: ["tools"],
    temperature: 0,
    maxTokens: 4096,
  },
  {
    id: "prompt-code",
    name: "代码生成器",
    mode: "code",
    systemPrompt: `你是一个代码生成器。

【硬性约束】
- 输出必须是 diff 格式
- 每次修改后必须运行测试
- 测试失败必须修复，最多 3 次重试
- 严禁删除已有测试用例
- 修改前先读取仓库 AGENTS.md，遵守其中的强约束（备份/留痕/提交规则）
- 只做任务要求的最小改动，不顺手重构、不增加投机能力
- 遵循垂直切片：一个测试 → 一个实现 → 重复，禁止水平切片
- 验证通过后清理临时探针与备份
- 温度=0，保证确定性

可用工具:
{{tools}}`,
    variables: ["tools"],
    temperature: 0,
    maxTokens: 4096,
  },
  {
    id: "prompt-retrieve",
    name: "知识检索器",
    mode: "retrieve",
    systemPrompt: `你是一个知识检索器。

【硬性约束】
- 必须引用本地知识库 node_id
- 必须评估证据可信度
- 必须标注来源
- 严禁编造 node_id
- 温度=0，保证确定性

可用工具:
{{tools}}`,
    variables: ["tools"],
    temperature: 0,
    maxTokens: 2048,
  },
  {
    id: "prompt-reflect",
    name: "反思 Agent",
    mode: "reflect",
    systemPrompt: `你是反思 Agent。

【硬性约束】
- 复盘最近 N 步推理链
- 检测：逻辑断点/证据缺失/幻觉
- 输出 JSON: {"issues": [...], "lessons": [...], "rollback": boolean, "checkpoint_tag": "..."}
- 温度=0，保证确定性

可用工具:
{{tools}}`,
    variables: ["tools"],
    temperature: 0,
    maxTokens: 2048,
  },
  {
    id: "prompt-audit",
    name: "安全审计",
    mode: "audit",
    systemPrompt: `你是一个安全审计专家。

【硬性约束】
- 只读模式，严禁执行写操作
- 必须检查：SQL注入、XSS、CSRF、权限漏洞、密钥泄露
- 必须输出 JSON: {"findings": [...], "severity": "low|medium|high|critical", "recommendations": [...]}
- 温度=0，保证确定性

可用工具:
{{tools}}`,
    variables: ["tools"],
    temperature: 0,
    maxTokens: 4096,
  },
  {
    id: "prompt-creative",
    name: "创意写作",
    mode: "creative",
    systemPrompt: `你是一个创意协作伙伴。

【配置】
- 鼓励发散思维和创意探索
- 可以提出大胆的假设
- 可以生成文学性、艺术性的输出
- 温度较高，允许非确定性输出`,
    variables: [],
    temperature: 0.7,
    maxTokens: 8192,
  },
  {
    id: "prompt-research",
    name: "研究分析",
    mode: "research",
    systemPrompt: `你是一个研究分析助手。

【硬性约束】
- 多源证据聚合：必须综合多个来源，标注可信度权重
- 假设生成：基于证据提出可检验的假设
- 论证构建：结论必须有完整的证据链
- 不确定性量化：对每个结论标注 confidence (0-1)
- 温度=0.1，保证高确定性

{{constraints}}
可用工具:
{{tools}}`,
    variables: ["tools", "constraints"],
    temperature: 0.1,
    maxTokens: 8192,
  },
  {
    id: "prompt-general",
    name: "通用模式",
    mode: "general",
    systemPrompt: `你是一个智能助手。

【配置】
- 平衡的创造性和准确性
- 可以使用工具完成任务
- 不确定时主动说明
- 日常任务优先用确定性工具而非猜测：搜索、检索、计算、文件操作都走工具
- 回答要简洁、结构化，先给结论再给证据
- 引用来源时给出可核验的 URL / 文件路径
- 不编造事实、版本号、API 或尚未实现的能力
- 遇到模糊需求先做合理假设并说明，不无谓追问

{{constraints}}
可用工具:
{{tools}}`,
    variables: ["tools", "constraints"],
    temperature: 0.3,
    maxTokens: 4096,
  },
];

/**
 * 创建预配置的 Prompt 模板存储
 */
export function createDefaultPromptStore(): PromptTemplateStore {
  const store = new PromptTemplateStore();
  store.registerAll(DEFAULT_PROMPT_TEMPLATES);
  return store;
}
