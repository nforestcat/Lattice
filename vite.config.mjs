import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const testExclude = [
  "**/.claude/**", "**/node_modules/**", "**/dist/**",
  "**/.review/**", "**/.omo/**", "**/.omc/**", "**/.clone/**"
];

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
    globals: true,
    exclude: testExclude,
    pool: "threads",
    minWorkers: 1,
    maxWorkers: 4,
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          globals: true,
          exclude: [...testExclude, "tests/proposedEditApply.test.ts", "tests/contract/mockVault.contract.test.ts"],
          include: ["tests/**/*.test.ts", "src/**/*.test.ts", "tests/contextRefresh.test.tsx"]
        }
      },
      {
        test: {
          name: "dom",
          environment: "happy-dom",
          globals: true,
          exclude: [...testExclude, "tests/contextRefresh.test.tsx"],
          setupFiles: ["tests/setupDom.ts"],
          include: ["tests/**/*.test.tsx", "src/**/*.test.tsx", "tests/proposedEditApply.test.ts", "tests/contract/mockVault.contract.test.ts"]
        }
      }
    ]
  }
});
