import { copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineCommand, definePlugin } from "@opencode-qq/plugin-sdk";

const DEMO_IMAGE = fileURLToPath(new URL("../assets/demo.png", import.meta.url));

export default definePlugin({
  setup(context) {
    context.commands.register(
      defineCommand({
        name: "sticker",
        description: "发送插件自带的示例图片",
        usage: "sticker [说明]",
        chats: ["private", "group"],
        handler: async (command) => {
          const path = join(context.dataDir, "hello-plugin.png");
          await copyFile(DEMO_IMAGE, path);
          const caption = command.rawArgs.trim() || "来自 media-demo 插件的图片";
          await command.sendImage({ path, caption });
          return undefined;
        },
      }),
    );

    context.commands.register(
      defineCommand({
        name: "samplefile",
        description: "生成并发送一个文本文件",
        usage: "samplefile",
        chats: ["private", "group"],
        handler: async (command) => {
          const path = join(context.dataDir, "hello-plugin.txt");
          await writeFile(
            path,
            [
              "opencode-qq plugin SDK media demo",
              `plugin: ${context.manifest.id}`,
              `time: ${new Date().toISOString()}`,
              "",
            ].join("\n"),
            { mode: 0o600 },
          );
          await command.sendFile({
            path,
            name: "qq-plugin-demo.txt",
            caption: "插件生成的文件",
          });
          return undefined;
        },
      }),
    );

    context.commands.register(
      defineCommand({
        name: "media-info",
        description: "查看媒体 demo 的数据目录",
        usage: "media-info",
        chats: ["private"],
        roles: ["owner", "admin"],
        handler() {
          return [`media-demo 插件`, `数据目录：${context.dataDir}`].join("\n");
        },
      }),
    );
  },
});
