import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { definePlugin } from "../../../../src/plugins/sdk.js";

type Mode = "mixed" | "image" | "suppress" | "escape" | "invalid" | "many" | "legacy";

const PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lK3Q6wAAAABJRU5ErkJggg==",
  "base64",
);

export default definePlugin<{ mode: Mode }>({
  options: {
    parse(input) {
      const value =
        input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
      const mode = typeof value.mode === "string" ? value.mode : "mixed";
      if (!["mixed", "image", "suppress", "escape", "invalid", "many", "legacy"].includes(mode)) {
        throw new Error(`unknown mode: ${mode}`);
      }
      return { mode: mode as Mode };
    },
  },
  async setup(context) {
    await writeFile(join(context.dataDir, "pixel.png"), PIXEL_PNG, { mode: 0o600 });
    await writeFile(join(context.dataDir, "pixel.txt"), "not an image", { mode: 0o600 });
    context.hooks.register({
      formatReply() {
        switch (context.config.mode) {
          case "mixed":
            return {
              segments: [
                { text: "第一段" },
                { text: "第二段", delayMs: 10 },
                { image: { path: "pixel.png", caption: "图注" }, delayMs: 10 },
              ],
            };
          case "image":
            return { segments: [{ image: { path: "pixel.png" } }] };
          case "suppress":
            return { segments: [], suppress: true };
          case "escape":
            return {
              segments: [
                { text: "before" },
                { image: { path: "../escape.png" } },
                { text: "after" },
              ],
            };
          case "invalid":
            return {
              segments: [{ text: "before" }, { image: { path: "pixel.txt" } }, { text: "after" }],
            };
          case "many":
            return {
              segments: [
                { text: "before" },
                { image: { path: "pixel.png" } },
                { image: { path: "pixel.png" } },
                { image: { path: "pixel.png" } },
              ],
            };
          case "legacy":
            return { segments: [{ text: "legacy" }] };
        }
      },
    });
  },
});
