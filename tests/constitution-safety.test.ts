/**
 * 宪法执行安全章节测试 —— 权限分级 / 沙箱验证优先 / 毁灭性操作终止
 */
import { describe, it, expect, afterEach } from "bun:test";
import {
  getConstitutionForMode,
  injectConstitution,
  getAgentPermission,
} from "../src/agents/constitution.js";

afterEach(() => {
  delete process.env.AXIOM_AGENT_PERMISSION;
});

describe("getAgentPermission", () => {
  it("默认 readwrite", () => {
    expect(getAgentPermission()).toBe("readwrite");
  });
  it("env 映射 readonly/read/ro → readonly；full/complete → full", () => {
    for (const v of ["readonly", "read", "ro"]) {
      process.env.AXIOM_AGENT_PERMISSION = v;
      expect(getAgentPermission(), v).toBe("readonly");
    }
    for (const v of ["full", "complete"]) {
      process.env.AXIOM_AGENT_PERMISSION = v;
      expect(getAgentPermission(), v).toBe("full");
    }
  });
});

describe("宪法执行安全章节", () => {
  it("所有模式都包含安全章节与三条铁律", () => {
    for (const mode of ["plan", "agent", "yolo"] as const) {
      const text = getConstitutionForMode(mode);
      expect(text).toContain("执行安全与权限");
      expect(text).toContain("沙箱验证优先");
      expect(text).toContain("毁灭性操作直接终止");
      expect(text).toContain("rm -rf");
      expect(text).toContain("reset --hard");
      expect(text).toContain("当前权限档位: readwrite");
    }
  });

  it("权限档位变化反映到提示词", () => {
    process.env.AXIOM_AGENT_PERMISSION = "full";
    expect(getConstitutionForMode("agent")).toContain("当前权限档位: full");
  });

  it("injectConstitution 将安全章节注入系统提示词", () => {
    const out = injectConstitution("You are a coding agent.", "agent");
    expect(out).toContain("执行安全与权限");
    expect(out).toContain("You are a coding agent.");
  });
});
