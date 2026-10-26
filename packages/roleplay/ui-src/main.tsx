import { createRoot } from "react-dom/client";
import { connectPluginUi } from "@opencode-qq/plugin-ui";
import { RoleplayPage } from "@rp/app";
import { setPluginBridge } from "@rp/bridge";
import "./index.css";

async function boot(): Promise<void> {
  const root = document.querySelector("#root");
  if (root === null) throw new Error("missing #root");
  try {
    const bridge = await connectPluginUi();
    setPluginBridge(bridge);
    createRoot(root).render(
      <div className="min-h-svh p-4 md:p-6 lg:p-8">
        <RoleplayPage />
      </div>,
    );
  } catch (error) {
    root.textContent =
      error instanceof Error
        ? `Roleplay UI 无法连接管理台：${error.message}`
        : `Roleplay UI 无法连接管理台：${String(error)}`;
    root.className = "p-8 text-sm text-muted-foreground";
  }
}

void boot();
