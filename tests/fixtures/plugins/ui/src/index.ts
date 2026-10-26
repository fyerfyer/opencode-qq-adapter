import { definePlugin } from "../../../../../src/plugins/sdk.js";

export default definePlugin({
  setup(context) {
    context.admin.route("GET", "/summary", () => ({
      ok: true,
      plugin: context.manifest.id,
      now: Date.now(),
    }));

    context.admin.page({
      id: "overview",
      title: "UI fixture",
      kind: "iframe",
      entry: "index.html",
      description: "Fixture page",
    });
  },
});
