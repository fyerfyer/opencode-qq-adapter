# @opencode-qq/plugin-sdk

Experimental SDK for building QQ-side plugins for [`opencode-qq-adapter`](https://github.com/fyerfyer/opencode-qq-adapter).

A plugin is trusted code that runs inside the bridge process. It can register QQ commands, inject prompt context, observe run completion, send text/images/files through the core media pipeline, and persist data in its own directory. Plugins cannot replace the permission engine or access core SQLite tables.

The SDK is at API v1. Additive changes are expected; breaking changes require a new `PLUGIN_API_VERSION`.

## Package layout

```text
my-plugin/
├── package.json       # opencodeQq manifest + entry
├── src/index.ts
└── README.md
```

`package.json`:

```json
{
  "name": "my-qq-plugin",
  "version": "0.1.0",
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "opencodeQq": {
    "id": "my-plugin",
    "name": "My plugin",
    "version": "0.1.0",
    "apiVersion": 1,
    "description": "Example plugin",
    "capabilities": ["commands", "messages", "hooks", "admin"],
    "engines": { "opencodeQq": ">=0.1.0 <0.2.0" },
    "entry": "./src/index.ts",
    "ui": { "root": "ui", "entry": "index.html" }
  },
  "dependencies": {
    "@opencode-qq/plugin-sdk": "*"
  }
}
```

`src/index.ts`:

```ts
import { defineCommand, definePlugin } from "@opencode-qq/plugin-sdk";

export default definePlugin<{ greeting: string }>({
  options: {
    parse(input) {
      const value = input as { greeting?: unknown };
      return { greeting: typeof value.greeting === "string" ? value.greeting : "你好" };
    },
  },
  setup(context) {
    context.commands.register(
      defineCommand({
        name: "hello",
        description: "Say hello",
        usage: "hello",
        handler: async (command) => {
          await command.reply(`${context.config.greeting}，${command.message.senderName}`);
        },
      }),
    );

    context.hooks.register({
      beforePrompt(prompt) {
        return { append: "[my-plugin] injected context" };
      },
      afterRun(run) {
        context.logger.info({ status: run.status }, "run finished");
      },
    });
  },
});
```

Enable it in the bridge YAML:

```yaml
plugins:
  my-plugin:
    path: ../my-plugin        # or: package: my-qq-plugin
    options:
      greeting: "你好"
```

The config key must match `opencodeQq.id`. Only explicitly configured plugins are loaded; the WebUI and QQ messages cannot upload or load code.

## Context capabilities

| API | Capability | Purpose |
| --- | --- | --- |
| `ctx.commands` | `commands` | Register `!command` handlers |
| `ctx.hooks` | `hooks` | `resolveConversationProfile`, `beforePrompt`, `formatReply`, `afterRun`, `onConfigReload` |
| `ctx.messages` | `messages` | Send text / image / file |
| `ctx.sessions` | `sessions` | Read the conversation binding; guarded `setProject` / `reset` |
| `ctx.events` | `events` | Subscribe to `run.finished` / `config.reloaded` |
| `ctx.agent` | `agent` | One-shot OpenCode utility run for background work |
| `ctx.admin` | `admin` | Plugin-owned JSON/image routes under `/admin/api/plugins/<id>/*` and optional page metadata |
| `ctx.storage` / `ctx.dataDir` | — | Isolated JSON/text files |
| `ctx.logger` | — | Plugin-prefixed structured logging |

Capabilities are enforced: calling `ctx.commands.register` without `"commands"` fails the plugin load instead of silently doing nothing.

## Admin routes

`ctx.admin` is authenticated by the core admin session; plugins never implement login, CSRF or loopback checks themselves.

```ts
context.admin.route("GET", "/items/:id", async ({ params, query }) => {
  return { id: params.id, filter: query.get("q") };
});

context.admin.route("POST", "/items", async ({ request }) => {
  const body = await request.json();
  return { created: true, body };
});

context.admin.route("GET", "/media/:file", async ({ params }) => {
  return new Response(bytes, { headers: { "content-type": "image/png" } });
});

context.admin.page({
  id: "overview",
  title: "My Plugin",
  kind: "iframe",
  // entry defaults to manifest.ui.entry
});
```

Native pages are reserved for first-party core routes; use `kind: "iframe"` for
third-party UI. The core derives the route `/plugins/<plugin-id>/<page-id>` and
serves the built assets from `manifest.ui.root` through short-lived signed URLs.

Iframe pages must use [`@opencode-qq/plugin-ui`](../plugin-ui) to connect:

```ts
import { connectPluginUi } from "@opencode-qq/plugin-ui";

const bridge = await connectPluginUi();
const result = await bridge.api.get("/items");
await bridge.ui.toast("saved", "success");
```

The iframe has no cookies, `localStorage`, or arbitrary network access. The
parent injects CSRF, restricts API paths to this plugin, and brokers storage,
toasts, confirms and core navigation. For a complete example see
[`examples/ui-plugin`](../../examples/ui-plugin).

The core mounts the routes at `/admin/api/plugins/<plugin-id>/*`, blocks HTML responses, enforces CSRF on writes, audits mutations, and supports `Response` passthrough for images/files.

## Commands

```ts
context.commands.register({
  name: "note",
  aliases: ["notes"],
  description: "Per-chat notes",
  usage: "note add <text> | note list",
  roles: ["owner", "admin", "member"], // default: all authenticated users
  chats: ["private", "group"],         // default: both
  allowGroupShared: false,             // shared groups are opt-in
  handler: async (command) => {
    // command.message / args / rawArgs / actor / conversation / reply()
    return "text returned from a handler is sent automatically";
  },
});
```

Core command names are reserved. Duplicate names/aliases between plugins also fail the load.

## Run profile and reply plan

A plugin can select a read-only directory and agent/model for a run, and can split the final reply into QQ-sized segments:

```ts
context.hooks.register({
  resolveConversationProfile({ projectId }) {
    if (projectId !== "roleplay") return undefined;
    return {
      directory: "/absolute/path/inside/project/root",
      agent: "qq-rp",
      model: "provider/model",
      workspace: "none",
    };
  },
  formatReply({ text }) {
    return {
      segments: [
        { text: text.slice(0, 80) },
        { text: text.slice(80), delayMs: 900 },
        { image: { path: "stickers/happy/1.gif", caption: "……" }, delayMs: 400 },
      ],
      // Optional: text after stripping plugin-private tags.
      replyText: text,
    };
  },
});
```

Rules:

- `directory` is only accepted for projects configured with `workspace: none`.
- The core resolves both paths with `realpath`; the run directory must stay inside the configured project root.
- A profile cannot widen permissions; the core still compiles the ruleset from YAML policy.
- `formatReply` may return at most 8 non-empty segments; delays are clamped to 5 seconds and the total text to 8,000 characters.
- Image paths are relative to the plugin data directory. The core resolves `realpath`, rejects escapes, validates PNG/JPEG/GIF/WebP magic bytes and `security.max_outbound_image_bytes`, and caps images with `qq.max_reply_images` (default 2).
- Ordered segments are sent sequentially; `!stop` is checked between segments. A failed image is logged and skipped without aborting later text.
- Set `suppress: true` to send nothing for this reply. Set `replyText` to the visible text that `afterRun` should record (for example after stripping an `[emotion:...]` tag); omit it to keep the original assistant text, or use `null` for image-only/suppressed replies.
- The first plugin returning a valid profile/plan wins. Invalid plans fall back to the original reply.

`afterRun` receives both `userText` (before injection) and `replyText` (the final assistant text or the plan's visible text), which is what transcript-memory plugins should store.

## Background utility runs

`ctx.agent.complete()` runs an ephemeral OpenCode session in the plugin data directory. Every tool is denied, the session is deleted afterwards, and the run does not touch any QQ conversation:

```ts
context.hooks.register({
  async afterRun(run) {
    // Do not await long work inside a 2s afterRun hook. Queue it instead.
    void context.agent
      .complete({
        prompt: "Summarize this in JSON",
        agent: "my-plugin-worker", // a hidden, tool-free primary agent
        model: "provider/model",   // optional
        timeoutMs: 90_000,
        label: "my-plugin.summarize",
        chatKey: run.chat.chatKey,
        actorQq: run.userId,
      })
      .then((result) => {
        context.logger.info({ text: result.text.slice(0, 80) }, "utility done");
      });
  },
});
```

Rules:

- The prompt is the only input; utility runs cannot read files or send QQ messages.
- The core serializes utility runs per plugin (at most 3 pending) and aborts them when the plugin is disposed.
- Timeouts are clamped to 5s–300s. Cost and token usage are written to the audit log as `plugin.agent`; prompt content is not.
- `agent` defaults to `build` if omitted. A custom hidden agent with `steps: 1` and all permissions denied is recommended.

## Group-aware commands

`command.groupMode` is `per_user`, `shared`, `readonly`, or `null` for private chats. In `shared`/`readonly` groups, commands that affect everyone should check the actor role:

```ts
handler(command) {
  if (
    command.message.chat.type === "group" &&
    (command.groupMode === "shared" || command.groupMode === "readonly") &&
    command.actor.role !== "owner" &&
    command.actor.role !== "admin"
  ) {
    return "只有 owner/admin 可以操作。";
  }
  return "ok";
}
```

`allowGroupShared: true` is still required for a command to run in a shared group.

## Media and paths

`sendImage` and `sendFile` accept paths relative to the plugin data directory (`<storage.plugins_dir>/<plugin-id>/`). Absolute paths are accepted only when they resolve inside that directory. Symlink escapes, `.env`, keys and `.git` internals are rejected by the core.

## Lifecycle

```text
read manifest → validate apiVersion/engine/options → import entry
  → setup(ctx) → start(ctx) → ... → stop(ctx) → dispose registrations
```

- A failed plugin is marked `failed`; the bridge and other plugins keep running.
- `setup`/`start`/`stop` and hooks have timeouts.
- Hook/event errors are logged and skipped.
- Plugin reload disposes old registrations; plugin data is kept.
- Plugins are trusted code. There is no sandbox. Review third-party plugins.

## Testing

```ts
import { createPluginHarness } from "@opencode-qq/plugin-sdk/testing";

const harness = await createPluginHarness(plugin, { options: { greeting: "hi" } });
await harness.runCommand("hello");
console.log(harness.sent);
await harness.dispose();
```

The harness exercises registration, options validation, commands, hooks, events, and storage without starting QQ or OpenCode. Media sends are recorded. Profile and reply hooks can be exercised with `harness.resolveProfile(context)` and `harness.formatReply(context)`; `harness.sessionCalls` records guarded project and session mutations.
