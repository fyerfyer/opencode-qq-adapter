# QQ plugin examples

This directory contains runnable examples for the three extension types. They
are intentionally small and copyable.

| Directory | Type | Demonstrates |
| --- | --- | --- |
| [`greeting-kit`](greeting-kit) | **Library / Plugin Kit** | Pure formatting helpers; no `opencodeQq` manifest and never loaded by `PluginHost` |
| [`library-plugin`](library-plugin) | **Runtime Plugin** | Manifest-based plugin that imports `greeting-kit` as a normal dependency |
| [`hello-plugin`](hello-plugin) | Runtime Plugin | Commands, hooks, options, prompt context injection |
| [`notes-plugin`](notes-plugin) | Runtime Plugin | Per-chat persistent data via `ctx.storage` |
| [`media-plugin`](media-plugin) | Runtime Plugin | `sendImage` / `sendFile` from the plugin data directory |
| [`ui-plugin`](ui-plugin) | Runtime Plugin | Sandboxed iframe page + `@opencode-qq/plugin-ui` bridge |

The bridge's `plugin/` directory is a different thing: it is an **OpenCode
Plugin** that runs inside OpenCode and exposes `qq_send_image` / `qq_send_file`.
It is not loaded by the bridge plugin host and has no `opencodeQq` manifest.

## Enable in development

From the repository root:

```bash
pnpm install
pnpm build:sdk
pnpm build:plugin-ui
cp packages/plugin-ui/dist/index.js examples/ui-plugin/ui/sdk.js
```

Add entries to `config/config.yaml`:

```yaml
plugins:
  greeting:
    path: ../examples/hello-plugin
    options:
      greeting: "你好"
      injectContext: false
  library-demo:
    path: ../examples/library-plugin
    options:
      greeting: "嗨"
      punctuation: "～"
      injectContext: false
  notes:
    path: ../examples/notes-plugin
    options:
      maxNotes: 50
  media-demo:
    path: ../examples/media-plugin
  ui-demo:
    path: ../examples/ui-plugin
```

`library-demo` depends on the workspace package
`@opencode-qq/example-greeting-kit`. The `greeting-kit` package itself must not
appear under `plugins:`: libraries have no manifest and are loaded by their
runtime plugin with `import`.

`ui-demo` registers an iframe page; open `/admin/plugins/ui-demo` after the bridge starts.

The path is resolved relative to the config file. The key (`hello`, `library-demo`, `notes`, `media-demo`) must match the plugin's `opencodeQq.id` in its `package.json`.

Start the bridge and try:

```text
!plugins
!hello
!echo hello
!hello-info
!greet Bessie
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
- A Library should use `peerDependencies` for `@opencode-qq/plugin-sdk` when it exposes SDK types, and must not assume a plugin id or `dataDir`.
