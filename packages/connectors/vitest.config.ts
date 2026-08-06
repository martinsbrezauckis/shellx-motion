/**
 * vitest.config.ts — connectors package test config.
 *
 * The connector suites drive REAL browser frame rendering (renderMotionBrowserFrame) for multi-frame
 * and rich cinematic packages. Under the full 11-file parallel suite on WSL these renders contend for
 * CPU and legitimately approach ~4-5s each — right at Vitest's 5s default, which makes the heaviest
 * real-render tests flake intermittently. Several tests already carry inline 15-20s timeouts; this raises
 * the package default so the remaining browser-render tests get the same headroom without per-test edits.
 * A genuinely hung test still fails (at 20s), just with margin for slow-but-correct browser renders.
 *
 * This only affects timing headroom — pool, isolation, and coverage behavior stay on Vitest defaults.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 20000,
    // Keeps rendered jobs out of the developer's real runtime directory — see
    // scripts/vitest-setup-job-stores.ts.
    setupFiles: ["../../scripts/vitest-setup-job-stores.ts"]
  }
});
