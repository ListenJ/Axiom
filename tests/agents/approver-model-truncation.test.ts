import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as providerCaller from "../../src/router/provider-caller.js";
import { requestApproval } from "../../src/agents/approver-model.js";

const originalApprover = process.env.AXIOM_APPROVER_MODEL;

afterEach(() => {
  if (originalApprover === undefined) delete process.env.AXIOM_APPROVER_MODEL;
  else process.env.AXIOM_APPROVER_MODEL = originalApprover;
});

describe("approver command truncation", () => {
  it("fails closed without calling the provider when the command exceeds the review limit", async () => {
    process.env.AXIOM_APPROVER_MODEL = "test/test-model";
    const call = spyOn(providerCaller, "callProvider").mockResolvedValue({
      content: '{"approved":true,"reason":"should never be used"}',
    });

    const verdict = await requestApproval({ command: "x".repeat(1001) });

    expect(call).not.toHaveBeenCalled();
    expect(verdict.decided).toBe(false);
    expect(verdict.approved).toBe(false);
    expect(verdict.reason).toContain("过长");
  });
});
