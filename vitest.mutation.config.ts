import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vitest/config";

// Config for `pnpm mutation` (stryker.config.json); it covers only the kernel tests, matching `mutate`.
process.env.TZ = "UTC";

/**
 * @stryker-mutator/vitest-runner 10 runs each mutant against only the tests covering it, via a
 * `testNamePattern` built from suite and test names joined by " ". Vitest 5 matches the pattern
 * against `fullTestName`, which joins them with " > ", so every test inside a `describe` was skipped
 * and its mutants "survived" with zero tests run. Accept either separator wherever one may occur;
 * at worst a mutant runs a few extra tests.
 */
function strykerTestNamePattern(): Plugin {
	return {
		name: "dawnskill:stryker-test-name-pattern",
		configureVitest({ project }) {
			let pattern = project.config.testNamePattern;
			Object.defineProperty(project.config, "testNamePattern", {
				configurable: true,
				enumerable: true,
				get: () => pattern,
				set: (value: RegExp | undefined) => {
					pattern = value && new RegExp(value.source.replaceAll(/ > | /g, "(?: > | )"), value.flags);
				},
			});
		},
	};
}

export default defineConfig({
	plugins: [strykerTestNamePattern()],
	test: {
		environment: "node",
		include: ["packages/core/src/**/*.test.ts"],
		setupFiles: [fileURLToPath(new URL("./test/setup.ts", import.meta.url))],
	},
});
