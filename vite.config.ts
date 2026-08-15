import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import { singleHtml } from "./build/single-html-plugin.ts";

export default defineConfig({
  base: "./",
  publicDir: false,
  plugins: [react(), singleHtml()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  build: {
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    cssCodeSplit: false,
    modulePreload: { polyfill: false },
    target: "es2022",
    rollupOptions: {
      output: {
        codeSplitting: false,
      },
    },
  },
});
