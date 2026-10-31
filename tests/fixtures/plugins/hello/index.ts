import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defineCommand, definePlugin } from "../../../../src/plugins/sdk.js";

interface FixtureOptions {
  greeting: string;
  requireGreeting: boolean;
}

const PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lK3Q6wAAAABJRU5ErkJggg==",
  "base64",
);

export default definePlugin<FixtureOptions>({
  options: {
    parse(input) {
      const value =
        input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
      const requireGreeting = value.requireGreeting === true;
      if (requireGreeting && typeof value.greeting !== "string") {
        throw new Error("greeting is required");
      }
      return {
        greeting: typeof value.greeting === "string" ? value.greeting : "fixture-hello",
        requireGreeting,
      };
    },
  },
  setup(context) {
    context.commands.register(
      defineCommand({
        name: "fx-hello",
        description: "fixture greeting",
        chats: ["private", "group"],
        handler() {
          return context.config.greeting;
        },
      }),
    );

    context.commands.register(
      defineCommand({
        name: "fx-echo",
        aliases: ["fx-repeat"],
        handler(command) {
          return command.rawArgs;
        },
      }),
    );

    context.commands.register(
      defineCommand({
        name: "fx-owner",
        roles: ["owner"],
        handler() {
          return "owner-only";
        },
      }),
    );

    context.commands.register(
      defineCommand({
        name: "fx-private",
        chats: ["private"],
        handler() {
          return "private-only";
        },
      }),
    );

    context.commands.register(
      defineCommand({
        name: "fx-shared",
        chats: ["group"],
        handler() {
          return "shared-command";
        },
      }),
    );

    context.commands.register(
      defineCommand({
        name: "fx-image",
        handler: async (command) => {
          const path = join(context.dataDir, "fixture.png");
          await writeFile(path, PIXEL_PNG, { mode: 0o600 });
          const result = await command.sendImage({ path, caption: "fixture image" });
          return `image:${result.messageId}`;
        },
      }),
    );

    context.commands.register(
      defineCommand({
        name: "fx-file",
        handler: async (command) => {
          const path = join(context.dataDir, "fixture.txt");
          await writeFile(path, "fixture file\n", { mode: 0o600 });
          const result = await command.sendFile({ path, name: "fixture.txt" });
          return `file:${result.messageId}`;
        },
      }),
    );

    context.commands.register(
      defineCommand({
        name: "fx-store",
        handler: async () => {
          const current = (await context.storage.readJson<{ count: number }>("state.json")) ?? {
            count: 0,
          };
          current.count += 1;
          await context.storage.writeJson("state.json", current);
          return `count:${current.count}`;
        },
      }),
    );

    context.commands.register(
      defineCommand({
        name: "fx-session",
        handler(command) {
          return command.conversation?.projectId ?? "no-conversation";
        },
      }),
    );

    context.hooks.register({
      beforePrompt(prompt) {
        return { append: `[fixture-context:${prompt.projectId}]` };
      },
      async afterRun(run) {
        await context.storage.writeJson("last-run.json", {
          runId: run.runId,
          status: run.status,
          error: run.error,
          quote: run.quote,
        });
      },
      async onConfigReload(reload) {
        await context.storage.writeJson("reload.json", { applied: reload.applied });
      },
    });

    context.events.on("run.finished", async (event) => {
      await context.storage.writeJson("event.json", {
        type: "run.finished",
        runId: event.runId,
        status: event.status,
      });
    });
  },
});
