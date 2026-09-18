/**
 * Phase B 真实场景测试集 — tasks.ts 内容层（扩展现有 6 族，+12 任务）。
 * 取材 Agent 真实使用规范：角色面（code-review/research/architecture/decision/tool-use/computer-use）
 * + 工程纪律面（AGENTS 规则 1/2/9 最小改动/备份/安全护栏）+ 自进化机制（--evolve 闭环、rule 6 调试纪律）
 * + Agent 本体知识（model-router 路由、web_search 工具 schema）。
 * 全部为纯函数判定，无 provider 调用、无网络请求。
 */
import { describe, expect, it } from "bun:test";
import { ALL_AGENT_TASKS, validateTasks } from "../../src/agent-evals/tasks.js";
import type { AgentTask, TaskContext } from "../../src/agent-evals/tasks.js";

function find(id: string): AgentTask {
  const task = ALL_AGENT_TASKS.find((x) => x.id === id);
  expect(task, `${id} 存在于 ALL_AGENT_TASKS`).toBeDefined();
  return task!;
}

/** 断言派生 verify 闭包（同步返回，但按 runner 口径 await 一层） */
async function check(task: AgentTask, response: string) {
  const v = await task.verify(response, { task } satisfies TaskContext);
  expect(v).toEqual(expect.objectContaining({ passed: expect.any(Boolean) }));
  return v;
}

// ===== 遍历断言：12 个真实场景任务存在 + 质量门 =====
describe("真实场景任务：存在性与质量门", () => {
  const REAL_IDS = [
    "CODING-10", "CODING-11", "KNOW-10", "KNOW-11",
    "PLAN-10", "PLAN-11", "TOOL-10", "TOOL-11",
    "MEM-10", "MEM-11", "EVOLVE-10", "EVOLVE-11",
  ];
  it("12 个真实场景任务全部存在于 ALL_AGENT_TASKS", () => {
    for (const id of REAL_IDS) expect(find(id).id, id).toBe(id);
  });
  it("全部使用声明式 assert（S4 风格）+ 非空 expectedBehavior + 有限 maxTokens", () => {
    for (const id of REAL_IDS) {
      const t = find(id);
      expect(t.assert, `${id} assert 声明`).toBeDefined();
      expect(typeof t.expectedBehavior === "string" && t.expectedBehavior.trim().length > 0, `${id} expectedBehavior`).toBe(true);
      expect(t.maxTokens, `${id} maxTokens`).toBeGreaterThan(0);
      expect(typeof t.verify, `${id} verify`).toBe("function");
    }
  });
  it("每族新增任务保持 train + held-out 平衡（validateTasks 0 错误）", () => {
    expect(validateTasks()).toEqual([]);
  });
  it("新增任务不破坏既有 54 任务（任务总数 = 66）", () => {
    expect(ALL_AGENT_TASKS.length).toBe(66);
    for (const id of REAL_IDS) {
      const family = find(id).family;
      const same = ALL_AGENT_TASKS.filter((x) => x.family === family);
      expect(same.filter((x) => x.split === "train").length, `${family} train 非空`).toBeGreaterThan(0);
      expect(same.filter((x) => x.split === "held-out").length, `${family} held-out 非空`).toBeGreaterThan(0);
    }
  });
});

// ===== CODING-10 工程纪律：改动前备份流程 =====
describe("CODING-10 改动前备份流程（规则 2）", () => {
  const task = find("CODING-10");
  it("完整流程（备份→验证→清理）通过", async () => {
    const ans =
      "修改 src/utils/config.ts 前，先备份到 .tmp/backups/ 对应相对路径；修改后运行相关测试与类型检查验证；验证通过后删除备份。";
    expect((await check(task, ans)).passed).toBe(true);
  });
  it("漏掉备份步骤失败", async () => {
    const r = await check(task, "直接修改文件，然后运行测试验证。");
    expect(r.passed).toBe(false);
    expect(r.reason).toContain("缺少任一概念");
  });
});

// ===== CODING-11 规则1 最小改动判定 =====
describe("CODING-11 最小改动判定（规则 1）", () => {
  const task = find("CODING-11");
  it("指出越界并判定不合规通过", async () => {
    const ans = "该提交不合规：顺手重命名无关变量与重构工具函数，越出最小改动范围，应只改 bug 相关代码。";
    expect((await check(task, ans)).passed).toBe(true);
  });
  it("仅作中性描述（无判定）失败", async () => {
    const r = await check(task, "这个提交包含了一些变量重命名。");
    expect(r.passed).toBe(false);
    expect(r.reason).toContain("缺少任一概念");
  });
});

// ===== KNOW-10 model-router 路由与降级 =====
describe("KNOW-10 model-router TaskRole 路由与 fallback", () => {
  const task = find("KNOW-10");
  it("角色路由 + fallback 降级通过", async () => {
    const ans = "model-router 按 TaskRole 匹配绑定模型，主模型失败时 fallback 到备用模型。";
    expect((await check(task, ans)).passed).toBe(true);
  });
  it("未提角色/模型路由失败", async () => {
    const r = await check(task, "直接用最快的模型回答问题。");
    expect(r.passed).toBe(false);
    expect(r.reason).toContain("缺少任一概念");
  });
});

// ===== KNOW-11 AGENTS 规则9 git 安全护栏 =====
describe("KNOW-11 git 安全护栏（规则 9，≥2 条）", () => {
  const task = find("KNOW-11");
  it("列出 force push + reset --hard 两条通过", async () => {
    expect((await check(task, "规则 9 禁止 git push --force 与 git reset --hard。")).passed).toBe(true);
  });
  it("只列一条被禁操作失败（需 ≥2 条）", async () => {
    const r = await check(task, "规则 9 禁止 git push --force。");
    expect(r.passed).toBe(false);
    expect(r.reason).toContain("缺少任一概念");
  });
  it("未列任何被禁操作失败", async () => {
    const r = await check(task, "git 提交前要先 add。");
    expect(r.passed).toBe(false);
  });
});

// ===== PLAN-10 code-review 角色流程 =====
describe("PLAN-10 code-review 角色评审流程", () => {
  const task = find("PLAN-10");
  it("覆盖 diff/评审/建议/复核四环节通过", async () => {
    const ans = "先读 diff 与上下文，再按工程纪律评审改动，给出建议，最后复核修改是否落地。";
    expect((await check(task, ans)).passed).toBe(true);
  });
  it("缺建议/复核环节失败", async () => {
    const r = await check(task, "看一下改了什么。");
    expect(r.passed).toBe(false);
  });
});

// ===== PLAN-11 自进化闭环评测规划 =====
describe("PLAN-11 self-evolve 闭环评测规划", () => {
  const task = find("PLAN-11");
  it("覆盖 train/归纳/held-out 注入/回归 四环节通过", async () => {
    const ans = "先跑 train 基线，再归纳技能，再在 held-out 上对比注入效果，最后做回归检测。";
    expect((await check(task, ans)).passed).toBe(true);
  });
  it("缺技能归纳与回归环节失败", async () => {
    const r = await check(task, "跑一遍所有任务看通过率。");
    expect(r.passed).toBe(false);
    expect(r.reason).toContain("缺少任一概念");
  });
});

// ===== TOOL-10 web_search 工具参数构造 =====
describe("TOOL-10 web_search JSON 参数（含 query 键）", () => {
  const task = find("TOOL-10");
  it("输出含 query 键的 JSON 通过（代码块包裹同样通过）", async () => {
    expect((await check(task, '{"query": "2026 RAG 最新综述"}')).passed).toBe(true);
    expect((await check(task, '```json\n{"query": "2026 RAG survey"}\n```')).passed).toBe(true);
  });
  it("缺 query 键失败", async () => {
    const r = await check(task, '{"model": "glm-4.7-flash"}');
    expect(r.passed).toBe(false);
    expect(r.reason).toContain("JSON 缺少键");
  });
  it("无 JSON 结构失败", async () => {
    const r = await check(task, "我建议检索 RAG 相关的最新论文。");
    expect(r.passed).toBe(false);
    expect(r.reason).toContain("未找到有效 JSON 对象");
  });
});

// ===== TOOL-11 容器排障命令序 =====
describe("TOOL-11 容器启动即退出排障", () => {
  const task = find("TOOL-11");
  it("docker ps -a + docker logs 两步通过", async () => {
    const ans = "先 docker ps -a 看容器状态与退出码，再 docker logs 看启动日志定位原因。";
    expect((await check(task, ans)).passed).toBe(true);
  });
  it("缺日志查看环节失败", async () => {
    const r = await check(task, "重启一下容器试试。");
    expect(r.passed).toBe(false);
    expect(r.reason).toContain("缺少任一概念");
  });
});

// ===== MEM-10 角色+模型约束保持（JSON 键） =====
describe("MEM-10 JSON 约束保持（model/costUsd）", () => {
  const task = find("MEM-10");
  it("含 model 与 costUsd 键的 JSON 通过", async () => {
    expect((await check(task, '{"model": "glm-4.7-flash", "costUsd": 0}')).passed).toBe(true);
  });
  it("缺 costUsd 键失败", async () => {
    const r = await check(task, '{"model": "glm-4.7-flash"}');
    expect(r.passed).toBe(false);
    expect(r.reason).toContain("JSON 缺少键");
  });
});

// ===== MEM-11 多约束整合（opencode + deepseek + 并发2 + 重试2） =====
describe("MEM-11 多约束整合配置", () => {
  const task = find("MEM-11");
  it("JSON 形式四值齐备通过", async () => {
    const ans = '{"provider": "opencode", "model": "deepseek-v4-flash", "concurrency": 2, "retry": 2}';
    expect((await check(task, ans)).passed).toBe(true);
  });
  it("key=value 形式四值齐备通过", async () => {
    const ans = "provider=opencode model=deepseek-v4-flash concurrency=2 retry=2";
    expect((await check(task, ans)).passed).toBe(true);
  });
  it("漏掉 provider/并发约束失败", async () => {
    const r = await check(task, '{"model": "deepseek-v4-flash"}');
    expect(r.passed).toBe(false);
  });
});

// ===== EVOLVE-10 从 eval 失败提炼教训 =====
describe("EVOLVE-10 从失败提炼教训（含「下次」）", () => {
  const task = find("EVOLVE-10");
  it("含「下次」+ 参数检查的可复用教训通过", async () => {
    const ans = "下次工具调用必须显式输出 JSON 参数，不能只描述意图。";
    expect((await check(task, ans)).passed).toBe(true);
  });
  it("缺「下次」表述失败", async () => {
    const r = await check(task, "工具调用应当提供 JSON 参数。");
    expect(r.passed).toBe(false);
    expect(r.reason).toContain("缺少任一概念");
  });
});

// ===== EVOLVE-11 调试纪律 rule6：先建回路再提假设 =====
describe("EVOLVE-11 调试纪律（先反馈回路再假设）", () => {
  const task = find("EVOLVE-11");
  it("先复现回路、再提假设通过", async () => {
    const ans = "第一步先写一条能稳定复现该 bug 的命令；第二步再提出可证伪的假设。";
    expect((await check(task, ans)).passed).toBe(true);
  });
  it("跳过回路直接猜原因失败", async () => {
    const r = await check(task, "我怀疑是缓存问题，直接改缓存逻辑。");
    expect(r.passed).toBe(false);
    expect(r.reason).toContain("缺少任一概念");
  });
});
