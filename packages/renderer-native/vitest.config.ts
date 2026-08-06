/**
 * vitest.config.ts — renderer-native package test config.
 *
 * `setupFiles` redirects Motion's per-user job stores into a temp directory for the duration of the
 * run. Rendering records live and finished jobs under `$XDG_RUNTIME_DIR/shellx-motion` by design —
 * that is how a second process answers "what is my render doing" — so without this a test suite
 * leaves its jobs in the developer's own `motion job list`, and parallel test files can see each
 * other's work. See scripts/vitest-setup-job-stores.ts.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["../../scripts/vitest-setup-job-stores.ts"]
  }
});
