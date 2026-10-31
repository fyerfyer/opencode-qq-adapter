import type { PluginAdminActor, PluginAdminResult } from "../sdk.js";
import { dispatchAdminRoute, resolveAdminUiAsset, resolveAdminUiPage } from "./admin-ui.js";
import { requireCapability } from "./convert.js";
import type { PluginRegistry } from "./registry.js";
import type { PluginUiAssetInfo, PluginUiPageInfo } from "./types.js";

/** Dispatch authenticated admin requests and resolve plugin UI assets. */
export class PluginAdminDispatcher {
  readonly #registry: PluginRegistry;

  constructor(options: { registry: PluginRegistry }) {
    this.#registry = options.registry;
  }

  async dispatch(
    pluginId: string,
    request: Request,
    path: string,
    actor: PluginAdminActor,
  ): Promise<PluginAdminResult | null> {
    if (this.#registry.maintenance) {
      throw new Error("插件正在重载，请稍后重试。");
    }
    return this.#registry.track(this.#dispatch(pluginId, request, path, actor));
  }

  async #dispatch(
    pluginId: string,
    request: Request,
    path: string,
    actor: PluginAdminActor,
  ): Promise<PluginAdminResult | null> {
    const instance = this.#registry.get(pluginId);
    if (instance === undefined) throw new Error(`unknown plugin: ${pluginId}`);
    if (instance.status !== "loaded") {
      throw new Error(`plugin ${pluginId} is not loaded (status: ${instance.status})`);
    }
    requireCapability(instance, "admin");
    return dispatchAdminRoute(instance, request, path, actor);
  }

  /** Resolve an iframe admin page and its HTML entry. */
  page(pluginId: string, pageId?: string): PluginUiPageInfo | null {
    const instance = this.#registry.get(pluginId);
    if (instance === undefined) return null;
    return resolveAdminUiPage(instance, pageId);
  }

  /** Resolve a static UI asset, following symlinks only when they stay in root. */
  async asset(pluginId: string, assetPath: string): Promise<PluginUiAssetInfo | null> {
    const instance = this.#registry.get(pluginId);
    if (instance === undefined) return null;
    return resolveAdminUiAsset(instance, assetPath);
  }
}
