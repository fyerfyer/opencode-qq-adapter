import { definePlugin } from "../../../../src/plugins/sdk.js";

interface Options {
  capability: "messages" | "sessions";
}

export default definePlugin<Options>({
  options: {
    parse(input) {
      const value =
        input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
      if (value.capability !== "messages" && value.capability !== "sessions") {
        throw new Error("capability must be messages or sessions");
      }
      return { capability: value.capability };
    },
  },
  setup(context) {
    if (context.config.capability === "messages") {
      void context.messages.reply;
    } else {
      void context.sessions.get;
    }
  },
});
