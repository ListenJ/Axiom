/**
 * S4 任务集质量强化 — tasks.ts 内容层（assert 声明式断言 + expectedBehavior 质量门）。
 * 覆盖：
 *  1. 6 个新任务（CODING-09/KNOW-09/PLAN-09/TOOL-09/MEM-09/EVOLVE-09）已知通过 + 已知失败
 *  2. 遍历断言：48 个既有任务的 expectedBehavior 均为非空字符串
 *  3. validateTasks 新规则定向红绿：畸形 assert（未知字段/空 spec/越界/非法正则）+ 缺 expectedBehavior
 *  4. t() overload 契约：显式 verify 闭包与 assert 派生闭包的可区分性
 *  5. 派生闭包 reason 文案（fail-closed 桩 / 首败短路 reason / 不污染 [ERROR] 执行错误口径）
 *  全部为纯函数判定，无 provider 调用、无网络请求。
 */
import { describe, expect, it } from "bun:test";
import { ALL_AGENT_TASKS, validateTasks } from "../../src/agent-evals/tasks.js";
import { compileAssertion } from "../../src/agent-evals/verify.js";
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

// ===== 遍历断言：S4 质量门 =====
describe("S4 质量门：expectedBehavior 覆盖", () => {
  it("ALL_AGENT_TASKS 每个任务 expectedBehavior 均为非空字符串", () => {
    const missing = ALL_AGENT_TASKS.filter(
      (t) => typeof t.expectedBehavior !== "string" || t.expectedBehavior.trim().length === 0,
    );
    expect(missing.map((t) => t.id)).toEqual([]);
  });
});

// ===== 新任务：CODING-09 单值精确数值断言 =====
describe("新任务：CODING-09 1MiB 字节数（单值精确断言）", () => {
  const task = find("CODING-09");
  it("assert 声明可序列化且 verify 由 compileAssertion 派生", () => {
    expect(task.assert).toEqual({ mustReturnNumber: { min: 1048576, max: 1048576 } });
    expect(typeof task.verify).toBe("function");
  });
  it("末尾数字为 1048576 时通过", async () => {
    expect((await check(task, "1 MiB = 1024 × 1024 字节 = 1048576。")).passed).toBe(true);
  });
  it("1000000（十进制误答）失败", async () => {
    const r = await check(task, "1 MiB = 1000000 字节。");
    expect(r.passed).toBe(false);
    expect(r.reason).toContain("数值越界");
  });
  it("不给数字（定性回答）失败", async () => {
    const r = await check(task, "1 MiB 是计算机存储的容量单位。");
    expect(r.passed).toBe(false);
    expect(r.reason).toContain("数值越界");
  });
  it("完全不出现数字也失败（未找到数字）", async () => {
    const r = await check(task, "Mebibyte 是二进制容量单位，按二进制定义。");
    expect(r.passed).toBe(false);
    expect(r.reason).toContain("未找到数字");
  });
  it("取末尾数字：1 MiB = 1024 * 1024 = 1048576 也通过", async () => {
    expect((await check(task, "计算过程：1024 * 1024 = 1048576 字节。")).passed).toBe(true);
  });
});

// ===== 新任务：TOOL-09 IEEE754 数值区间 =====
describe("新任务：TOOL-09 0.1 + 0.2 精确结果（数值区间断言）", () => {
  const task = find("TOOL-09");
  it("断言为开区间 [0.3, 0.30000000000000005]，允许 0.3 / 0.30000000000000004 / 完整尾数", () => {
    expect(task.assert).toEqual({ mustReturnNumber: { min: 0.3, max: 0.30000000000000005 } });
  });
  it("三种正确表达均通过", async () => {
    for (const ans of [
      "等于 0.30000000000000004",
      "结果约为 0.3",
      "精确二进制值：0.30000000000000004440892098500626",
    ]) {
      expect((await check(task, ans)).passed, ans).toBe(true);
    }
  });
  it("断言「等于 0.3」且省略浮点误差解释时仍通过（区间下界含 0.3）", async () => {
    expect((await check(task, "0.1 + 0.2 = 0.3")).passed).toBe(true);
  });
  it("整数误答 1 失败", async () => {
    const r = await check(task, "0.1 + 0.2 = 1。");
    expect(r.passed).toBe(false);
    expect(r.reason).toContain("数值越界");
  });
  it("未给出具体数值失败", async () => {
    const r = await check(task, "建议使用 decimal.js 库处理浮点运算。");
    expect(r.passed).toBe(false);
    expect(r.reason).toContain("数字");
  });
});

// ===== 新任务：KNOW-09 长度区间 + 必含术语 =====
describe("新任务：KNOW-09 CAP 定理（长度区间 + 必含术语）", () => {
  const task = find("KNOW-09");
  it("spec 包含 outputLength 与 containsAll", () => {
    expect(task.assert?.outputLength).toEqual({ min: 15, max: 200 });
    expect(task.assert?.containsAll).toEqual(["一致性", "可用性", "分区容错性"]);
  });
  it("两三句完整解释通过", async () => {
    const ans =
      "CAP 定理指出，分布式系统在一致性（Consistency）、可用性（Availability）、分区容错性（Partition Tolerance）三者中最多只能同时保证两个。分区容错性是分布式网络下无法回避的现实，因此实际取舍通常落在 CP 或 AP 之间。";
    expect((await check(task, ans)).passed).toBe(true);
  });
  it("只提一致性/可用性、漏分区容错性失败", async () => {
    const r = await check(task, "CAP 定理说明分布式系统只能在一致性与可用性之间二选一，因为网络分区不可避免。");
    expect(r.passed).toBe(false);
    expect(r.reason).toContain("缺少关键内容");
  });
  it("术语齐全但回答过短失败", async () => {
    const r = await check(task, "一致性、可用性、分区容错性。");
    expect(r.passed).toBe(false);
    expect(r.reason).toContain("响应过短");
  });
  it("超出长度上限（超过 200 字）失败", async () => {
    const long = ("一致性 可用性 分区容错性 分布式系统的取舍权衡。").repeat(10);
    expect((await check(task, long)).passed).toBe(false);
  });
});

// ===== 新任务：PLAN-09 正则匹配 + 长度上限 =====
describe("新任务：PLAN-09 发布检查清单（正则 + 长度上限）", () => {
  const task = find("PLAN-09");
  it("正则可编译且为编号步骤前缀", () => {
    expect(task.assert?.matchesAll).toEqual(["^\\d+[.、]\\s*"]);
    expect(task.assert?.outputLength).toEqual({ max: 400 });
    expect(new RegExp(task.assert!.matchesAll![0]).test("1. 冒烟测试")).toBe(true);
    expect(new RegExp(task.assert!.matchesAll![0]).test("1、冒烟测试")).toBe(true);
    expect(new RegExp(task.assert!.matchesAll![0]).test("一、冒烟测试")).toBe(false);
  });
  it("3-5 个编号步骤通过（首个编号步骤位于响应开头）", async () => {
    const ans =
      "1. 执行冒烟测试，确认核心流程可用\n2. 核对回滚点，确认上一稳定版本可部署\n3. 校验灰度开关与配置项已按目标环境设置\n4. 确认监控与告警阈值已就位\n5. 由值班人签署上线确认";
    expect((await check(task, ans)).passed).toBe(true);
  });
  it("正则无 m flag：仅首个编号步骤需位于开头", async () => {
    const r = await check(task, "发布前检查清单：\n1. 执行冒烟测试\n2. 核对回滚点");
    expect(r.passed).toBe(false);
    expect(r.reason).toContain("未匹配模式");
  });
  it("无编号前缀失败", async () => {
    const r = await check(task, "先做冒烟测试，然后检查回滚点，最后确认配置无误即可上线。");
    expect(r.passed).toBe(false);
    expect(r.reason).toContain("未匹配模式");
  });
  it("超长清单失败", async () => {
    const long = Array.from({ length: 20 }, (_, i) => `${i + 1}. 检查项 ${i + 1}，需要逐项确认配置、开关、监控与回滚点是否就绪。`).join("\n");
    const r = await check(task, long);
    expect(r.passed).toBe(false);
    expect(r.reason).toContain("响应过长");
  });
});

// ===== 新任务：MEM-09 JSON 键 + 正值 =====
describe("新任务：MEM-09 记忆状态快照（JSON 键 + 正值断言）", () => {
  const task = find("MEM-09");
  it("spec 同时含 hasJSONKeys 与 mustReturnNumber.positive", () => {
    expect(task.assert?.hasJSONKeys).toEqual(["count"]);
    expect(task.assert?.mustReturnNumber).toEqual({ positive: true });
  });
  it("含 count 键且为正值的 JSON 通过（代码块包裹同样通过）", async () => {
    expect((await check(task, '当前记忆状态：{"topic":"支付模块","count":3}')).passed).toBe(true);
    expect((await check(task, '```json\n{"count": 7, "topic": "缓存淘汰策略"}\n```')).passed).toBe(true);
  });
  it("count 为 0 失败（positive 要求 > 0）", async () => {
    const r = await check(task, '{"count": 0}');
    expect(r.passed).toBe(false);
    expect(r.reason).toContain("数值非正");
  });
  it("count 为负数失败", async () => {
    expect((await check(task, '{"count": -2}')).passed).toBe(false);
  });
  it("缺少 count 键失败（AND 顺序：无数字先报未找到数字）", async () => {
    const r = await check(task, '{"topic": "支付模块"}');
    expect(r.passed).toBe(false);
    expect(r.reason).toContain("未找到数字");
  });
  it("hasJSONKeys 单独判定：缺 count 键即失败", async () => {
    const r = compileAssertion({ hasJSONKeys: ["count"] })('{"topic": "支付模块"}');
    expect(r.passed).toBe(false);
    expect(r.reason).toContain("JSON 缺少键");
  });
  it("无 JSON 结构失败（AND 顺序：正向数值先过，JSON 校验命中）", async () => {
    const r = await check(task, "我记得 3 条相关信息。");
    expect(r.passed).toBe(false);
    expect(r.reason).toContain("未找到有效 JSON 对象");
  });
  it("hasJSONKeys 单独判定：无 JSON 对象即失败", async () => {
    const r = compileAssertion({ hasJSONKeys: ["count"] })("我记得 3 条相关信息。");
    expect(r.passed).toBe(false);
    expect(r.reason).toContain("未找到有效 JSON 对象");
  });
});

// ===== 新任务：EVOLVE-09 多组同义词 + 编号条数（组合断言，2026-09-05 校准） =====
describe("新任务：EVOLVE-09 经验归纳（多组同义词 + 编号条数正则）", () => {
  const task = find("EVOLVE-09");
  // 校准依据（2026-09-05 干净重跑原文）：zhipu glm-4.7-flash 用中文序号「规则一/规则二」、
  // sensenova 用「规则 1/2/3」，均含验证动作 + 回滚确认点，属合格回答；原断言
  // （必须字面「下次」+ 数字 ≥2，extractLastNumber 只取最后一个数字 token）双双误伤。
  // 放宽为「改动上下文 / 验证 / 回滚」三组同义词 + 「≥2 编号标记」正则（替代 mustReturnNumber）。
  it("spec：containsAllAny（改动/验证/回滚三组）+ matchesAll 编号对正则", () => {
    expect(task.assert?.containsAllAny).toHaveLength(3);
    expect(task.assert?.containsAllAny![0]).toContain("改动");
    expect(task.assert?.containsAllAny![1]).toContain("验证");
    expect(task.assert?.containsAllAny![2]).toContain("回滚");
    expect(task.assert?.matchesAll).toHaveLength(1);
    expect(typeof task.verify).toBe("function");
  });
  it("真实样本：zhipu 中文序号（规则一/规则二）+ 验证动作 + 回滚确认点通过", async () => {
    const ans =
      "基于近期常见的改动风险（如配置变更、代码发布、数据迁移），归纳出以下两条可复用的规则：\n" +
      "### 规则一：针对“配置或参数类”改动\n**验证动作：**在灰度环境或预发环境，使用最小化流量进行一次全链路模拟，确认系统在改动参数下的响应时间和错误率符合预期。\n**回滚确认点：**确认配置回滚脚本或命令在本地已验证通过，且配置中心的回滚开关处于可用状态。\n" +
      "### 规则二：针对“代码或逻辑类”改动\n**验证动作：**在上线前，在测试环境执行一次全量回归测试，确保改动未引入新的边界条件 Bug。\n**回滚确认点：**确认构建产物的版本标签已正确打上，且回滚版本已在发布流水线中预先构建并锁定。";
    expect((await check(task, ans)).passed).toBe(true);
  });
  it("真实样本：sensenova 阿拉伯序号（规则 1/2/3）+ 先验证什么 + 回滚路径通过", async () => {
    const ans =
      "基于近期三条改动经验，可归纳为以下可复用规则：\n" +
      "## 规则 1：外部接口/协议改动\n- **先验证什么**：用旧版调用方/客户端真实请求打到新接口上，确认返回格式、字段、错误码仍然兼容。\n- **提前确认哪条回滚路径**：确认有按流量/按用户的开关可一键切回旧逻辑，而不是依赖重新部署整个服务。\n" +
      "## 规则 2：数据表结构/数据迁移改动\n- **先验证什么**：在临时库上连续执行两次迁移脚本，确认第二次执行是幂等空操作。\n- **提前确认哪条回滚路径**：确认已备份迁移前数据，且备份可恢复；确认数据库迁移脚本有明确的降级脚本。\n" +
      "## 规则 3：配置/权限类改动\n- **先验证什么**：在测试环境模拟真实用户身份，验证改动后的配置或权限在原有权限范围下仍能正常工作。\n- **提前确认哪条回滚路径**：确认配置中心保留该配置的历史版本，能一键回滚到改动前值。";
    expect((await check(task, ans)).passed).toBe(true);
  });
  it("三条可验证回滚规则 + 包含「下次」的完整归纳通过", async () => {
    const ans =
      "下次改动前必须先验证，再小步发布，并提前确认回滚路径可用。\n1. 新增配置项前先验证默认值在灰度环境生效\n2. 修改数据库 schema 前先验证索引与查询计划\n3. 调整限流阈值前先验证告警阈值不被误触发";
    expect((await check(task, ans)).passed).toBe(true);
  });
  it("漏掉「回滚」维度失败", async () => {
    const r = await check(task, "下次改动前先验证默认值，再验证告警阈值。");
    expect(r.passed).toBe(false);
    expect(r.reason).toContain("缺少任一概念");
  });
  it("缺改动/下次上下文失败", async () => {
    const r = await check(task, "先验证默认值，再验证告警阈值，同时提前确认回滚路径可用。");
    expect(r.passed).toBe(false);
    expect(r.reason).toContain("缺少任一概念");
  });
  it("概念齐全但未列出编号规则失败", async () => {
    const r = await check(task, "下次改动要先验证，并且要提前确认回滚路径可用。");
    expect(r.passed).toBe(false);
    expect(r.reason).toContain("未匹配模式");
  });
  it("规则条数不足（仅 1 条）失败", async () => {
    const r = await check(task, "下次改动前先验证，并确认回滚路径可用。共 1 条规则。");
    expect(r.passed).toBe(false);
    expect(r.reason).toContain("未匹配模式");
  });
});

// ===== t() overload 契约 =====
describe("t() overload 契约：verify 闭包 vs assert 派生", () => {
  it("每个任务 verify 都是函数（显式闭包与派生闭包同形）", () => {
    for (const task of ALL_AGENT_TASKS) {
      expect(typeof task.verify, task.id).toBe("function");
    }
  });
  it("既有 48 个显式 verify 任务 assert === undefined（按属性计数，不依赖 id 后缀）", () => {
    const legacy = ALL_AGENT_TASKS.filter((t) => t.assert === undefined);
    expect(legacy.length).toBe(48);
    expect(legacy.every((t) => t.assert === undefined)).toBe(true);
  });
  it("全部 assert 任务（-09 六 + 真实场景 12 = 18 个）assert === 传入的 spec，且派生闭包与 compileAssertion 结果等价", async () => {
    const assertTasks = ALL_AGENT_TASKS.filter((t) => t.assert !== undefined);
    expect(assertTasks.length).toBe(18);
    for (const task of assertTasks) {
      expect(task.assert, task.id).not.toBeUndefined();
      const reference = compileAssertion(task.assert!);
      const probe = ["1. 第一步\n2. 第二步", '{"count": 3}', "结果是 42", "无有效内容"];
      for (const p of probe) {
        const got = await task.verify(p);
        expect(got.passed, `${task.id} vs ${p}`).toBe(reference(p).passed);
      }
    }
  });
});

// ===== validateTasks 新规则 =====
describe("validateTasks 新增配置规则", () => {
  const base = {
    id: "T",
    family: "coding" as const,
    split: "train" as const,
    title: "t",
    prompt: "p",
    verify: () => ({ passed: true }),
    expectedBehavior: "e",
  };
  const shell = (overrides: Partial<AgentTask>, id = "T") =>
    validateTasks([...ALL_AGENT_TASKS, { ...base, id, ...overrides }]);

  it("含 assert 的任务：未知字段拒绝", () => {
    const errs = shell({ id: "BAD-1", assert: { bogus: true } as never });
    expect(errs.some((e) => e.startsWith("BAD-1:") && e.includes("未知字段"))).toBe(true);
  });
  it("含 assert 的任务：空 spec 拒绝", () => {
    const errs = shell({ id: "BAD-2", assert: {} });
    expect(errs.some((e) => e.startsWith("BAD-2:") && e.includes("assert 为空"))).toBe(true);
  });
  it("含 assert 的任务：mustReturnNumber min > max 拒绝", () => {
    const errs = shell({ id: "BAD-3", assert: { mustReturnNumber: { min: 5, max: 1 } } });
    expect(errs.some((e) => e.startsWith("BAD-3:") && e.includes("mustReturnNumber"))).toBe(true);
  });
  it("含 assert 的任务：非法正则源码拒绝", () => {
    const errs = shell({ id: "BAD-4", assert: { matchesAll: ["("] } });
    expect(errs.some((e) => e.startsWith("BAD-4:") && (e.includes("无法编译") || e.includes("正则")))).toBe(true);
  });
  it("缺 expectedBehavior 时拒绝", () => {
    const errs = shell({ id: "BAD-5", expectedBehavior: undefined });
    expect(errs.some((e) => e.startsWith("BAD-5:") && e.includes("缺少 expectedBehavior"))).toBe(true);
  });
  it("expectedBehavior 为空串/纯空白也拒绝", () => {
    const errs = shell({ id: "BAD-6", expectedBehavior: "   " });
    expect(errs.some((e) => e.startsWith("BAD-6:") && e.includes("缺少 expectedBehavior"))).toBe(true);
  });
  it("合法 assert + expectedBehavior 不误伤（返回空数组）", () => {
    const errs = shell({
      id: "OK-1",
      assert: { containsAll: ["x"], outputLength: { min: 1, max: 100 } },
    });
    expect(errs).toEqual([]);
  });
  it("既有断言（重复 id / missing verify / split / 族覆盖）在新规则下仍生效", () => {
    const dups = validateTasks([...ALL_AGENT_TASKS, { ...base, id: "CODING-01", expectedBehavior: "dup" }]);
    expect(dups.some((e) => e.includes("duplicate id"))).toBe(true);
    const noVerify = validateTasks([...ALL_AGENT_TASKS, { ...base, id: "X-1", verify: undefined as never, expectedBehavior: "v" }]);
    expect(noVerify.some((e) => e.includes("missing verify"))).toBe(true);
  });
});

// ===== 派生闭包边界：reason 口径 =====
describe("派生闭包 reason 口径（执行错误短路不受污染）", () => {
  it("畸形 spec 的 fail-closed 桩 reason 不含 [ERROR] 前缀", () => {
    const r = compileAssertion({ bogus: true } as never)("任何回答");
    expect(r.passed).toBe(false);
    expect(r.reason).toContain("断言配置非法");
    expect(r.reason!.startsWith("[ERROR] ")).toBe(false);
  });
  it("正常失败 reason 均不含 [ERROR] 前缀（不污染 runner 执行错误判定）", async () => {
    for (const id of ["CODING-09", "KNOW-09", "PLAN-09", "TOOL-09", "MEM-09", "EVOLVE-09"]) {
      const task = find(id);
      const r = await task.verify("这是一段不含任何有效信息的回答");
      expect(r.passed, id).toBe(false);
      expect(r.reason!.startsWith("[ERROR] "), id).toBe(false);
    }
  });
});
