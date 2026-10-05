import { afterEach, describe, expect, it } from "bun:test";
import { requestApproval } from "../../src/agents/approver-model.js";

const originalApprover = process.env.AXIOM_APPROVER_MODEL;

afterEach(() => {
  if (originalApprover === undefined) delete process.env.AXIOM_APPROVER_MODEL;
  else process.env.AXIOM_APPROVER_MODEL = originalApprover;
});

describe("approver command truncation", () => {
  it("fails closed before provider dispatch when the command exceeds the review limit", async () => {
    // Unknown provider: if the length gate is removed, the provider call fails
    // and the returned reason no longer contains the length-gate message.
    process.env.AXIOM_APPROVER_MODEL = "axiom-test-unknown/nonexistent-model";

    const verdict = await requestApproval({ command: "x".repeat(1001) });

    expect(verdict.decided).toBe(false);
    expect(verdict.approved).toBe(false);
    expect(verdict.reason).toContain("过长");
  });
});
