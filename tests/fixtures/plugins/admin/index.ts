import { definePlugin } from "../../../../src/plugins/sdk.js";

const PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lK3Q6wAAAABJRU5ErkJggg==",
  "base64",
);

interface AdminFixtureOptions {
  greeting: string;
}

export default definePlugin<AdminFixtureOptions>({
  options: {
    parse(input) {
      const value =
        input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
      if (value.greeting !== undefined && typeof value.greeting !== "string") {
        throw new Error("greeting must be a string");
      }
      const greeting = typeof value.greeting === "string" ? value.greeting : "admin-hello";
      if (greeting.length === 0) throw new Error("greeting is required");
      return { greeting };
    },
  },
  setup(context) {
    context.admin.route("GET", "/ping", ({ query, actor }) => ({
      ok: true,
      value: query.get("x"),
      actor: actor.username,
      greeting: context.config.greeting,
    }));

    context.admin.route("GET", "/items/:id", ({ params }) => ({ id: params.id }));

    context.admin.route("POST", "/echo", async ({ request }) => ({
      body: await request.json(),
    }));

    context.admin.route("GET", "/image", () => {
      return new Response(PIXEL_PNG, {
        headers: {
          "content-type": "image/png",
          "cache-control": "private, max-age=60",
        },
      });
    });

    context.admin.route("GET", "/items/:id/children/:childId", ({ params }) => ({
      id: params.id,
      childId: params.childId,
    }));

    context.admin.page({
      id: "admin-fixture",
      title: "Admin fixture",
      path: "/admin-fixture",
      description: "Fixture page",
    });
  },
});
