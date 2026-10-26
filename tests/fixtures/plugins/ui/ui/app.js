import { connectPluginUi } from "./sdk.js";

const status = document.querySelector("#status");
const ping = document.querySelector("#ping");
const toastButton = document.querySelector("#toast");

async function main() {
  try {
    const bridge = await connectPluginUi();
    status.textContent = `bridge connected: ${bridge.context.pluginId} / ${bridge.context.pageId}`;
    ping.addEventListener("click", async () => {
      try {
        const result = await bridge.api.get("/summary");
        status.textContent = JSON.stringify(result);
      } catch (error) {
        status.textContent = `error: ${error instanceof Error ? error.message : String(error)}`;
      }
    });
    toastButton.addEventListener("click", () => {
      void bridge.ui.toast("来自 UI fixture", "success");
    });
    document.querySelector("#confirm").addEventListener("click", async () => {
      const confirmed = await bridge.ui.confirm({
        title: "Fixture 确认",
        description: "确认后会显示一条 toast。",
        confirmText: "确认",
        destructive: true,
      });
      await bridge.ui.toast(confirmed ? "fixture confirmed" : "fixture cancelled", "info");
    });
    document.querySelector("#escape").addEventListener("click", async () => {
      try {
        await bridge.api.get("/../../admin/api/users");
        status.textContent = "escape allowed";
      } catch (error) {
        status.textContent = `escape blocked: ${error instanceof Error ? error.message : String(error)}`;
      }
    });
  } catch (error) {
    status.textContent = `bridge error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

void main();
