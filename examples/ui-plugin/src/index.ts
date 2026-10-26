import { defineCommand, definePlugin } from "@opencode-qq/plugin-sdk";

interface Item {
  id: number;
  text: string;
  createdAt: number;
}

export default definePlugin({
  setup(context) {
    const items: Item[] = [];
    let nextId = 1;

    context.commands.register(
      defineCommand({
        name: "ui-demo",
        description: "打开 UI Demo 插件页面",
        usage: "ui-demo",
        handler() {
          return "在管理台的「插件」页打开 UI Demo；页面通过 iframe bridge 调用本插件的 admin API。";
        },
      }),
    );

    context.admin.route("GET", "/summary", () => ({
      plugin: context.manifest.id,
      version: context.manifest.version,
      items: items.length,
      now: Date.now(),
    }));

    context.admin.route("GET", "/items", () => ({ items }));

    context.admin.route("POST", "/items", async ({ request }) => {
      const body = (await request.json()) as { text?: unknown };
      if (typeof body.text !== "string" || body.text.trim().length === 0) {
        return new Response(JSON.stringify({ error: "invalid_text", message: "内容不能为空。" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      const item: Item = { id: nextId++, text: body.text.trim(), createdAt: Date.now() };
      items.push(item);
      return { item };
    });

    context.admin.route("DELETE", "/items/:id", ({ params }) => {
      const id = Number(params.id);
      const index = items.findIndex((item) => item.id === id);
      if (index < 0) {
        return new Response(JSON.stringify({ error: "not_found", message: "条目不存在。" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      items.splice(index, 1);
      return { ok: true };
    });

    context.admin.page({
      id: "overview",
      title: "UI Demo",
      kind: "iframe",
      description: "一个最小的第三方 iframe 页面示例",
    });
  },
});
