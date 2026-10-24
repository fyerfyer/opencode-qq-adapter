import { describe, expect, it } from "vitest";
import { defineCommand, definePlugin } from "../../src/plugins/sdk.js";
import { createPluginHarness } from "../../src/plugins/testing.js";

describe("Plugin SDK testing harness", () => {
  it("runs commands, hooks and storage without a bridge", async () => {
    const plugin = definePlugin<{ prefix: string }>({
      options: {
        parse(input) {
          const value = input as { prefix?: unknown };
          return { prefix: typeof value.prefix === "string" ? value.prefix : "hi" };
        },
      },
      setup(context) {
        context.commands.register(
          defineCommand({
            name: "greet",
            aliases: ["g"],
            handler(command) {
              return `${context.config.prefix} ${command.args.join(" ")}`.trim();
            },
          }),
        );
        context.commands.register(
          defineCommand({
            name: "save",
            async handler() {
              await context.storage.writeJson("state.json", { ok: true });
              return "saved";
            },
          }),
        );
        context.hooks.register({
          beforePrompt() {
            return { append: "harness-context" };
          },
          afterRun() {
            void context.storage.writeText("after.txt", "done");
          },
        });
        context.events.on("run.finished", async () => {
          await context.storage.writeText("event.txt", "done");
        });
      },
    });

    const harness = await createPluginHarness(plugin, { options: { prefix: "hello" } });
    try {
      expect(await harness.runCommand("g", { args: ["world"] })).toBe("hello world");
      expect(harness.sent[0]?.text).toBe("hello world");

      expect(await harness.runCommand("save")).toBe("saved");
      expect(await harness.context.storage.readJson("state.json")).toEqual({ ok: true });

      const patch = await harness.beforePrompt({
        message: {
          id: "1",
          chat: { type: "private", userId: 1, chatKey: "private:1" },
          userId: 1,
          senderName: "Tester",
          text: "hello",
          images: [],
          mentionsBot: false,
          receivedAt: Date.now(),
        },
        projectId: "demo",
        conversation: null,
      });
      expect(patch).toEqual({ append: "harness-context" });

      await harness.afterRun({
        runId: "run_1",
        chat: { type: "private", userId: 1, chatKey: "private:1" },
        userId: 1,
        projectId: "demo",
        workspaceId: null,
        sessionId: null,
        status: "completed",
        usage: null,
        error: null,
        durationMs: 10,
        promptText: "hello",
      });
      await harness.emit("run.finished", {
        runId: "run_1",
        chat: { type: "private", userId: 1, chatKey: "private:1" },
        userId: 1,
        projectId: "demo",
        workspaceId: null,
        sessionId: null,
        status: "completed",
        usage: null,
        error: null,
        durationMs: 10,
        promptText: "hello",
      });
      expect(await harness.context.storage.readText("after.txt")).toBe("done");
      expect(await harness.context.storage.readText("event.txt")).toBe("done");
    } finally {
      await harness.dispose();
    }
  });
});
