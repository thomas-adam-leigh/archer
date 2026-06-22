import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// A standalone Vitest config for the lib unit tests. We deliberately do NOT load
// the TanStack Start / Nitro Vite plugins here — the lib modules are framework
// agnostic, and the full app plugins aren't needed (and slow/awkward) to unit
// test pure functions. The `#/` subpath import is mapped to `src/`, and the
// client env vars are stubbed so the config accessors resolve.
export default defineConfig({
	resolve: {
		alias: {
			"#": fileURLToPath(new URL("./src", import.meta.url)),
		},
	},
	test: {
		environment: "node",
		include: ["src/**/*.test.ts"],
		env: {
			VITE_SUPABASE_URL: "https://supabase.test",
			VITE_SUPABASE_PUBLISHABLE_KEY: "pk-test",
			VITE_ARCHER_API_URL: "https://api.test",
		},
	},
});
