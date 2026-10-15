import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Dates in tests must not depend on the machine; `pnpm test` also sets TZ=UTC.
process.env.TZ = "UTC";

const packagesDir = fileURLToPath(new URL("./packages/", import.meta.url));
const packages = readdirSync(packagesDir, { withFileTypes: true })
	.filter((entry) => entry.isDirectory())
	.map((entry) => entry.name);

export default defineConfig({
	test: {
		environment: "node",
		passWithNoTests: true,
		setupFiles: [fileURLToPath(new URL("./test/setup.ts", import.meta.url))],
		projects: packages.map((name) => ({
			extends: true,
			test: {
				name,
				root: `${packagesDir}${name}`,
				include: ["src/**/*.test.{ts,tsx}", "test/**/*.test.{ts,tsx}"],
			},
		})),
	},
});
