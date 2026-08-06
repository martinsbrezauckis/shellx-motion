/**
 * Keep test runs out of the developer's real runtime directory.
 *
 * Role: Motion records live jobs and finished jobs under a per-user runtime path so that a
 * *different* process can answer "what is my render doing". That is the feature working correctly,
 * and it means every test that renders writes there too. Leases are released on exit so those were
 * survivable, but terminal records are retained for seven days by design — a full suite left several
 * hundred record files in `$XDG_RUNTIME_DIR/shellx-motion`, where they would then show up in a
 * developer's own `shellx-motion job list`.
 *
 * Redirecting both stores per worker also keeps parallel test files from reading each other's jobs,
 * which would make an owner-boundary assertion pass or fail depending on what else was running.
 *
 * Wired in through `setupFiles` in each package's vitest.config.ts. Tests that want to inspect the
 * stores should still construct their own `MotionJobLeaseDirectory` / `MotionJobRegistry` against a
 * temp directory; this is a backstop for everything that does not.
 */
import { mkdtempSync } from "node:fs";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const root = mkdtempSync(join(tmpdir(), "shellx-motion-test-jobs-"));
process.env.SHELLX_MOTION_LEASE_ROOT = join(root, "leases");
process.env.SHELLX_MOTION_JOB_RECORD_ROOT = join(root, "records");

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});
