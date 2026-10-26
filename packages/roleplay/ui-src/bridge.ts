import type { PluginUiBridge } from "@opencode-qq/plugin-ui";

let bridge: PluginUiBridge | null = null;

export function setPluginBridge(next: PluginUiBridge): void {
  bridge = next;
}

export function getPluginBridge(): PluginUiBridge {
  if (bridge === null) {
    throw new Error("Roleplay bridge is not connected yet.");
  }
  return bridge;
}
