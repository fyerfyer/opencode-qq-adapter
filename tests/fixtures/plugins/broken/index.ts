import { definePlugin } from "../../../../src/plugins/sdk.js";

export default definePlugin({
  setup() {
    throw new Error("intentional fixture failure");
  },
});
