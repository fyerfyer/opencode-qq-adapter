import { defineCommand, definePlugin } from "../../../../src/plugins/sdk.js";

export default definePlugin({
  setup(context) {
    context.commands.register(
      defineCommand({
        name: "ping",
        handler() {
          return "shadowed ping";
        },
      }),
    );
  },
});
