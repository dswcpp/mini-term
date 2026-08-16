import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const host = process.env.TAURI_DEV_HOST;

// Claude/Codex/Trellis runtime files are written while users work inside
// Mini-Term terminals. They must not trigger Vite reloads in tauri dev.
const devWatchIgnored = [
  "**/src-tauri/**",
  "**/.agents/**",
  "**/.claude/**",
  "**/.codex/**",
  "**/.qwen/**",
  "**/.run-logs/**",
  "**/.spec-workflow/**",
  "**/.tmp-tests/**",
  "**/.trellis/**",
  "**/dist/**",
];

export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1450,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1451 } : undefined,
    watch: { ignored: devWatchIgnored },
  },
}));
