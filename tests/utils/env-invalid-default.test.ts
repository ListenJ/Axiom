/**
 * Fix 3 回归测试（LOW）：validateEnv 对非必填项应用 default 后，
 * 也必须对该 default 跑 validate 回调，避免无效 default 被静默通过。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { validateEnv, REQUIRED_ENV_VARS, type EnvVarConfig } from "../../src/utils/env.js";

/** helper：在 array 里找符合谓词的项，找不到则断言失败 */
function expectSome<T>(arr: T[], predicate: (item: T) => boolean, msg = "expected at least one item to match"): void {
  const found = arr.find(predicate);
  if (!found) throw new Error(msg);
  expect(found).toBeDefined();
}

describe("validateEnv applies validate() to defaulted values", () => {
  const orig: Record<string, EnvVarConfig | undefined> = {};
  const envSnapshot: Record<string, string | undefined> = {};
  let restored = false;

  beforeEach(() => {
    // 记录原始配置，并保存/设置基础 required vars，避免它们干扰本测试
    for (const k of Object.keys(orig)) delete orig[k];
    for (const v of REQUIRED_ENV_VARS) orig[v.name] = v;

    envSnapshot.DATABASE_URL = process.env.DATABASE_URL;
    envSnapshot.VAULT_PATH = process.env.VAULT_PATH;
    envSnapshot.TEST_INVALID_DEFAULT = process.env.TEST_INVALID_DEFAULT;
    process.env.DATABASE_URL = "sqlite:///test.db";
    process.env.VAULT_PATH = "/tmp/test-vault";
    delete process.env.TEST_INVALID_DEFAULT;

    const testVar: EnvVarConfig = {
      name: "TEST_INVALID_DEFAULT",
      required: false,
      default: "BOGUS",        // 非法：validate 要求纯数字
      validate: (v) => /^\d+$/.test(v),
      description: "Test var with invalid default",
    };
    REQUIRED_ENV_VARS.push(testVar);
    restored = false;
  });

  afterEach(() => {
    if (!restored) {
      const tail = REQUIRED_ENV_VARS.at(-1);
      if (tail?.name === "TEST_INVALID_DEFAULT") REQUIRED_ENV_VARS.pop();
      for (const [k, v] of Object.entries(envSnapshot)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      restored = true;
    }
  });

  test("non-required var with an invalid default → validation fails", () => {
    const result = validateEnv({ strict: false, exitOnError: false });

    // 之前的 bug：default 被 apply 到 process.env 后直接 continue，
    // 不跑 validate，result.valid 依旧 true。修复后应失败。
    expect(result.valid).toBe(false);
    expectSome(result.appliedDefaults, (d) => d.name === "TEST_INVALID_DEFAULT" && d.value === "BOGUS",
      "default BOGUS should have been applied");
    expectSome(result.invalid,
      (i) => i.name === "TEST_INVALID_DEFAULT" && i.value === "BOGUS",
      "invalid default BOGUS should be reported");
  });

  test("non-required var with a valid default → passes and default is applied", () => {
    const testVar = REQUIRED_ENV_VARS.find((v) => v.name === "TEST_INVALID_DEFAULT") as EnvVarConfig;
    testVar.default = "123";

    const result = validateEnv({ strict: false, exitOnError: false });

    expect(result.valid).toBe(true);
    expectSome(result.appliedDefaults, (d) => d.name === "TEST_INVALID_DEFAULT" && d.value === "123",
      "valid default 123 should be applied");
    const hasTestVarInvalid = result.invalid.some((i) => i.name === "TEST_INVALID_DEFAULT");
    expect(hasTestVarInvalid).toBe(false);
    expect(process.env.TEST_INVALID_DEFAULT).toBe("123");
  });
});
