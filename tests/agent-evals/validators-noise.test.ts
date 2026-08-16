/**
 * Agent 评测任务校验器降噪回归测试 — 7 个 held-out 校验器新增中文同义词后：
 * 1) 纯中文/常见变体回答不应被误杀（noise reduction 生效）；
 * 2) 缺关键概念的回答仍失败（防作弊不放松）。
 */
import { describe, it, expect } from "bun:test";
import { ALL_AGENT_TASKS } from "../../src/agent-evals/tasks.js";

function find(id: string) {
  const task = ALL_AGENT_TASKS.find((t) => t.id === id);
  expect(task, `${id} 存在`).toBeDefined();
  return task!;
}

describe("校验器降噪：中文同义词不再误杀（PLAN-04）", () => {
  const task = find("PLAN-04");
  it("『最高优先级/先/故障』中文答案通过（无需字面 p0/bug）", () => {
    expect(task.verify("最高优先级先修生产故障，其次给新人答疑，最后写周报。").passed).toBe(true);
  });
  it("缺优先级维度仍失败", () => {
    expect(task.verify("先修 bug 再写周报再答疑。").passed).toBe(false);
  });
});

describe("校验器降噪：中文同义词不再误杀（PLAN-06）", () => {
  const task = find("PLAN-06");
  it("『止血恢复/解决/确认总结』中文答案通过", () => {
    expect(task.verify("先止血恢复服务并定位根因，再解决故障，最后确认并总结复盘。").passed).toBe(true);
  });
  it("缺修复/解决环节仍失败", () => {
    expect(task.verify("先止血、定位，然后验证。").passed).toBe(false);
  });
});

describe("校验器降噪：中文同义词不再误杀（TOOL-06）", () => {
  const task = find("TOOL-06");
  it("『版本控制/合并冲突/解决』中文答案通过", () => {
    expect(task.verify("在版本控制中遇到合并冲突时，先查看冲突文件，手动修改，标记解决后提交。").passed).toBe(true);
  });
  it("缺冲突处理环节仍失败", () => {
    expect(task.verify("用 git 查看 diff 然后直接提交。").passed).toBe(false);
  });
});

describe("校验器降噪：中文同义词不再误杀（TOOL-07）", () => {
  const task = find("TOOL-07");
  it("『代码检查/单元测试/编译/发布/冒烟』中文答案通过", () => {
    expect(task.verify("CI 流水线依次为：代码检查 → 单元测试 → 集成测试 → 编译构建 → 安全扫描 → 发布 → 冒烟验证。").passed).toBe(true);
  });
  it("缺冒烟/验证环节仍失败", () => {
    expect(task.verify("流水线：代码检查、单元测试、编译、部署。").passed).toBe(false);
  });
});

describe("校验器降噪：中文同义词不再误杀（EVOLVE-06）", () => {
  const task = find("EVOLVE-06");
  it("『路径/确认/备份快照』中文答案通过", () => {
    expect(task.verify("删除前检查目标路径，确认不是根目录或关键目录，先保存快照备份。").passed).toBe(true);
  });
  it("缺备份要求仍失败", () => {
    expect(task.verify("检查路径并确认目标。").passed).toBe(false);
  });
});

describe("校验器降噪：中文同义词不再误杀（KNOW-03）", () => {
  const task = find("KNOW-03");
  it("『MCP/工具调用/上下文』中文答案通过（无需字面 model context protocol）", () => {
    expect(task.verify("MCP 是模型上下文协议，让模型通过工具调用获取外部能力，核心价值是统一上下文交互。").passed).toBe(true);
  });
  it("缺工具维度仍失败", () => {
    expect(task.verify("MCP 是一种上下文协议，用于标准化通信。").passed).toBe(false);
  });
});

describe("校验器降噪：Set 即为哈希去重（CODING-04）", () => {
  const task = find("CODING-04");
  it("仅用 Set 去重的完整答案通过（无需字面 哈希/map/字典）", () => {
    expect(task.verify("原函数双重循环是 O(n²)。优化：用 Set 记录已见元素，遍历一次 O(n)，空间 O(n)。").passed).toBe(true);
  });
  it("无任何数据结构仍失败", () => {
    expect(task.verify("把循环优化成 O(n)，时间复杂度 O(n)。").passed).toBe(false);
  });
});

describe("校验器降噪：WAL 机制同义词（KNOW-04）", () => {
  const task = find("KNOW-04");
  it("完整 WAL 答案用「追加写入」表述通过（无需字面 预写日志）", () => {
    expect(task.verify("WAL 模式把写操作追加写入 WAL 文件，读操作直接读数据库快照，读写可并行；崩溃时重放 WAL 恢复，适合读多写少的场景。").passed).toBe(true);
  });
  it("未解释 WAL 机制仍失败", () => {
    expect(task.verify("WAL 模式性能更好，适合高并发。").passed).toBe(false);
  });
});

describe("校验器降噪：中文同义词不再误杀（CODING-07）", () => {
  const task = find("CODING-07");
  it("『堆快照/内存分析/排查定位』中文答案通过", () => {
    expect(task.verify("先用 --inspect 连接进程做堆快照，看 GC 日志和内存分析，逐步排查定位泄漏点并修复。").passed).toBe(true);
  });
  it("缺内存分析工具维度仍失败", () => {
    expect(task.verify("逐步排查并修复内存问题。").passed).toBe(false);
  });
});
