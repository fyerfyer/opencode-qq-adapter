import type { Logger } from "pino";
import type { AppConfig } from "../../config/schema.js";
import { sameSpec } from "./convert.js";
import type { PluginLoader } from "./loader.js";
import type { PluginRegistry } from "./registry.js";
import type { PluginReloadReport, PluginRuntimeStatus } from "./types.js";

/** Start, reconcile, reload and stop the configured plugin set. */
export class PluginLifecycle {
  readonly #config: AppConfig;
  readonly #logger: Logger;
  readonly #registry: PluginRegistry;
  readonly #loader: PluginLoader;
  readonly #withMaintenance: <T>(task: () => Promise<T>) => Promise<T>;
  #started = false;

  constructor(options: {
    config: AppConfig;
    logger: Logger;
    registry: PluginRegistry;
    loader: PluginLoader;
    withMaintenance: <T>(task: () => Promise<T>) => Promise<T>;
  }) {
    this.#config = options.config;
    this.#logger = options.logger;
    this.#registry = options.registry;
    this.#loader = options.loader;
    this.#withMaintenance = options.withMaintenance;
  }

  get started(): boolean {
    return this.#started;
  }

  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    await this.#reconcile();
  }

  async reload(): Promise<PluginReloadReport> {
    if (!this.#started) return { loaded: 0, failed: 0, removed: 0 };
    return this.#reconcile();
  }

  /**
   * Force-dispose and re-import one plugin from its configured path.
   *
   * Unlike `reload()`, this bypasses `sameSpec` so changed code on disk is
   * picked up even when the plugin config is unchanged.
   */
  async reloadPlugin(pluginId: string): Promise<PluginRuntimeStatus> {
    if (!this.#started) return "stopped";
    const existing = this.#registry.get(pluginId);
    if (existing === undefined) throw new Error(`unknown plugin: ${pluginId}`);
    const spec = this.#config.plugins[pluginId];
    if (spec === undefined) {
      throw new Error(
        `plugin ${pluginId} is no longer present in config.plugins; reload the host instead`,
      );
    }

    const order = existing.order;
    return this.#withMaintenance(async () => {
      await this.#loader.dispose(existing);
      const instance = spec.enabled
        ? await this.#loader.load(pluginId, order, spec)
        : this.#loader.disabledInstance(pluginId, order, spec);
      this.#registry.set(pluginId, instance);
      this.#logger.info({ pluginId, status: instance.status, order }, "Plugin reloaded");
      return instance.status;
    });
  }

  async stop(): Promise<void> {
    if (!this.#started) return;
    this.#started = false;
    const instances = this.#registry.sorted();
    for (const instance of instances.reverse()) {
      await this.#loader.dispose(instance);
    }
    this.#registry.clear();
  }

  async #reconcile(): Promise<PluginReloadReport> {
    const entries = Object.entries(this.#config.plugins);
    const desired = new Set(entries.map(([id]) => id));
    let removed = 0;
    for (const [id, instance] of this.#registry.entries()) {
      if (!desired.has(id)) {
        await this.#loader.dispose(instance);
        this.#registry.delete(id);
        removed += 1;
      }
    }

    let loaded = 0;
    let failed = 0;
    for (const [order, [id, spec]] of entries.entries()) {
      const existing = this.#registry.get(id);
      const unchanged =
        existing !== undefined &&
        sameSpec(existing.spec, spec) &&
        (existing.status === "loaded" || existing.status === "disabled");
      if (unchanged) {
        existing.order = order;
        if (existing.status === "loaded") loaded += 1;
        continue;
      }

      if (existing !== undefined) {
        await this.#loader.dispose(existing);
        this.#registry.delete(id);
      }

      if (!spec.enabled) {
        this.#registry.set(id, this.#loader.disabledInstance(id, order, spec));
        continue;
      }

      const instance = await this.#loader.load(id, order, spec);
      this.#registry.set(id, instance);
      if (instance.status === "loaded") loaded += 1;
      else if (instance.status === "failed") failed += 1;
    }

    this.#logger.info(
      { loaded, failed, removed, total: this.#registry.size },
      "Plugin host reconciled",
    );
    return { loaded, failed, removed };
  }
}
