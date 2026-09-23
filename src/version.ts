/**
 * 运行时自述版本的唯一来源。
 *
 * 不放 package.json 里读：`tsconfig.json` 未开 `resolveJsonModule` 且 `include` 只有
 * `src/**` 与 `tests/**`，而编译成单文件二进制后运行期也拿不到 package.json。
 * 于是这里放字面量，由 tests/version-consistency.test.ts 断言它等于 package.json 的
 * version —— 漂移变红，而不是靠人记得改 6 处。
 */
export const APP_VERSION = "4.0.0";
