import { defineConfig } from "vitest/config";

// M37: evals run real models: only on demand (npm run eval), one file at a time
export default defineConfig({
	test: {
		include: ["evals/**/*.eval.ts"],
		testTimeout: 600_000,
		hookTimeout: 60_000,
		fileParallelism: false,
		reporters: ["vitest-evals/reporter"],
	},
});
