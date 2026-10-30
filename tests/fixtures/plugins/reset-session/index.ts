import { defineCommand, definePlugin } from "../../../../src/plugins/sdk.js";

export default definePlugin({
  setup(context) {
    context.commands.register(
      defineCommand({
        name: "fx-reset",
        handler(command) {
          const result = context.sessions.reset(command.message.chat.chatKey, command.actor);
          return result.ok ? "reset-ok" : (result.reason ?? "reset-failed");
        },
      }),
    );
  },
});
