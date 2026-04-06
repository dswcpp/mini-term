import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const host = process.env.TAURI_DEV_HOST;

function matchesAny(id: string, patterns: string[]) {
  return patterns.some((pattern) => id.includes(pattern));
}

function getManualChunk(id: string) {
  const normalizedId = id.replace(/\\/g, "/");
  if (!normalizedId.includes("/node_modules/")) {
    return undefined;
  }

  if (
    matchesAny(normalizedId, [
      "/node_modules/react/",
      "/node_modules/react-dom/",
      "/node_modules/scheduler/",
    ])
  ) {
    return "vendor-react";
  }

  if (normalizedId.includes("/node_modules/@tauri-apps/")) {
    return "vendor-tauri";
  }

  if (
    matchesAny(normalizedId, [
      "/node_modules/@xterm/",
      "/node_modules/xterm/",
    ])
  ) {
    return "vendor-xterm";
  }

  if (normalizedId.includes("/node_modules/allotment/")) {
    return "vendor-layout";
  }

  return undefined;
}

export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    // Main-path bundles are now well below 500 kB. The remaining larger chunks
    // are feature-isolated lazy bundles such as Mermaid/Shiki diagram or
    // language packs, so we raise the warning threshold to avoid noisy false
    // positives during normal builds.
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks: getManualChunk,
      },
    },
  },
}));
