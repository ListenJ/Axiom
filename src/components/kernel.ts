import type {
  ComponentContext,
  ComponentHealth,
  ComponentLifecycle,
} from "./contracts.js";

export class ComponentKernel {
  private components = new Map<string, ComponentLifecycle>();
  private initialized = new Set<string>();
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
