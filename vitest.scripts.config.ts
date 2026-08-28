/**
 * Test config for the suites under `scripts/`, invoked EXPLICITLY by `pnpm run test:scripts`.
 *
 * Why it exists. `pnpm test` ends in a one-workspace-at-a-time recursive package test run, which
 * runs each package's own suite from that package's directory. Nothing ran from the repository root,
 * so the test files under `scripts/` were collected by nothing — 27 tests that had never executed.
 * `scripts/` holds release smokes and build gates, the last place a silently-uncollected test belongs.
 *
 * WHY THE FILENAME IS NOT `vitest.config.ts`, WHICH IS THE WHOLE POINT OF THIS FILE. It was, briefly,
 * and that broke far more than it fixed: vitest walks UP from the working directory for a config, so
 * a root `vitest.config.ts` is inherited by every package that does not define its own. With
 * `include: ["scripts/**"]` inherited, `pnpm --filter <pkg> run test` answered "No test files found,
 * exiting with code 0" for actions, adapters-cut, adapters-html, adapters-otio, adapters-script,
 * analysis-tracking, compositing-keying and sdk. Eight packages' suites stopped running and the
 * ladder went green over them — a worse instance of the exact defect this file was added to fix.
 *
 * A non-discoverable name plus an explicit `--config` cannot do that. The scripts suites are opted
 * INTO, and no package can be opted out by accident.
 *
 * Primary caller: `pnpm run test:scripts`, chained into `pnpm test`.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["scripts/**/*.test.ts"],
    // The same per-user job-store redirection every package suite uses: rendering records live jobs
    // under $XDG_RUNTIME_DIR/shellx-motion, so without this a run leaves its jobs in the developer's
    // own `shellx-motion job list`.
    setupFiles: ["./scripts/vitest-setup-job-stores.ts"]
  }
});
