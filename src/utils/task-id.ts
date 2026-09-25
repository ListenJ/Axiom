/**
 * 任务标识的唯一构造入口（A4，2026-09-20）
 *
 * 背景：同一次交换会产生两类数据 ——
 *   ① **token 用量**（经 executeChat → router → trackCall → TokenTracker.taskId）；
 *   ② **真实使用轨迹**（captureRealUsageTrace 的 `id`，同时也是 AgentTrace 的 taskId）。
 * 两者必须共用**同一个** id，A5 才能"按任务"把用量与轨迹对上。
 *
 * 此前该 id 在两处各自拼字符串（格式靠人肉保持一致），属"约定"而非"约束"。
 * 收敛到本函数后，格式只有一处可改；两侧都由它产生。
 *
 * 说明（如实）：这解决的是**构造点唯一**，不是**类型级区分** ——
 * 两者对外仍是 `string`。若将来要做名义类型（branded type），改这一个函数即可铺开。
 */
export function newTaskId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}
