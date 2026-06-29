import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"]
    }
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules")) {
            if (id.includes("@xyflow")) {
              return "xyflow";
            }
            if (id.includes("codemirror") || id.includes("@codemirror") || id.includes("@uiw/react-codemirror")) {
              return "codemirror";
            }
            if (id.includes("highlight.js")) {
              return "highlightjs";
            }
            if (id.includes("marked")) {
              return "marked";
            }
            return "vendor";
          }
        }
      }
    }
  },
  test: {
    environment: "happy-dom",
    globals: true,
    pool: "threads",
    poolOptions: {
      threads: {
        minThreads: 1,
        maxThreads: 4
      }
    },
    include: ["tests/**/*.test.{ts,tsx}", "src/**/*.test.{ts,tsx}"],
    exclude: ["**/node_modules/**", "**/dist/**"]
  }
});
