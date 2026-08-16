/**
 * 任务强化回归测试 — 6 个新增 held-out 硬任务 + 3 个加固校验器：
 * 完整答案通过、缺关键概念仍失败（防作弊不放松）。
 */
import { describe, it, expect } from "bun:test";
import { ALL_AGENT_TASKS } from "../../src/agent-evals/tasks.js";

function find(id: string) {
  const task = ALL_AGENT_TASKS.find((t) => t.id === id);
  expect(task, `${id} 存在`).toBeDefined();
  return task!;
}

describe("新增硬任务：CODING-08 带退避重试", () => {
  const task = find("CODING-08");
  it("含 fetch/重试/退避等待/复杂度 的完整答案通过", () => {
    const ans = `async function fetchWithRetry(url) {
      let delay = 100;
      for (let i = 0; i < 3; i++) {
        try { return await fetch(url); }
        catch (e) { await new Promise((r) => setTimeout(r, delay)); delay *= 2; }
      }
      throw new Error("failed");
    }
    时间复杂度 O(1)，空间复杂度 O(1)。`;
    expect(task.verify(ans).passed).toBe(true);
  });
  it("无重试/退避逻辑仍失败", () => {
    expect(task.verify("async function fetchWithRetry(url){ return fetch(url); }").passed).toBe(false);
  });
});

describe("新增硬任务：KNOW-08 混合检索", () => {
  const task = find("KNOW-08");
  it("BM25+向量+RRF 融合 的完整答案通过", () => {
    expect(task.verify("混合检索结合 BM25 关键词匹配与向量 embedding 的语义召回，再用 RRF 融合排序，兼顾精确率与召回率。").passed).toBe(true);
  });
  it("只提纯向量检索仍失败", () => {
    expect(task.verify("向量检索能找语义相近的内容。").passed).toBe(false);
  });
});

describe("新增硬任务：PLAN-08 DR 演练", () => {
  const task = find("PLAN-08");
  it("备份/恢复/RTO/复盘 的完整答案通过", () => {
    expect(task.verify("目标：验证备份可恢复；准备：定期备份并记录 RTO/RPO；步骤：校验备份→注入故障→恢复→测量 RTO/RPO→复盘。").passed).toBe(true);
  });
  it("缺 RTO/RPO 指标仍失败", () => {
    expect(task.verify("做好备份，定期恢复。").passed).toBe(false);
  });
});

describe("新增硬任务：TOOL-08 Docker 排障", () => {
  const task = find("TOOL-08");
  it("docker ps/logs/inspect/exec 的完整答案通过", () => {
    expect(task.verify("先 docker ps -a 看退出状态，再 docker logs 看启动日志，docker inspect 看配置与健康检查，必要时 docker exec 进容器诊断，定位根因。").passed).toBe(true);
  });
  it("无 docker 命令仍失败", () => {
    expect(task.verify("容器退出了。").passed).toBe(false);
  });
});

describe("新增硬任务：MEM-08 多轮状态整合", () => {
  const task = find("MEM-08");
  it("包含 3306/20/5/MySQL 的配置答案通过", () => {
    expect(task.verify("MySQL 连接配置：{ host: 'db', port: 3306, connectTimeout: 5000, poolSize: 20 }。端口来自第①轮，超时来自第②轮，池上限来自第③轮。").passed).toBe(true);
  });
  it("漏超时值仍失败", () => {
    expect(task.verify("MySQL 端口 3306，连接池 20。").passed).toBe(false);
  });
});

describe("新增硬任务：EVOLVE-08 跨案例抽象", () => {
  const task = find("EVOLVE-08");
  it("收集/处理/汇总/适用 的通用原则通过", () => {
    expect(task.verify("通用原则：先收集原始材料，再处理（分块/解析），最后汇总生成；适用于任何「多源→结构化输出」任务。").passed).toBe(true);
  });
  it("缺收集维度仍失败", () => {
    expect(task.verify("先总结再生成。").passed).toBe(false);
  });
});

describe("校验器降噪：EVOLVE-07 因果表述（无需字面 根因/原因）", () => {
  const task = find("EVOLVE-07");
  it("完整复盘用「导致/引发/叠加」表述通过", () => {
    const ans = "What：配置错误被发布，叠加无监控与无回滚预案，导致故障扩大。Why：配置错误直接引发异常，缺乏监控使异常未被发现。How：人工定位并修复。预防措施：审核+灰度+监控+回滚预案。";
    expect(task.verify(ans).passed).toBe(true);
  });
  it("无因果分析仍失败", () => {
    expect(task.verify("What：故障。How：修复。预防措施：监控。").passed).toBe(false);
  });
});

describe("加固校验器：TOOL-03 需完整输出", () => {
  const task = find("TOOL-03");
  it("fetch+打印+状态码 的完整答案通过", () => {
    expect(task.verify("const res = await fetch(url); console.log(res.status, (await res.text()).slice(0, 200));").passed).toBe(true);
  });
  it("仅提 fetch 不再通过（加固）", () => {
    expect(task.verify("用 fetch。").passed).toBe(false);
  });
});

describe("加固校验器：EVOLVE-02 需模式内容", () => {
  const task = find("EVOLVE-02");
  it("模式+分块/摘要 的完整归纳通过", () => {
    expect(task.verify("共同模式：都是先抽取文本→分块→调摘要模型→汇总，可复用。").passed).toBe(true);
  });
  it("仅提模式一词不再通过（加固）", () => {
    expect(task.verify("它们的模式是先分析。").passed).toBe(false);
  });
});

describe("加固校验器：EVOLVE-04 需教训内容", () => {
  const task = find("EVOLVE-04");
  it("限流/重试+处理/降级 的完整教训通过", () => {
    expect(task.verify("共同教训：调用 API 必须处理限流与超时，做好重试与降级。").passed).toBe(true);
  });
  it("仅提重试不再通过（加固）", () => {
    expect(task.verify("要重试。").passed).toBe(false);
  });
});
