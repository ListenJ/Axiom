import { describe, it, expect } from "bun:test";
import { AgentOrchestrator } from "../src/agents/orchestrator.js";

describe("orchestrator DAG S2", () => {
  it("失败任务的下游不执行", async () => {
    const orch = new AgentOrchestrator();
    let bExecuted = false;
    (orch as any).executeStep = async (step:any) => {
      if (step.id === "b") { bExecuted = true; return { taskId:"b", agentId:"ok", success:true, duration:1 }; }
      if (step.id === "a") return { taskId:"a", agentId:"fail", success:false, error:"boom", duration:1 };
      return { taskId:step.id, agentId:"ok", success:true, duration:1 };
    };
    const res = await orch.executePlan({
      id:"p1", name:"p1", mode:"dag", steps:[
        { id:"a", task: { id:"a", type:"a", description:"a", input:{}} as any } as any,
        { id:"b", task: { id:"b", type:"b", description:"b", input:{}} as any, dependsOn:["a"] } as any,
      ] as any
    });
    expect(bExecuted).toBe(false);
    expect(res.success).toBe(false);
  });

  it("成功链路仍可执行", async () => {
    const orch = new AgentOrchestrator();
    const order: string[] = [];
    (orch as any).executeStep = async (step:any) => { order.push(step.id); return { taskId:step.id, agentId:"ok", success:true, duration:1 }; };
    const res = await orch.executePlan({
      id:"p2", name:"p2", mode:"dag", steps:[
        { id:"a", task: { id:"a", type:"a", description:"a", input:{}} as any } as any,
        { id:"b", task: { id:"b", type:"b", description:"b", input:{}} as any, dependsOn:["a"] } as any,
        { id:"c", task: { id:"c", type:"c", description:"c", input:{}} as any } as any,
      ] as any
    });
    expect(order).toContain("a");
    expect(order).toContain("b");
    expect(order).toContain("c");
    expect(res.success).toBe(true);
  });
});

// 审计 M6（2026-08-28）：ready 为空时区分"依赖失败阻断"与"循环依赖"，
// 不再笼统报 "Deadlock detected"，且 errors 中列出具体任务名。
describe("orchestrator DAG M6: 停滞归因", () => {
  it("依赖失败阻断：错误信息含被阻断任务名与失败依赖名，不笼统报 Deadlock", async () => {
    const orch = new AgentOrchestrator();
    let betaExecuted = false;
    (orch as any).executeStep = async (step: any) => {
      if (step.id === "beta") betaExecuted = true;
      if (step.id === "alpha")
        return { taskId: "alpha", agentId: "x", success: false, error: "boom", duration: 1 };
      return { taskId: step.id, agentId: "ok", success: true, duration: 1 };
    };
    const res = await orch.executePlan({
      id: "p3",
      name: "p3",
      mode: "dag",
      steps: [
        { id: "alpha", task: { id: "alpha", type: "t", description: "alpha", input: {} } as any } as any,
        {
          id: "beta",
          task: { id: "beta", type: "t", description: "beta", input: {} } as any,
          dependsOn: ["alpha"],
        } as any,
      ] as any,
    });
    expect(betaExecuted).toBe(false);
    const joined = res.errors.join("\n");
    expect(joined).toContain("beta"); // 被阻断任务名（旧消息不列名 → 红）
    expect(joined).toContain("alpha"); // 失败依赖名
    expect(joined).toContain("failed"); // 依赖失败语义
    expect(joined).not.toContain("Deadlock detected: no steps can be executed");
  });

  it("循环依赖：报 Cyclic dependency 并列出环上任务名，而非笼统 Deadlock", async () => {
    const orch = new AgentOrchestrator();
    const executed: string[] = [];
    (orch as any).executeStep = async (step: any) => {
      executed.push(step.id);
      return { taskId: step.id, agentId: "ok", success: true, duration: 1 };
    };
    const res = await orch.executePlan({
      id: "p4",
      name: "p4",
      mode: "dag",
      steps: [
        {
          id: "loop-x",
          task: { id: "loop-x", type: "t", description: "x", input: {} } as any,
          dependsOn: ["loop-y"],
        } as any,
        {
          id: "loop-y",
          task: { id: "loop-y", type: "t", description: "y", input: {} } as any,
          dependsOn: ["loop-x"],
        } as any,
      ] as any,
    });
    expect(executed).toHaveLength(0); // 环上任务从未被调度
    const joined = res.errors.join("\n");
    expect(joined).toContain("Cyclic dependency detected");
    expect(joined).toContain("loop-x"); // 环上任务名
    expect(joined).toContain("loop-y");
    expect(joined).not.toContain("Deadlock detected");
  });
});
