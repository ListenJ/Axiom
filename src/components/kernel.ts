import type {
  ComponentContext,
  ComponentHealth,
  ComponentLifecycle,
} from "./contracts.js";

export class ComponentKernel {
  private components = new Map<string, ComponentLifecycle>();
  private initialized = new Set<string>();
  /**
   * 在途初始化承诺（single-flight）。
   *
   * 为什么必须有它：`init()` 里存在 `await`（依赖递归 + 组件自身 init），
   * 而 `initialized.add()` 在 await **之后**才执行。只靠 `initialized.has()` 判断，
   * 两个并发 `init(sameId)` 会双双通过检查并各自调用 `component.init()` ——
   * 组件被启动两次。共享依赖（a、b 都依赖 dep）同样会被启动两次。
   *
   * 修法：把"在途承诺"在**任何 await 之前同步发布**到本 Map（读与写之间无 await ⇒ 原子），
   * 后到者直接复用同一张承诺。这也是 `vault-stats-cache._refresh` 已在用的模式。
   */
  private inFlight = new Map<string, Promise<void>>();
  private context: ComponentContext;

  constructor(context?: Partial<ComponentContext>) {
    this.context = {
      cwd: context?.cwd ?? process.cwd(),
      startedAt: context?.startedAt ?? Date.now(),
    };
  }

  register(component: ComponentLifecycle): this {
    this.components.set(component.id, component);
    this.initialized.delete(component.id);
    return this;
  }

  get(id: string): ComponentLifecycle | undefined {
    return this.components.get(id);
  }

  list(): ComponentLifecycle[] {
    return Array.from(this.components.values());
  }

  isInitialized(id: string): boolean {
    return this.initialized.has(id);
  }

  async init(id: string): Promise<void> {
    const component = this.components.get(id);
    if (!component) {
      throw new Error(`Component not registered: ${id}`);
    }
    if (this.initialized.has(id)) return;

    // 已有同一组件的在途初始化 → 复用，不重复启动
    const existing = this.inFlight.get(id);
    if (existing) return existing;

    const task = (async () => {
      for (const dependency of component.dependencies ?? []) {
        if (!this.components.has(dependency)) {
          throw new Error(
            `Component ${id} depends on missing component: ${dependency}`,
          );
        }
        await this.init(dependency);
      }

      await component.init(this.context);
      this.initialized.add(id);
    })();

    // 同步发布（本行之前无 await ⇒ 无交错窗口）
    this.inFlight.set(id, task);
    try {
      await task;
    } finally {
      this.inFlight.delete(id);
    }
  }

  async initAll(): Promise<void> {
    for (const component of this.list()) {
      await this.init(component.id);
    }
  }

  async health(id: string): Promise<ComponentHealth> {
    const component = this.components.get(id);
    if (!component) {
      throw new Error(`Component not registered: ${id}`);
    }
    const health = await component.health();
    return {
      ...health,
      id: component.id,
      optional: health.optional ?? false,
    };
  }

  async healthAll(): Promise<ComponentHealth[]> {
    return Promise.all(
      this.list().map((component) =>
        this.health(component.id).catch((err: unknown) => ({
          id: component.id,
          ready: false,
          optional: false,
          reason: err instanceof Error ? err.message : String(err),
        })),
      ),
    );
  }

  async dispose(): Promise<void> {
    const errors: string[] = [];
    for (const component of this.list().reverse()) {
      try {
        await component.dispose();
      } catch (err) {
        errors.push(
          `${component.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    this.initialized.clear();
    if (errors.length > 0) {
      throw new Error(`Component disposal failed: ${errors.join("; ")}`);
    }
  }
}

let kernel: ComponentKernel | null = null;

export function getComponentKernel(): ComponentKernel {
  if (!kernel) kernel = new ComponentKernel();
  return kernel;
}

export function resetComponentKernel(): void {
  kernel = null;
}
