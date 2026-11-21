import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, ".claude/**"],
    globalSetup: ["tests/helpers/global-temp.ts"],
    // The global teardown may wait for a just-killed test .exe to unlock before removing its folder.
    teardownTimeout: 60_000,
  },
});
