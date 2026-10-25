import { defineCommand, definePlugin } from "../../../../src/plugins/sdk.js";

export default definePlugin({
  setup(context) {
    context.commands.register(
      defineCommand({
        name: "fx-no-agent",
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
  },
});
