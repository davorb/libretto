import { defineConfig } from 'vitest/config'

// Only Libretto's own tests. Generated Playwright specs under examples/**/.libretto are not vitest tests.
export default defineConfig({
  test: { include: ['src/**/*.test.ts'] },
})
