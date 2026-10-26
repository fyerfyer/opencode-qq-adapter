import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: "/admin/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    outDir: fileURLToPath(new URL("../../dist/admin", import.meta.url)),
    // dist/admin also contains compiled server code (src/admin). Cleaning the
    // whole directory here would delete dist/admin/auth.js and friends; the
    // root build:webui script only removes the hashed asset directory.
    emptyOutDir: false,
    sourcemap: false,
    // The admin UI is local-only and loaded once per session; keep the build
    // simple instead of introducing fragile manual vendor chunks.
    chunkSizeWarningLimit: 700,
  },
  server: {
    port: 5173,
    proxy: {
      // Keep changeOrigin=false: the admin API validates Origin against Host,
      // and the browser talks to the Vite origin (127.0.0.1:5173).
      "/admin/api": {
        target: process.env.VITE_ADMIN_API_PROXY ?? "http://127.0.0.1:8787",
        changeOrigin: false,
      },
      "/admin/plugin-assets": {
        target: process.env.VITE_ADMIN_API_PROXY ?? "http://127.0.0.1:8787",
        changeOrigin: false,
      },
    },
  },
});
