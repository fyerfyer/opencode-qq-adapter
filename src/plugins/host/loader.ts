import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import type { PluginConfig } from "../../config/schema.js";
import type { AuditTrail } from "../../observability/audit.js";
import { loadPluginModule, PluginLoadError } from "../manifest.js";
import type { PluginContext } from "../sdk.js";
import { describeError, parseOptions, withTimeout } from "./convert.js";
import type { PluginInstance } from "./types.js";
import type { UtilityRunner } from "./utility.js";

const LIFECYCLE_TIMEOUT_MS = 5_000;

export interface PluginLoaderOptions {
  logger: Logger;
  audit: AuditTrail;
  coreVersion: string;
  now: () => number;
  pluginsDir: string;
  utility: UtilityRunner;
  createContext: (instance: PluginInstance, options: unknown) => PluginContext<unknown>;
}

/** Import, initialize and dispose individual plugin instances. */
export class PluginLoader {
  readonly #logger: Logger;
  readonly #audit: AuditTrail;
  readonly #coreVersion: string;
  readonly #now: () => number;
  readonly #pluginsDir: string;
  readonly #utility: UtilityRunner;
  readonly #createContext: PluginLoaderOptions["createContext"];

  constructor(options: PluginLoaderOptions) {
    this.#logger = options.logger;
    this.#audit = options.audit;
    this.#coreVersion = options.coreVersion;
    this.#now = options.now;
    this.#pluginsDir = options.pluginsDir;
    this.#utility = options.utility;
    this.#createContext = options.createContext;
  }

  disabledInstance(id: string, order: number, spec: PluginConfig): PluginInstance {
    return {
      id,
      order,
      spec,
      status: "disabled",
      error: null,
      manifest: null,
      definition: null,
      context: null,
      packageRoot: null,
      dataDir: join(this.#pluginsDir, id),
      commands: new Map(),
      hooks: [],
      events: [],
      adminRoutes: [],
      adminPages: [],
      disposers: [],
      loadedAt: null,
    };
  }

  async load(id: string, order: number, spec: PluginConfig): Promise<PluginInstance> {
    const instance: PluginInstance = {
      id,
      order,
      spec,
      status: "failed",
      error: null,
      manifest: null,
      definition: null,
      context: null,
      packageRoot: null,
      dataDir: join(this.#pluginsDir, id),
      commands: new Map(),
      hooks: [],
      events: [],
      adminRoutes: [],
      adminPages: [],
      disposers: [],
      loadedAt: null,
    };

    try {
      const loaded = await loadPluginModule(spec, id, this.#coreVersion);
      instance.manifest = loaded.manifest;
      instance.definition = loaded.definition;
      instance.packageRoot = loaded.packageRoot;
      await mkdir(instance.dataDir, { recursive: true, mode: 0o700 });
      this.#utility.reset(id);
      const options = parseOptions(loaded, spec.options);
      const context = this.#createContext(instance, options);
      instance.context = context;
      const disposer = await withTimeout(
        Promise.resolve(loaded.definition.setup(context)),
        LIFECYCLE_TIMEOUT_MS,
        `setup of ${id}`,
      );
      if (typeof disposer === "function") instance.disposers.push(disposer);
      if (loaded.definition.start !== undefined) {
        await withTimeout(
          Promise.resolve(loaded.definition.start(context)),
          LIFECYCLE_TIMEOUT_MS,
          `start of ${id}`,
        );
      }
      instance.status = "loaded";
      instance.loadedAt = this.#now();
      this.#logger.info(
        {
          pluginId: id,
          version: loaded.manifest.version,
          capabilities: loaded.manifest.capabilities,
          entry: loaded.entryPath,
        },
        "Plugin loaded",
      );
      this.#audit.record({
        ts: this.#now(),
        actorQq: null,
        chatKey: null,
        projectId: null,
        workspaceId: null,
        action: "plugin.loaded",
        detail: { pluginId: id, version: loaded.manifest.version },
      });
      return instance;
    } catch (error) {
      instance.status = "failed";
      instance.error = describeError(error);
      await this.dispose(instance);
      this.#logger.warn(
        { err: error, pluginId: id, code: error instanceof PluginLoadError ? error.code : null },
        "Plugin failed to load; core continues",
      );
      this.#audit.record({
        ts: this.#now(),
        actorQq: null,
        chatKey: null,
        projectId: null,
        workspaceId: null,
        action: "plugin.failed",
        detail: { pluginId: id, error: instance.error },
      });
      return instance;
    }
  }

  async dispose(instance: PluginInstance): Promise<void> {
    await this.#utility.dispose(instance.id);

    if (instance.definition?.stop !== undefined && instance.context !== null) {
      try {
        await withTimeout(
          Promise.resolve(instance.definition.stop(instance.context)),
          LIFECYCLE_TIMEOUT_MS,
          `stop of ${instance.id}`,
        );
      } catch (error) {
        this.#logger.warn({ err: error, pluginId: instance.id }, "Plugin stop failed");
      }
    }
    for (const disposer of instance.disposers.reverse()) {
      try {
        await withTimeout(
          Promise.resolve(disposer()),
          LIFECYCLE_TIMEOUT_MS,
          `dispose of ${instance.id}`,
        );
      } catch (error) {
        this.#logger.warn({ err: error, pluginId: instance.id }, "Plugin disposer failed");
      }
    }
    instance.disposers.length = 0;
    instance.commands.clear();
    instance.hooks.length = 0;
    instance.events.length = 0;
    instance.adminRoutes.length = 0;
    instance.adminPages.length = 0;
    if (instance.status === "loaded") instance.status = "stopped";
  }
}
