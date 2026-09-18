/**
 * 资源注册表 —— 运行时资源统计的统一接缝（深模块：小接口，大实现）
 *
 * 用途：各模块通过 register() 提供资源快照收集器，collect() 汇总为诊断快照，
 * 供 /api/audit/diagnostics 与自动化审查测试使用。
 *
 * 防泄漏不变量：重复 register 同名收集器时以新代旧（Map.set 语义），
 * 避免热重载/重复初始化导致闭包累积；collect() 对单个收集器失败容错，
 * 标记 degraded 而不是让整个诊断失败。
 */
export interface ResourceSnapshot {
  name: string;
  metrics: Record<string, number | string | boolean>;
  status: "ok" | "degraded";
  error?: string;
}

type ResourceCollector = () => Record<string, number | string | boolean>;

const collectors = new Map<string, ResourceCollector>();

/** 注册资源收集器；同名重复注册直接覆盖（不产生重复条目） */
export function registerResource(name: string, collector: ResourceCollector): void {
  collectors.set(name, collector);
}

/** 注销收集器（测试隔离用） */
export function unregisterResource(name: string): void {
  collectors.delete(name);
}

/** 已注册资源名列表（稳定顺序） */
export function listResourceNames(): string[] {
  return Array.from(collectors.keys());
}

/** 汇总全部资源快照；单收集器失败降级为 degraded，不抛出 */
export function collectResources(): ResourceSnapshot[] {
  const snapshots: ResourceSnapshot[] = [];
  for (const [name, collect] of collectors) {
    try {
      snapshots.push({ name, metrics: collect(), status: "ok" });
    } catch (err) {
      snapshots.push({
        name,
        metrics: {},
        status: "degraded",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return snapshots;
}