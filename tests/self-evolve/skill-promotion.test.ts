/**
 * promoteInductionsToSkills — 把归纳模式提升为可被模型按需调用的 skill。
 *
 * Contract:
 *   - 每个 Induction → auto-induce-* skill（triggers=pattern，promptTemplate 含 recommendation）；
 *   - 注册 + 持久化（可注入 fake deps）；已存在 → 跳过（幂等）。
 */
import { describe, test, expect } from "bun:test";
import { promoteInductionsToSkills, type InductionPromotionDeps } from "../../src/self-evolve/skill-promotion.js";
import type { Induction } from "../../src/self-evolve/types.js";
import type { SkillDefinition } from "../../src/skills/types.js";

const inductions: Induction[] = [
  { pattern: "mcp timeout", support: 3, successRate: 0.67, recommendation: "Prefer mcp pattern" },
  { pattern: "redis cache", support: 2, successRate: 1.0, recommendation: "Prefer redis pattern" },
];

function fakeDeps(): {
  deps: InductionPromotionDeps;
  registered: SkillDefinition[];
  persisted: SkillDefinition[];
  existing: Set<string>;
} {
  const registered: SkillDefinition[] = [];
  const persisted: SkillDefinition[] = [];
  const existing = new Set<string>();
  return {
    deps: {
      register: (s) => {
        registered.push(s);
        // 模拟真实 registry：注册后 has(id) 为 true（幂等依据）
        existing.add(s.id);
      },
      has: (id) => existing.has(id),
      persist: (s) => {
        persisted.push(s);
      },
    },
    registered,
    persisted,
    existing,
  };
}

describe("promoteInductionsToSkills", () => {
  test("promotes each induction into an auto-induce skill and persists", () => {
    const { deps, registered, persisted } = fakeDeps();

    const ids = promoteInductionsToSkills(inductions, deps);

    expect(ids).toHaveLength(2);
    expect(registered).toHaveLength(2);
    expect(persisted).toHaveLength(2);
    expect(registered[0].id).toMatch(/^auto-induce-mcp-timeout$/);
    expect(registered[0].triggers).toContain("mcp timeout");
    expect(registered[0].promptTemplate).toContain("Prefer mcp pattern");
    expect(registered[0].source).toBe("hermes");
    expect(registered[1].id).toMatch(/^auto-induce-redis-cache$/);
  });

  test("skips patterns that already exist", () => {
    const fake = fakeDeps();
    const first = promoteInductionsToSkills([inductions[0]], fake.deps);
    fake.existing.add(first[0]);

    const second = promoteInductionsToSkills([inductions[0]], fake.deps);

    expect(second).toHaveLength(0);
    expect(fake.registered).toHaveLength(1);
  });

  test("ids are deterministic so repeated promotion is idempotent", () => {
    const fake = fakeDeps();
    promoteInductionsToSkills([inductions[0]], fake.deps);
    const second = promoteInductionsToSkills([inductions[0]], fake.deps);
    expect(second).toHaveLength(0);
    expect(fake.registered).toHaveLength(1);
    expect(fake.registered[0].id).toMatch(/^auto-induce-mcp-timeout$/);
  });
});

describe("promoteInductionsToSkills quality feedback", () => {
  test("skips patterns whose skill is already deprecated", () => {
    const fake = fakeDeps();
    const ids = promoteInductionsToSkills(inductions, {
      ...fake.deps,
      quality: {
        getSkillQuality: (id) =>
          id === "auto-induce-mcp-timeout"
            ? { skillId: id, calls: 3, successes: 1, lastUsedAt: 1, deprecated: true }
            : undefined,
      },
    });

    expect(ids).toEqual(["auto-induce-redis-cache"]);
    expect(fake.registered.map((s) => s.id)).toEqual(["auto-induce-redis-cache"]);
  });

  test("writes quality stats into promoted skill description", () => {
    const fake = fakeDeps();
    const ids = promoteInductionsToSkills(inductions, {
      ...fake.deps,
      quality: {
        getSkillQuality: (id) =>
          id === "auto-induce-mcp-timeout"
            ? { skillId: id, calls: 4, successes: 1, lastUsedAt: 1, deprecated: true }
            : { skillId: id, calls: 2, successes: 2, lastUsedAt: 1, deprecated: false },
      },
    });

    expect(ids).toEqual(["auto-induce-redis-cache"]);
    const description = fake.registered[0].description;
    expect(description).toContain("quality: calls=2 success=2");
    expect(description).not.toContain("deprecated");
  });

  test("marks description deprecated for deprecated quality records", () => {
    const fake = fakeDeps();
    const ids = promoteInductionsToSkills([inductions[0]], {
      ...fake.deps,
      quality: {
        getSkillQuality: () => ({ skillId: "auto-induce-mcp-timeout", calls: 3, successes: 1, lastUsedAt: 1, deprecated: true }),
      },
    });

    expect(ids).toEqual([]);
    expect(fake.registered).toHaveLength(0);
  });
});
