/**
 * Explicit root config for portable tests under scripts/public.
 * Package suites use their own configs; this file is selected only by test:scripts.
 */
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["scripts/public/**/*.test.ts"],
    // Catalog fixtures perform bounded filesystem work, like the package suites.
    testTimeout: 45_000,
    hookTimeout: 45_000,
    // Ignore nested worktrees when collecting this checkout's tests.
    exclude: [...configDefaults.exclude, ".worktrees/**"],
    // The same per-user job-store redirection every package suite uses: rendering records live jobs
    // under $XDG_RUNTIME_DIR/shellx-motion, so without this a run leaves its jobs in the developer's
    // own `shellx-motion job list`.
    setupFiles: ["./scripts/public/vitest-setup-job-stores.ts"]
  }
});
