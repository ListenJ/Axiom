/**
 * 测试环境变量快照/恢复 helper（轮 7 审计三梯队⑤：跨文件 env 泄漏治理）。
 *
 * 背景：bun test 单进程顺序执行，beforeAll/beforeEach 里改写或 delete 的
 * process.env 键会泄漏到同进程后续测试文件——与历史 resource-sync flaky 簇
 * 同型（环境耦合）。本轮审计发现 4 个文件存在此模式：
 *   - dre-tools-behavior（DATABASE_PATH/DRE_LLM_URL/DRE_AUTO_TICK 改写 +
 *     DEEPSEEK_API_KEY 不可逆删除）
 *   - dre-daemon（两处 describe 各漏恢复部分键）
 *   - laya-drift / laya-calibrate（afterEach 只 delete 不恢复原值）
 *
 * 用法（对齐 laya-http.test.ts 的 ENV_KEYS 快照范本）：
 *   const restoreEnv = snapshotEnv(["DATABASE_PATH", "DRE_AUTO_TICK"]);
 *   // …beforeAll/beforeEach 里随意改写…
 *   afterAll(() => restoreEnv());
 */
export function snapshotEnv(keys: readonly string[]): () => void {
  const saved = new Map<string, string | undefined>();
  for (const k of keys) saved.set(k, process.env[k]);
  return () => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}
