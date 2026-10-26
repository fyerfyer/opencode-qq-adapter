import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));
const core = fileURLToPath(new URL("../../webui/src", import.meta.url));

export default defineConfig({
  root,
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": core,
      "@rp": root,
    },
    dedupe: ["react", "react-dom"],
  },
  build: {
    outDir: fileURLToPath(new URL("../ui", import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
  },
});
