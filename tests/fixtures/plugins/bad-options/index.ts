import { definePlugin } from "../../../../src/plugins/sdk.js";

export default definePlugin<{ token: string }>({
  options: {
    parse(input) {
      const value =
        input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
      if (typeof value.token !== "string" || value.token.length === 0) {
        throw new Error("token is required");
      }
      return { token: value.token };
    },
  },
  setup() {
    // Never reached with invalid options.
  },
});
