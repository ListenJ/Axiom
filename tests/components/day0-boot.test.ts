import { describe, it, expect, afterEach } from "bun:test";
import { resetComponentKernel } from "../../src/components/kernel.js";
import { initializeComponentKernel } from "../../src/agents/component-bootstrap.js";

describe("Day0 bootstrap", () => {
  afterEach(() => {
    resetComponentKernel();
  });

  it("registers core components without external CLI", async () => {
    const kernel = await initializeComponentKernel();
    const healths = await kernel.healthAll();
    const ids = healths.map((health) => health.id);

    expect(ids).toEqual(
      expect.arrayContaining([
        "token-budget",
        "native-general",
        "native-code",
        "native-research",
      ]),
    );
    for (const health of healths) {
      expect(health.ready).toBe(true);
      expect(health.optional).toBe(false);
    }
    await kernel.dispose();
  });
});
