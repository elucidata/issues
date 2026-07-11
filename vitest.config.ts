import { defineConfig } from 'vitest/config';

// The issue-tracker core is pure and fs-free; its tests run in Node. Exports
// resolve to TS source (no build step), so vitest compiles the .ts entry
// points directly.
export default defineConfig({
	test: {
		environment: 'node',
		include: ['src/**/*.test.ts']
	}
});
