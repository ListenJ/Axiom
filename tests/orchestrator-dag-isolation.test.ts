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
