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
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll } from "vitest";

const inheritedTempEnvironment = {
  TMPDIR: process.env.TMPDIR,
  TEMP: process.env.TEMP,
  TMP: process.env.TMP,
  SHELLX_MOTION_TEST_IPC_TMPDIR: process.env.SHELLX_MOTION_TEST_IPC_TMPDIR,
};
let privateFixtureTempRoot: string | undefined;
// macOS exposes its temporary directory through /var even though the canonical path is
// /private/var. Normalize that spelling before deciding whether the host path can safely carry
// test fixtures, so the normal macOS route stays covered when its full ancestor topology is safe.
const canonicalTempRoot = realpathSync(tmpdir());
// Keep a short, pre-run host temporary route available only to test subprocess IPC. A checkout
// worktree can be long enough for tsx's Unix-domain socket pathname to exceed the kernel limit;
// test fixtures stay under the governed root below, while explicit child-process helpers opt into
// this marker only for their compiler/control socket.
process.env.SHELLX_MOTION_TEST_IPC_TMPDIR = inheritedTempEnvironment.TMPDIR
  ?? inheritedTempEnvironment.TEMP
  ?? inheritedTempEnvironment.TMP
  ?? canonicalTempRoot;
if (process.platform === "win32") {
  // A normal user TEMP can inherit write authority from another local principal. Motion correctly
  // refuses that route, so each worker owns a private fixture root below the already admitted
  // checkout instead of weakening native DACL admission for tests. afterAll removes the whole root.
  privateFixtureTempRoot = mkdtempSync(join(realpathSync(process.cwd()), ".shellx-motion-test-temp-"));
  process.env.TEMP = privateFixtureTempRoot;
  process.env.TMP = privateFixtureTempRoot;
} else if (!hasAtomicCowAuthority(canonicalTempRoot)) {
  // A managed WSL may expose /tmp as a sticky directory owned by an unrelated mapping principal.
  // Product COW correctly refuses that route: the sticky bit does not stop its owner from deleting
  // or renaming our entries. Keep tests inside one project-owned private scratch child instead of
  // weakening output authority, and retain macOS's canonical spelling after the override.
  const projectRoot = realpathSync(join(dirname(fileURLToPath(import.meta.url)), ".."));
  const fixtureParent = join(projectRoot, ".scratch", "tests");
  mkdirSync(fixtureParent, { recursive: true, mode: 0o700 });
  privateFixtureTempRoot = mkdtempSync(join(fixtureParent, "vitest-"));
  process.env.TMPDIR = realpathSync(privateFixtureTempRoot);
} else {
  process.env.TMPDIR = canonicalTempRoot;
}

const root = mkdtempSync(join(tmpdir(), "shellx-motion-test-jobs-"));
process.env.SHELLX_MOTION_LEASE_ROOT = join(root, "leases");
process.env.SHELLX_MOTION_JOB_RECORD_ROOT = join(root, "records");

afterAll(() => {
  restoreEnvironment("TMPDIR", inheritedTempEnvironment.TMPDIR);
  restoreEnvironment("TEMP", inheritedTempEnvironment.TEMP);
  restoreEnvironment("TMP", inheritedTempEnvironment.TMP);
  restoreEnvironment("SHELLX_MOTION_TEST_IPC_TMPDIR", inheritedTempEnvironment.SHELLX_MOTION_TEST_IPC_TMPDIR);
  rmSync(root, { recursive: true, force: true });
  if (privateFixtureTempRoot) rmSync(privateFixtureTempRoot, { recursive: true, force: true });
});

function restoreEnvironment(name: "TMPDIR" | "TEMP" | "TMP" | "SHELLX_MOTION_TEST_IPC_TMPDIR", value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/**
 * Keep the runner's fixture decision aligned with Core's ordinary POSIX COW admission without
 * importing Core into its own every-package Vitest bootstrap. A source test may use the
 * checkout-scoped host anchor; an ambient temporary route must stand on its complete ancestry.
 */
function hasAtomicCowAuthority(path: string): boolean {
  if (typeof process.getuid !== "function") return true;
  const uid = process.getuid();
  let current = resolve(path);
  for (;;) {
    let facts: ReturnType<typeof lstatSync>;
    try {
      facts = lstatSync(current);
    } catch {
      return false;
    }
    if (!facts.isDirectory() || facts.isSymbolicLink()) return false;
    if (facts.uid !== uid && facts.uid !== 0) return false;
    const mode = Number(facts.mode);
    if ((mode & 0o022) !== 0 && (mode & 0o1000) === 0) return false;
    if (current === parse(current).root) return true;
    current = dirname(current);
  }
}
