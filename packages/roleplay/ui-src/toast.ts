import { getPluginBridge } from "@rp/bridge";

export const toast = {
  success(message: string): void {
    void getPluginBridge().ui.toast(message, "success");
  },
  error(message: string): void {
    void getPluginBridge().ui.toast(message, "error");
  },
  info(message: string): void {
    void getPluginBridge().ui.toast(message, "info");
  },
  warning(message: string): void {
    void getPluginBridge().ui.toast(message, "warning");
  },
};
