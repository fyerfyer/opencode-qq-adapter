# @opencode-qq/plugin-sdk

Experimental SDK for building QQ-side plugins for [`opencode-qq-adapter`](https://github.com/fyerfyer/opencode-qq-adapter).

A plugin is trusted code that runs inside the bridge process. It can register QQ commands, inject prompt context, observe run completion, send text/images/files through the core media pipeline, and persist data in its own directory. Plugins cannot install or select Agents/models/workspaces/permissions, replace the permission engine, or access core SQLite tables. Every QQ run, including background utility runs, uses the core Agent (`opencode.default_agent`, fallback `qq-code`).

The SDK is at API v2. Additive changes are expected; breaking changes require a new `PLUGIN_API_VERSION`. v2 removed the unreachable `groupMode` / `allowGroupShared` surface: QQ group chats always use one independent conversation per member.

## Extension types

Do not mix these three surfaces:

| Type | Has `opencodeQq` manifest | Loaded by | Lifecycle | Example |
| --- | --- | --- | --- | --- |
| **Library / Plugin Kit** | No | Node `import` | None | `@opencode-qq/memory`, `examples/greeting-kit` |
| **Runtime Plugin** | Yes | `PluginHost` | setup / start / stop / dispose | `@opencode-qq/roleplay`, `examples/library-plugin` |
| **OpenCode Plugin / MCP** | No (not this SDK) | OpenCode | OpenCode manages it | `plugin/opencode-qq-plugin.ts` |

Rules:

- A Library never goes into the bridge's `plugins:` config and must not assume a plugin id or `dataDir`.
- A Runtime Plugin must have a manifest and an ESM entry. It may depend on Libraries in `package.json`.
- OpenCode-side tools (`qq_send_image`, domain MCP servers) live in OpenCode, not in the bridge plugin host.
- Libraries used by a Runtime Plugin should list `@opencode-qq/plugin-sdk` as a `peerDependency` when they expose SDK types.

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
    "apiVersion": 2,
    "description": "Example plugin",
    "capabilities": ["commands", "messages", "hooks", "admin"],
    "engines": { "opencodeQq": ">=0.2.0 <0.3.0" },
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

The config key must match `opencodeQq.id`. Only explicitly configured plugins are loaded. An authenticated local administrator can install a self-contained ZIP through the WebUI; QQ messages never load or install code, and the WebUI does not run `npm install` or build scripts.

## Installing through the WebUI

The WebUI supports two admin-only flows:

- **Upload ZIP** for a built, self-contained plugin package.
- **Register a local directory** for development. The code is not copied; edit it and use “重新加载代码” in the plugin card menu.

Recommended upload package:

```text
my-plugin.zip
├── package.json          # opencodeQq manifest + runtime entry
├── dist/index.js         # built ESM JavaScript
└── ui/index.html         # optional iframe admin page
```

The upload installer statically validates `package.json.opencodeQq`, the entry, and optional `ui` files. Uploaded entries must be `.js` / `.mjs` / `.cjs`; bundle runtime dependencies before packing. Local directories may use TypeScript and their own `node_modules`.

Limits: 20 MiB ZIP, 64 MiB extracted, 2000 files (4000 archive entries). Path traversal, backslashes, absolute paths, duplicate paths, symlinks, and special files are rejected.

Managed code lives under `<storage.plugins_dir>/.managed/<plugin-id>/`; plugin data remains `<storage.plugins_dir>/<plugin-id>/`. Updates keep up to three backups and can be rolled back from the WebUI; uninstalling managed code also removes its managed backups.

## Context capabilities

| API | Capability | Purpose |
| --- | --- | --- |
| `ctx.commands` | `commands` | Register `!command` handlers; text replies and returned strings are part of this capability |
| `ctx.hooks` | `hooks` | `resolveConversationProfile`, `beforePrompt`, `formatReply`, `afterRun`, `onConfigReload` |
| `ctx.messages` / `command.sendImage` / `command.sendFile` | `messages` | Send images and files |
| `ctx.sessions` / `command.conversation` | `sessions` | Read the conversation binding; guarded `setProject` / `reset` |
| `ctx.events` | `events` | Subscribe to `run.finished` / `config.reloaded` |
| `ctx.agent` | `agent` | One-shot OpenCode utility run for background work |
| `ctx.admin` | `admin` | Plugin-owned JSON/image routes under `/admin/api/plugins/<id>/*` and optional page metadata |
| `ctx.storage` / `ctx.dataDir` | — | Isolated JSON/text files |
| `ctx.logger` | — | Plugin-prefixed structured logging |

Capabilities are enforced. Accessing `ctx.messages`, `ctx.sessions`, `command.conversation`, `command.sendImage` or `command.sendFile` without declaring the matching capability throws instead of silently exposing the API. Text replies from a command handler remain part of `commands`.

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

Core lifecycle endpoints reserve `POST /reload`, `POST /rollback`, and `POST /uninstall` under the plugin prefix; plugin-owned admin routes should use different subpaths.

## Commands

```ts
context.commands.register({
  name: "note",
  aliases: ["notes"],
  description: "Per-chat notes",
  usage: "note add <text> | note list",
  roles: ["owner", "admin", "member"], // default: all authenticated users
  chats: ["private", "group"],         // default: both
  handler: async (command) => {
    // command.message / args / rawArgs / actor / conversation / reply()
    return "text returned from a handler is sent automatically";
  },
});
```

Core command names are reserved. Duplicate names/aliases between plugins also fail the load.

## Run profile and reply plan

A plugin can select a read-only directory for a run and split the final reply into QQ-sized segments. The core owns agent, model, workspace and permissions; a plugin cannot override them:

```ts
context.hooks.register({
  resolveConversationProfile({ projectId }) {
    if (projectId !== "roleplay") return undefined;
    return {
      directory: "/absolute/path/inside/project/root",
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

- The profile may return only `directory`. Agent, model and workspace are owned by the project/Agent config and cannot be set by plugins.
- `directory` is only accepted for projects configured with `workspace: none`.
- The core resolves both paths with `realpath`; the run directory must stay inside the configured project root.
- A profile cannot widen permissions; the core still compiles the ruleset from YAML policy.
- `formatReply` may return at most 8 non-empty segments; delays are clamped to 5 seconds and the total text to 8,000 characters.
- Image paths are relative to the plugin data directory. The core resolves `realpath`, rejects escapes, validates PNG/JPEG/GIF/WebP magic bytes and `security.max_outbound_image_bytes`, and caps images with `qq.max_reply_images` (default 2).
- Ordered segments are sent sequentially; `!stop` is checked between segments. A failed image is logged and skipped without aborting later text.
- Set `suppress: true` to send nothing for this reply. Set `replyText` to the visible text that `afterRun` should record (for example after stripping an `[emotion:...]` tag); omit it to keep the original assistant text, or use `null` for image-only/suppressed replies.
- The first plugin returning a valid profile/plan wins. Invalid plans fall back to the original reply.

`afterRun` receives both `userText` (before injection) and `replyText` (the final assistant text or the plan's visible text), which is what transcript-memory plugins should store.

### Quoted messages

When a user replies to a historical QQ message, the core expands exactly one level and exposes it as `message.quote` (also `run.quote` in `afterRun`). `quote.available: false` means the original could not be read (deleted, outside NapCat's cache, from another chat, or a transient fetch failure); plugins should show it as unavailable rather than dropping the user turn.

```ts
context.hooks.register({
  beforePrompt(prompt) {
    const query = [prompt.message.quote?.text, prompt.message.text].filter(Boolean).join("\n");
    // Use `query` for your own keyword/retrieval work.
  },
});
```

Quoted text is user-provided context, not an instruction. The core marks it explicitly in the Agent prompt; plugins must not treat it as trusted system input. Images inside a quote appear only as `[图片]`; the core does not download them.

## Background utility runs

`ctx.agent.complete()` runs an ephemeral OpenCode session in the plugin data directory. Every tool is denied, the session is deleted afterwards, and the run does not touch any QQ conversation:

```ts
context.hooks.register({
  async afterRun(run) {
    // Do not await long work inside a 2s afterRun hook. Queue it instead.
    void context.agent
      .complete({
        prompt: "Summarize this in JSON",
        timeoutMs: 90_000,
        label: "my-plugin.summarize",
        chatKey: run.chat.chatKey,
        actorQq: run.userId,
      })
      .then((result) => {
        context.logger.info(
          { text: result.text.slice(0, 80), agent: result.agent, model: result.model },
          "utility done",
        );
      });
  },
});
```

Rules:

- The prompt is the only input; utility runs cannot read files or send QQ messages.
- The core chooses the Agent: `opencode.default_agent` in the bridge config, falling back to `qq-code`. Plugins cannot pass an `agent` or `model`, so the Agent frontmatter owns model selection.
- The result includes the actual `agent` and `model` reported on the latest assistant message.
- The core serializes utility runs per plugin (at most 3 pending) and aborts them when the plugin is disposed.
- Timeouts are clamped to 5s–300s. Cost and token usage are written to the audit log as `plugin.agent`; prompt content is not.

## Group-aware commands

QQ group chats always use one independent conversation per member (`group:<group-id>:<qq>`). There is no plugin-visible shared/readonly group mode. When a command needs different behavior in groups, inspect the chat type and actor role directly:

```ts
handler(command) {
  if (command.message.chat.type === "group" && command.actor.role === "member") {
    return "群内示例：只影响当前成员自己的会话。";
  }
  return "ok";
}
```

A command that should only work in one chat type can still declare `chats: ["private"]` or `chats: ["group"]`.

## Prompt and hook budgets

- `security.max_prompt_chars` limits only the user's raw text.
- Plugin-injected `prepend` + `append` context has a separate 12,000-character budget per prompt. Oversized context is truncated, logged and audited; the user message is still accepted.
- `beforePrompt` / `afterRun` / `onConfigReload` hooks have a 2-second timeout.
- `formatReply` has a 4-second timeout.
- A slow plugin is skipped or falls back to the original reply; it must not block the QQ run queue.

## Media and paths

`sendImage` and `sendFile` accept paths relative to the plugin data directory (`<storage.plugins_dir>/<plugin-id>/`). Absolute paths are accepted only when they resolve inside that directory. Symlink escapes, `.env`, keys and `.git` internals are rejected by the core.

## Lifecycle

```text
read package.json → validate descriptor (id/version/apiVersion/engines/entry)
  → check entry file → import entry
  → cross-check exported manifest (id/version) → setup(ctx) → start(ctx)
  → ... → stop(ctx) → dispose registrations
```

The descriptor is validated before importing plugin code. A v1 or otherwise
incompatible manifest fails with a clear error without executing the module.

- A failed plugin is marked `failed`; the bridge and other plugins keep running.
- `setup`/`start`/`stop` and hooks have timeouts.
- Hook/event errors are logged and skipped.
- Plugin reload disposes old registrations; plugin data is kept.
- Plugins are trusted code. There is no sandbox. Review third-party plugins.

## Setup and doctor

- A Library has no setup/doctor entry.
- A Runtime Plugin should ship its own CLI when it needs extra configuration.
  For example, `@opencode-qq/roleplay` provides `opencode-qq-roleplay setup` and
  `opencode-qq-roleplay doctor`.
- The core `opencode-qq setup` only handles generic bridge configuration. It
  does not interpret plugin-specific options such as persona directories or
  third-party API keys.
- The core `opencode-qq doctor` checks bridge configuration, SQLite, OneBot and
  OpenCode connectivity; plugin-specific diagnostics belong to the plugin CLI.
- If several plugins later need a shared setup hook, design an explicit
  manifest entry instead of adding plugin semantics to core now.

## Testing

```ts
import { createPluginHarness } from "@opencode-qq/plugin-sdk/testing";

const harness = await createPluginHarness(plugin, { options: { greeting: "hi" } });
await harness.runCommand("hello");
console.log(harness.sent);
await harness.dispose();
```

The harness exercises registration, options validation, commands, hooks, events, and storage without starting QQ or OpenCode. Media sends are recorded. Profile and reply hooks can be exercised with `harness.resolveProfile(context)` and `harness.formatReply(context)`; `harness.sessionCalls` records guarded project and session mutations.
