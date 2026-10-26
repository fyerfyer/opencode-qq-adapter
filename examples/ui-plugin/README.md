# UI Demo plugin

Demonstrates a third-party plugin admin page rendered in the core WebUI as a
sandboxed iframe.

## How it works

- `package.json` declares `opencodeQq.ui.root = "ui"` and `entry = "index.html"`.
- `src/index.ts` registers `kind: "iframe"` with `context.admin.page()` and
  exposes JSON routes under `/admin/api/plugins/ui-demo/*`.
- `ui/app.js` imports `@opencode-qq/plugin-ui` and calls the bridge:

```js
const bridge = await connectPluginUi();
const items = await bridge.api.get("/items");
await bridge.ui.toast("saved", "success");
```

The iframe has no cookies, no `localStorage`, and no direct network access.
Every API request is brokered by the parent, which injects the admin CSRF token
and restricts the path to this plugin.

## Build the reference client

The browser cannot import an npm package in a zero-build example, so copy the
compiled single-file client next to the example page:

```bash
pnpm build:plugin-ui
cp packages/plugin-ui/dist/index.js examples/ui-plugin/ui/sdk.js
```

For a real plugin use Vite (or any bundler) and import
`@opencode-qq/plugin-ui` directly. Set `base: "./"` so asset URLs stay inside
the signed plugin asset path.

## Enable

```yaml
plugins:
  ui-demo:
    path: ../examples/ui-plugin
```

Then open `/admin/plugins/ui-demo` in the WebUI.
