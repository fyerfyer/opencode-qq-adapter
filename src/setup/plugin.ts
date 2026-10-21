import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  backupFile,
  ensureDirectory,
  readTextIfExists,
  writePrivateFile,
  writePublicFile,
} from "./files.js";

export interface PluginInstallOptions {
  openCodeConfigDir: string;
  bridgeUrl: string;
  token: string;
  force?: boolean;
  pluginSource?: string;
}

export interface PluginInstallResult {
  pluginPath: string;
  bridgeConfigPath: string;
  warnings: string[];
}

/**
 * Install the image tool plugin into OpenCode's global plugin directory.
 *
 * The plugin file is deliberately copied rather than referenced by a workspace
 * symlink: a global npm install has no stable checkout, and OpenCode loads the
 * global `plugins/` directory automatically.
 */
export function installOpenCodePlugin(options: PluginInstallOptions): PluginInstallResult {
  const warnings: string[] = [];
  const pluginDir = join(options.openCodeConfigDir, "plugins");
  ensureDirectory(pluginDir);
  const pluginPath = join(pluginDir, "opencode-qq-plugin.ts");
  const bridgeConfigPath = join(options.openCodeConfigDir, "qq-bridge.json");
  const source = options.pluginSource ?? defaultPluginSource();

  if (!existsSync(source)) {
    throw new Error(`Bundled OpenCode plugin not found: ${source}`);
  }

  const existing = readTextIfExists(pluginPath);
  const pluginContent = readTextIfExists(source);
  if (pluginContent === null) {
    throw new Error(`Unable to read bundled OpenCode plugin: ${source}`);
  }
  if (existing !== null && existing !== pluginContent) {
    const backup = backupFile(pluginPath);
    if (backup !== null) warnings.push(`Backed up existing plugin to ${backup}`);
  }
  writePublicFile(pluginPath, pluginContent);
  try {
    chmodSync(pluginPath, 0o644);
  } catch {
    // Best effort.
  }

  writePrivateFile(
    bridgeConfigPath,
    `${JSON.stringify({ url: options.bridgeUrl, token: options.token }, null, 2)}\n`,
  );

  return { pluginPath, bridgeConfigPath, warnings };
}

export function defaultPluginSource(): string {
  return fileURLToPath(new URL("../../plugin/opencode-qq-plugin.ts", import.meta.url));
}

export function defaultOpenCodeConfigDir(configHome: string): string {
  return join(configHome, "opencode");
}
