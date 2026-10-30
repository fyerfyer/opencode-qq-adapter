import { definePlugin } from "../../../../src/plugins/sdk.js";

interface Options {
  delayMs: number;
}

export default definePlugin<Options>({
  options: {
    parse(input) {
      const value =
        input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
      return {
        delayMs: typeof value.delayMs === "number" ? value.delayMs : 300,
      };
    },
  },
  setup(context) {
    context.hooks.register({
      async afterRun() {
        await new Promise((resolve) => setTimeout(resolve, context.config.delayMs));
      },
    });
  },
});
