# QQ plugin examples

These packages are real plugins loaded by the bridge's plugin host. They also serve as copyable starting points for third-party plugins.

| Directory | Plugin id | Demonstrates |
| --- | --- | --- |
| [`hello-plugin`](hello-plugin) | `hello` | commands, hooks, options, prompt context injection |
| [`notes-plugin`](notes-plugin) | `notes` | per-chat persistent data via `ctx.storage` |
| [`media-plugin`](media-plugin) | `media-demo` | `sendImage` / `sendFile` from the plugin data directory |

## Enable in development

From the repository root:

```bash
pnpm install
pnpm build:sdk
```

Add entries to `config/config.yaml`:

```yaml
plugins:
  hello:
    path: ../examples/hello-plugin
    options:
      greeting: "你好"
      injectContext: false
  notes:
    path: ../examples/notes-plugin
    options:
      maxNotes: 50
  media-demo:
    path: ../examples/media-plugin
```

The path is resolved relative to the config file. The key (`hello`, `notes`, `media-demo`) must match the plugin's `opencodeQq.id` in its `package.json`.

Start the bridge and try:

```text
!plugins
!hello
!echo hello
!hello-info
!note add 明天看一下部署脚本
!note list
!note del 1
!sticker
!samplefile
```

`!hello-info` and `!media-info` are owner/admin-only and private-chat-only.

## Production notes

- Plugins run as trusted code in the bridge process. Review any third-party plugin before enabling it.
- Build plugins to ESM JavaScript before installing them from npm. The local examples point `opencodeQq.entry` at TypeScript and rely on `tsx` in dev.
- Plugin data lives under `storage.plugins_dir/<plugin-id>/`; uninstalling a plugin does not delete its data automatically.
