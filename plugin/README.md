# opencode-qq-plugin

OpenCode plugin that adds the `qq_send_image` and `qq_send_file` tools. The agent calls one with a path inside its workspace; the plugin forwards the request to the bridge, which validates the path and sends the image/file to the QQ chat that owns the session.

`qq_send_file` is intended for Markdown reports, generated documents, archives, and similar files. It refuses `.env` files, secrets, `.git` internals, and symlink escapes. File sending is enabled by `features.files: true` and limited by `security.max_outbound_file_bytes` (default 50 MB).

Two variants are included:

| OpenCode version | File | Plugin API |
| --- | --- | --- |
| V2 (2.x) | `opencode-qq-plugin.ts` | default export with `id` + `setup(ctx)` |
| V1 (1.x) | `v1-opencode-qq-plugin.ts` | `@opencode-ai/plugin` function + `tool()` |

## Install (V2 local plugin)

`opencode-qq setup` installs this plugin automatically and writes the `qq-bridge.json` callback config. The manual steps below are for development or custom deployments.

1. Copy or symlink `opencode-qq-plugin.ts` into an OpenCode plugin directory:

   ```bash
   mkdir -p ~/.config/opencode/plugins
   ln -sf "$(pwd)/plugin/opencode-qq-plugin.ts" \
     ~/.config/opencode/plugins/opencode-qq-plugin.ts
   ```

   Or copy it for a project-level plugin:

   ```bash
   mkdir -p .opencode/plugins
   cp plugin/opencode-qq-plugin.ts .opencode/plugins/
   ```

2. Configure the bridge callback. Either export these variables for the OpenCode service:

   ```bash
   export QQ_BRIDGE_INTERNAL_URL=http://127.0.0.1:8787
   export QQ_BRIDGE_INTERNAL_TOKEN=<same value as server.internal_token>
   opencode serve --service
   ```

   Or create `~/.config/opencode/qq-bridge.json` (mode `0600`) so the plugin can also work when OpenCode is launched by the TUI and does not inherit a shell environment:

   ```json
   {
     "url": "http://127.0.0.1:8787",
     "token": "<same value as server.internal_token>"
   }
   ```

   The token is a low-privilege token: it can only call the media callback endpoints, and the bridge still verifies the session, workspace and file.

3. Restart OpenCode and confirm the plugin is loaded:

   ```bash
   opencode plugin list
   ```

## V1

Copy `v1-opencode-qq-plugin.ts` into `~/.config/opencode/plugins/` instead. It imports `@opencode-ai/plugin`, which is bundled with OpenCode 1.x.

## Type checking

The plugins import `node:fs`, `node:os`, and `node:path`, so they need Node type definitions:

```bash
pnpm typecheck:plugin
```

`plugin/tsconfig.json` includes both plugin files and enables `types: ["node"]`. `v1-opencode-qq-plugin.ts` additionally imports `@opencode-ai/plugin`; it is declared as a peer dependency (OpenCode provides it at runtime) and installed as a root dev dependency so `pnpm typecheck:plugin` can resolve its types.

If you copy a plugin outside this repository (for example into `~/.config/opencode/plugins/`), the editor no longer sees that tsconfig and may report `Cannot find name 'node:fs'` or `Cannot find name 'process'`. Install the types next to the plugin and give it a small tsconfig:

```bash
cd ~/.config/opencode
npm install --save-dev @types/node
```

Then place a `tsconfig.json` in `~/.config/opencode/plugins/` with `"target": "ES2023"`, `"module": "NodeNext"`, `"types": ["node"]`, `"noEmit": true`, and `"include": ["*.ts"]`. When using the V1 plugin, install `@opencode-ai/plugin` in the same directory too.

## Why a plugin instead of MCP?

The tool execution context includes `sessionID`, so the bridge can map the call back to a QQ conversation without exposing QQ numbers to the model. MCP servers are bound to a session/directory lifecycle and are awkward to keep in sync across many QQ conversations.
