import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Resolve internal @archer/* packages to their TypeScript source so tests run
// without a prior build (their package exports point the runtime entry at dist,
// and CI runs tests before build). Vite maps the NodeNext .js specifiers to .ts.
const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@archer/db": src("./packages/db/src/index.ts"),
      "@archer/api": src("./services/api/src/app.ts"),
    },
  },
  test: {
    include: ["{apps,services,packages}/**/src/**/*.test.ts"],
    passWithNoTests: true,
  },
});
