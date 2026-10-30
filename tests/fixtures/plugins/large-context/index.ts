import { definePlugin } from "../../../../src/plugins/sdk.js";

interface Options {
  prependChars: number;
  appendChars: number;
}

export default definePlugin<Options>({
  options: {
    parse(input) {
      const value =
        input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
      return {
        prependChars: typeof value.prependChars === "number" ? value.prependChars : 0,
        appendChars: typeof value.appendChars === "number" ? value.appendChars : 0,
      };
    },
  },
  setup(context) {
    context.hooks.register({
      beforePrompt() {
        return {
          prepend: "p".repeat(context.config.prependChars),
          append: "a".repeat(context.config.appendChars),
        };
      },
    });
  },
});
