/**
 * vitest.config.ts — sdk package test config.
 *
 * WHY THIS FILE EXISTS . This package had no config of its own, so `vitest` walked up
 * and used the repository-root `vitest.config.ts`, whose `include` is `scripts/**` by design. The
 * result: `pnpm --filter @shellx-motion/sdk run test` reported "No test files found, exiting with
 * code 0" and every one of this package's 18 suites — the local render/receipt/attestation
 * behaviour — was silently collected by nothing while the ladder reported green. That is the exact
 * failure the root config's own header warns about, one directory over.
 *
 * A per-package config restores the default `include` for this package and cannot shadow anything
 * else, matching every other package that carries one.
 *
 * `setupFiles` redirects Motion's per-user job stores into a temp directory for the duration of the
 * run. Rendering records live and finished jobs under `$XDG_RUNTIME_DIR/shellx-motion` by design —
 * that is how a second process answers "what is my render doing" — so without this a test suite
 * leaves its jobs in the developer's own `motion job list`, and parallel test files can see each
 * other's work. See scripts/vitest-setup-job-stores.ts.
 *
 * NOTE for whoever owns the test ladder: the same hole remains open for `actions`, `adapters-cut`,
 * `adapters-html`, `adapters-otio`, `adapters-script`, `analysis-tracking` and `compositing-keying`,
 * which also have no config and also collect zero tests today.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["../../scripts/vitest-setup-job-stores.ts"]
  }
});
