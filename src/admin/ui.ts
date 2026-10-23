import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The Vite build writes into `<package>/dist/admin`. Keeping the SPA inside the
 * npm package means `opencode-qq` can serve it without a second process.
 */
export function adminDistRoot(): string {
  const override = process.env.OPENCODE_QQ_WEBUI_DIST;
  if (override !== undefined && override.length > 0) return resolve(override);
  const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
  return join(packageRoot, "dist");
}

export function adminIndexPath(): string {
  return join(adminDistRoot(), "admin", "index.html");
}

export async function readAdminIndex(): Promise<string | null> {
  try {
    return await readFile(adminIndexPath(), "utf8");
  } catch {
    return null;
  }
}

export function adminBuildHint(): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>OpenCode QQ Admin</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, sans-serif; background:#09090b; color:#fafafa; display:grid; place-items:center; min-height:100vh; margin:0; }
      main { max-width: 640px; padding: 2rem; border:1px solid #27272a; border-radius:16px; background:#111113; }
      code { background:#18181b; padding:.2rem .4rem; border-radius:6px; }
      p { color:#a1a1aa; line-height:1.7; }
    </style>
  </head>
  <body>
    <main>
      <h1>WebUI 尚未构建</h1>
      <p>管理前端需要先生成静态资源。请在项目目录运行：</p>
      <p><code>pnpm build:webui</code></p>
      <p>开发时也可以运行 <code>pnpm dev:webui</code>，通过 Vite 的 <code>/admin/api</code> 代理连接 bridge。</p>
    </main>
  </body>
</html>`;
}
