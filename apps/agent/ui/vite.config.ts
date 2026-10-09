import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The agent's local API serves this build's dist/ directly from disk (see
// staticAssets.ts) -- no CDN, no absolute-origin asset URLs, fully offline.
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "dist",
    assetsDir: "assets",
  },
});
