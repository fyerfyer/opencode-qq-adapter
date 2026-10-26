import { rmSync } from "node:fs";

// dist/admin contains both the Vite SPA and compiled server modules
// (src/admin -> dist/admin). Remove only the hashed asset directory so a
// WebUI rebuild cannot delete dist/admin/auth.js and friends.
rmSync(new URL("../dist/admin/assets", import.meta.url), {
  recursive: true,
  force: true,
});
