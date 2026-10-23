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
    emptyOutDir: true,
    sourcemap: false,
    // The admin UI is local-only and loaded once per session; keep the build
    // simple instead of introducing fragile manual vendor chunks.
    chunkSizeWarningLimit: 700,
  },
  server: {
    port: 5173,
    proxy: {
      "/admin/api": "http://127.0.0.1:8787",
    },
  },
});
