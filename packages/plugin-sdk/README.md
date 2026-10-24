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
    "capabilities": ["commands", "messages", "hooks"],
    "engines": { "opencodeQq": ">=0.1.0 <0.2.0" },
    "entry": "./src/index.ts"
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
| `ctx.storage` / `ctx.dataDir` | — | Isolated JSON/text files |
| `ctx.logger` | — | Plugin-prefixed structured logging |

Capabilities are enforced: calling `ctx.commands.register` without `"commands"` fails the plugin load instead of silently doing nothing.

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
      ],
    };
  },
});
```

Rules:

- `directory` is only accepted for projects configured with `workspace: none`.
- The core resolves both paths with `realpath`; the run directory must stay inside the configured project root.
- A profile cannot widen permissions; the core still compiles the ruleset from YAML policy.
- `formatReply` may return at most 8 non-empty segments; delays are clamped to 5 seconds and the total text to 8,000 characters.
- The first plugin returning a valid profile/plan wins. Invalid plans fall back to the original reply.

`afterRun` receives both `userText` (before injection) and `replyText` (the final assistant text), which is what transcript-memory plugins should store.

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
