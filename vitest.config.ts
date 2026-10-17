import { defineConfig } from 'vitest/config';

// Unit tests: pure logic next to the code (no database).
export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['src/**/*.spec.ts'],
  },
});
