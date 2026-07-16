import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL("./renderer", import.meta.url)),
  base: "./",
  server: {
    port: 5173,
    strictPort: true
  },
  build: {
    outDir: fileURLToPath(new URL("./dist", import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
    target: "chrome136"
  }
});
