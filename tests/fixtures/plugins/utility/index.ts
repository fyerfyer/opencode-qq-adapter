import { defineCommand, definePlugin } from "../../../../src/plugins/sdk.js";

export default definePlugin({
  setup(context) {
    context.commands.register(
      defineCommand({
        name: "fx-utility",
        handler: async (command) => {
          const result = await context.agent.complete({
            prompt: command.rawArgs || "hello",
            agent: "helper",
            model: "test/model",
            timeoutMs: 5_000,
            label: "fixture.utility",
            chatKey: command.message.chat.chatKey,
            actorQq: command.message.userId,
          });
          return result.text;
        },
      }),
    );

    context.commands.register(
      defineCommand({
        name: "fx-utility-twice",
        handler: async () => {
          const [first, second] = await Promise.all([
            context.agent.complete({ prompt: "a", label: "first" }),
            context.agent.complete({ prompt: "b", label: "second" }),
          ]);
          return `${first.text}|${second.text}`;
        },
      }),
    );

    context.commands.register(
      defineCommand({
        name: "fx-utility-error",
        handler: async () => {
          try {
            await context.agent.complete({ prompt: "x" });
            return "no-error";
          } catch (error) {
            return `error:${error instanceof Error ? error.message : String(error)}`;
          }
        },
      }),
    );

    context.commands.register(
      defineCommand({
        name: "fx-utility-slow",
        handler: async () => {
          try {
            await context.agent.complete({ prompt: "slow", timeoutMs: 300_000 });
            return "slow-done";
          } catch (error) {
            return `error:${error instanceof Error ? error.message : String(error)}`;
          }
        },
      }),
    );
  },
});
