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
  it("『最高优先级/先/故障』中文答案通过（无需字面 p0/bug）", async () => {
    expect((await task.verify("最高优先级先修生产故障，其次给新人答疑，最后写周报。")).passed).toBe(true);
  });
  it("缺优先级维度仍失败", async () => {
    expect((await task.verify("先修 bug 再写周报再答疑。")).passed).toBe(false);
  });
});

describe("校验器降噪：中文同义词不再误杀（PLAN-06）", () => {
  const task = find("PLAN-06");
  it("『止血恢复/解决/确认总结』中文答案通过", async () => {
    expect((await task.verify("先止血恢复服务并定位根因，再解决故障，最后确认并总结复盘。")).passed).toBe(true);
  });
  it("缺修复/解决环节仍失败", async () => {
    expect((await task.verify("先止血、定位，然后验证。")).passed).toBe(false);
  });
});

describe("校验器降噪：中文同义词不再误杀（TOOL-06）", () => {
  const task = find("TOOL-06");
  it("『版本控制/合并冲突/解决』中文答案通过", async () => {
    expect((await task.verify("在版本控制中遇到合并冲突时，先查看冲突文件，手动修改，标记解决后提交。")).passed).toBe(true);
  });
  it("缺冲突处理环节仍失败", async () => {
    expect((await task.verify("用 git 查看 diff 然后直接提交。")).passed).toBe(false);
  });
});

describe("校验器降噪：中文同义词不再误杀（TOOL-07）", () => {
  const task = find("TOOL-07");
  it("『代码检查/单元测试/编译/发布/冒烟』中文答案通过", async () => {
    expect((await task.verify("CI 流水线依次为：代码检查 → 单元测试 → 集成测试 → 编译构建 → 安全扫描 → 发布 → 冒烟验证。")).passed).toBe(true);
  });
  it("缺冒烟/验证环节仍失败", async () => {
    expect((await task.verify("流水线：代码检查、单元测试、编译、部署。")).passed).toBe(false);
  });
});

describe("校验器降噪：prompt 未要求的概念不再强制（EVOLVE-06）", () => {
  const task = find("EVOLVE-06");
  it("『路径/确认/备份快照』中文答案通过", async () => {
    expect((await task.verify("删除前检查目标路径，确认不是根目录或关键目录，先保存快照备份。")).passed).toBe(true);
  });
  it("给出 3 条合法自检项但未提备份也通过（prompt 只要求 3 条自检项，未指定必须含备份）", async () => {
    // 真实 zhipu 回答（2026-09-05 探针）：路径绝对性 + 软链接陷阱 + 权限
    expect((await task.verify("1. 确认目标路径的绝对准确性；2. 确认目录结构是否包含软链接或循环引用；3. 确认当前用户权限。")).passed).toBe(true);
  });
  it("无任何具体自检项仍失败", async () => {
    expect((await task.verify("删除前小心使用即可。")).passed).toBe(false);
  });
});

describe("校验器降噪：中文同义词不再误杀（KNOW-03）", () => {
  const task = find("KNOW-03");
  it("『MCP/工具调用/上下文』中文答案通过（无需字面 model context protocol）", async () => {
    expect((await task.verify("MCP 是模型上下文协议，让模型通过工具调用获取外部能力，核心价值是统一上下文交互。")).passed).toBe(true);
  });
  it("缺工具维度仍失败", async () => {
    expect((await task.verify("MCP 是一种上下文协议，用于标准化通信。")).passed).toBe(false);
  });
});

describe("校验器降噪：KNOW-02 运行时点接受多信号（引擎/性能/运行时）", () => {
  const task = find("KNOW-02");
  it("完整答案（Zig + JavaScriptCore + TypeScript）通过", async () => {
    expect((await task.verify("Bun 基于 Zig 构建、使用 JavaScriptCore（JSC）引擎、原生支持 TypeScript。")).passed).toBe(true);
  });
  it("真实 zhipu 回答通过：用 性能/V8 描述运行时差异、未点名 JSC（prompt 只要求三点差异，未要求点名引擎）", async () => {
    expect((await task.verify("Bun 使用 Zig 编写，避免了 Node.js V8 引擎的额外开销；包管理上内置 bun install；Bun 原生支持 TypeScript。")).passed).toBe(true);
  });
  it("完全没提运行时差异仍失败", async () => {
    expect((await task.verify("Bun 支持 TypeScript，bun install 很快。")).passed).toBe(false);
  });
});

describe("校验器降噪：KNOW-05 第三维对齐 prompt（启动速度，而非未要求的 镜像）", () => {
  const task = find("KNOW-05");
  it("真实 zhipu 回答通过：三句话各覆盖 隔离粒度/资源开销/启动速度 但未提镜像", async () => {
    expect((await task.verify("隔离粒度：容器共享宿主机内核，仅隔离应用进程与文件系统；资源开销：容器直接使用宿主机资源，开销极低；启动速度：容器启动仅需秒级，无需启动完整操作系统。")).passed).toBe(true);
  });
  it("缺启动速度维度仍失败", async () => {
    expect((await task.verify("容器共享宿主机内核、隔离性弱，且通过镜像分发。")).passed).toBe(false);
  });
});

describe("校验器降噪：Set 即为哈希去重（CODING-04）", () => {
  const task = find("CODING-04");
  it("仅用 Set 去重的完整答案通过（无需字面 哈希/map/字典）", async () => {
    expect((await task.verify("原函数双重循环是 O(n²)。优化：用 Set 记录已见元素，遍历一次 O(n)，空间 O(n)。")).passed).toBe(true);
  });
  it("无任何数据结构仍失败", async () => {
    expect((await task.verify("把循环优化成 O(n)，时间复杂度 O(n)。")).passed).toBe(false);
  });
});

describe("校验器降噪：WAL 机制同义词（KNOW-04）", () => {
  const task = find("KNOW-04");
  it("完整 WAL 答案用「追加写入」表述通过（无需字面 预写日志）", async () => {
    expect((await task.verify("WAL 模式把写操作追加写入 WAL 文件，读操作直接读数据库快照，读写可并行；崩溃时重放 WAL 恢复，适合读多写少的场景。")).passed).toBe(true);
  });
  it("未解释 WAL 机制仍失败", async () => {
    expect((await task.verify("WAL 模式性能更好，适合高并发。")).passed).toBe(false);
  });
});

describe("校验器降噪：中文同义词不再误杀（CODING-07）", () => {
  const task = find("CODING-07");
  it("『堆快照/内存分析/排查定位』中文答案通过", async () => {
    expect((await task.verify("先用 --inspect 连接进程做堆快照，看 GC 日志和内存分析，逐步排查定位泄漏点并修复。")).passed).toBe(true);
  });
  it("缺内存分析工具维度仍失败", async () => {
    expect((await task.verify("逐步排查并修复内存问题。")).passed).toBe(false);
  });
});
