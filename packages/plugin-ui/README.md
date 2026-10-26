# @opencode-qq/plugin-ui

Framework-agnostic browser bridge for plugin admin pages hosted by
`opencode-qq-adapter` in a sandboxed iframe.

## Quick start

Build the plugin UI with Vite (or any bundler) and use a relative base so
assets stay under the signed plugin asset path:

```ts
// vite.config.ts
export default defineConfig({ base: "./" });
```

```ts
import { connectPluginUi } from "@opencode-qq/plugin-ui";

const bridge = await connectPluginUi();

const items = await bridge.api.get<{ items: string[] }>("/items");
await bridge.api.post("/items", { text: "hello" });

await bridge.ui.toast("saved", "success");
const confirmed = await bridge.ui.confirm({
  title: "Delete?",
  destructive: true,
});
if (confirmed) await bridge.api.delete("/items/1");

await bridge.ui.navigate("/plugins");
```

`connectPluginUi()` reads the `__qq_ui` nonce from the iframe URL, performs the
handshake, receives a private `MessagePort`, and applies the core CSS variables
to `:root` (including theme changes). Import the optional baseline stylesheet:

```ts
import "@opencode-qq/plugin-ui/styles.css";
```

## API

| Member | Purpose |
| --- | --- |
| `bridge.context` | Plugin id, page id, title, locale and initial theme |
| `bridge.api.request` | Raw authenticated request/response |
| `bridge.api.get/post/put/patch/delete` | JSON helpers |
| `bridge.api.upload` | `FormData` upload; files are transferred as ArrayBuffers |
| `bridge.api.blob` | Fetch an authenticated binary as a `Blob` (images, downloads) |
| `bridge.storage.get/set/remove` | JSON preferences namespaced by plugin id |
| `bridge.ui.toast` | Core sonner toast |
| `bridge.ui.confirm` | Core AlertDialog; returns a boolean |
| `bridge.ui.openExternal` | Open an http(s) URL in a new tab |
| `bridge.ui.navigate` | Navigate the parent to a core route |
| `bridge.onThemeChange` | Subscribe to theme token updates |
| `bridge.close()` | Close the MessagePort and reject pending calls |

## Security model

- The iframe is sandboxed without `allow-same-origin`; it cannot read the
  parent DOM, cookies or `localStorage`.
- It has `connect-src 'none'`; all data goes through the bridge.
- The parent injects the admin CSRF token and restricts API paths to
  `/admin/api/plugins/<current-plugin>/*`.
- The signed static asset token only grants read access to the plugin's built
  UI; it carries no session.

Use hash or memory routing inside plugin pages. `history.pushState` and
`localStorage` are generally unavailable in an opaque-origin iframe; use
`bridge.storage` for preferences.
