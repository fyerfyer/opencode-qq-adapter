import { defineCommand, definePlugin } from "../../../../src/plugins/sdk.js";

export default definePlugin({
  setup(context) {
    context.commands.register(
      defineCommand({
        name: "fx-no-media",
        async handler(command) {
          await command.sendImage({ path: "missing.png" });
          return "unexpected";
        },
      }),
    );

    context.commands.register(
      defineCommand({
        name: "fx-no-conversation",
        handler(command) {
          return command.conversation?.projectId ?? "none";
        },
      }),
    );
  },
});
