import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		// A fixture's golden project carries tests of its own, against its own dependencies.
		exclude: [...configDefaults.exclude, 'evals/**'],
	},
});
