import type { PluginHooksDefinition } from "../sdk.js";
import type {
  PluginHostStatus,
  PluginInstance,
  PluginStatus,
  RegisteredCommand,
  RegisteredHook,
} from "./types.js";

/** Instance table, ordering, maintenance flag and pending-work accounting. */
export class PluginRegistry {
  readonly #instances = new Map<string, PluginInstance>();
  readonly #pendingTasks = new Set<Promise<unknown>>();
  #maintenance = false;

  get(id: string): PluginInstance | undefined {
    return this.#instances.get(id);
  }

  set(id: string, instance: PluginInstance): void {
    this.#instances.set(id, instance);
  }

  delete(id: string): void {
    this.#instances.delete(id);
  }

  clear(): void {
    this.#instances.clear();
  }

  get size(): number {
    return this.#instances.size;
  }

  /** Insertion-ordered entries; order is still authoritative for execution. */
  entries(): Array<[string, PluginInstance]> {
    return [...this.#instances.entries()];
  }

  sorted(): PluginInstance[] {
    return [...this.#instances.values()].sort((left, right) => left.order - right.order);
  }

  get maintenance(): boolean {
    return this.#maintenance;
  }

  setMaintenance(active: boolean): void {
    this.#maintenance = active;
  }

  /** Number of plugin command/admin/afterRun tasks still using plugin state. */
  pendingTasks(): number {
    return this.#pendingTasks.size;
  }

  track<T>(task: Promise<T>): Promise<T> {
    const tracked = task.finally(() => {
      this.#pendingTasks.delete(tracked);
    });
    this.#pendingTasks.add(tracked);
    return tracked;
  }

  loadedHooks<K extends keyof PluginHooksDefinition>(
    key: K,
  ): Array<{ instance: PluginInstance; hook: RegisteredHook }> {
    const result: Array<{ instance: PluginInstance; hook: RegisteredHook }> = [];
    for (const instance of this.sorted()) {
      if (instance.status !== "loaded") continue;
      for (const hook of instance.hooks) {
        if (hook.definition[key] !== undefined) result.push({ instance, hook });
      }
    }
    return result;
  }

  findCommand(name: string): { instance: PluginInstance; command: RegisteredCommand } | null {
    const normalized = name.toLowerCase();
    for (const instance of this.sorted()) {
      if (instance.status !== "loaded") continue;
      for (const command of instance.commands.values()) {
        if (command.names.includes(normalized)) return { instance, command };
      }
    }
    return null;
  }

  status(): PluginHostStatus {
    const plugins = this.sorted().map((instance) => statusOf(instance));
    const loaded = plugins.filter((plugin) => plugin.status === "loaded").length;
    const failed = plugins.filter((plugin) => plugin.status === "failed").length;
    return {
      enabled: true,
      total: plugins.length,
      loaded,
      failed,
      plugins,
      message:
        plugins.length === 0
          ? "配置中没有启用任何插件。"
          : failed > 0
            ? `${loaded} 个插件已加载，${failed} 个失败；失败插件不会影响核心。`
            : `${loaded} 个插件已加载。`,
    };
  }

  helpText(): string {
    const lines: string[] = [];
    for (const instance of this.sorted()) {
      if (instance.status !== "loaded") continue;
      const commands = [...instance.commands.values()].sort((a, b) =>
        a.definition.name.localeCompare(b.definition.name),
      );
      for (const { definition } of commands) {
        const usage = definition.usage ?? definition.name;
        const description = definition.description ?? "插件命令";
        lines.push(`!${usage} — ${description}（${instance.id}）`);
      }
    }
    return lines.length === 0 ? "" : ["插件", ...lines].join("\n");
  }
}

function statusOf(instance: PluginInstance): PluginStatus {
  const manifest = instance.manifest;
  return {
    id: instance.id,
    name: manifest?.name ?? instance.id,
    version: manifest?.version ?? "-",
    apiVersion: manifest?.apiVersion ?? 0,
    description: manifest?.description ?? null,
    status: instance.status,
    error: instance.error,
    capabilities: manifest?.capabilities ?? [],
    commands: [...instance.commands.values()].map((command) => command.definition.name).sort(),
    source: instance.spec.package ?? instance.spec.path ?? "",
    sourceKind: instance.spec.package === undefined ? "path" : "package",
    loadedAt: instance.loadedAt,
    admin: {
      routes: instance.adminRoutes.length,
      pages: [...instance.adminPages],
    },
  };
}
