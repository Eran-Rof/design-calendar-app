import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
  test: {
    globals: true,
    // Default env stays `node` for fast pure-helper tests. Files
    // that mount React components opt into jsdom with the
    // `// @vitest-environment jsdom` directive at the top.
    environment: "node",
    setupFiles: ["./src/__tests__/setup.ts"],
    // `.claude/worktrees/**` holds sub-agent scratch copies of the
    // repo. Vitest's default include picks up their stale test
    // files and reports failures that have nothing to do with the
    // working tree — exclude explicitly so CI stays trustworthy.
    exclude: ["node_modules", "dist", ".idea", ".git", ".cache", ".claude/**"],
  },
})
