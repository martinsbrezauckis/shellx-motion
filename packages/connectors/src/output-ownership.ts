/**
 * One output-ownership rule for every connector.
 *
 * Role: a connector's `--out` is caller-supplied, and each connector writes several whole
 * directories under it (`package/`, `render/`, `preview/`, `receipts/`, `artifacts/`, `frames/…`).
 * Only `template-to-cut` guarded anything, and only its `package/`; the other five wrote straight
 * over whatever was there and still reported `ok: true` (the output-ownership invariant — reproduced by a caller's own
 * `<out>/package/manifest.json` being replaced by `script-to-cut`). The class of the defect is "a
 * write whose blast radius is chosen by a caller-supplied path", so the fix has to be one shared
 * rule applied at every connector rather than a sixth bespoke check.
 *
 * Policy (delegated to `@shellx-motion/core`'s guard, identical to the CLI's `--out` policy):
 *   - a directory Motion owns wholesale must be absent or empty, else refuse and write nothing;
 *   - `force` (the CLI's `--force`) restores the destructive behavior the caller asked for;
 *   - the non-forced check is READ-ONLY across every declared destination before any of them is
 *     prepared, so a refusal on the fourth destination cannot leave the first three behind;
 *   - after admission, every directory is recreated through the topology-bound directory guard and
 *     every root file is cleared through the no-follow file guard. `--force` is therefore never a
 *     reason to leave an owned sibling symlink for a later raw writer to follow.
 *
 * Deliberately NOT guarded: `<out>` itself. Callers routinely keep the connector's INPUT next to
 * its output (`--out .` with the frame-selection JSON in it), so an emptiness rule on the root
 * would be a wall rather than a rail, while every directory Motion actually recreates is covered.
 *
 * Dependencies: `@shellx-motion/core` (`assertOutputDirGuard`, `prepareOutputDir`,
 * `prepareOutputFile`, `refuseUnsafeOutputDirReuse`, `MotionOutputGuardError`).
 * Primary callers: every `run*Connector` entry point in this package.
 */
import { MotionOutputGuardError, assertOutputDirGuard, prepareOutputDir, prepareOutputFile, refuseUnsafeOutputDirReuse } from "@shellx-motion/core";

export interface ConnectorOutputOwnershipInput {
  /**
   * Directory Motion recreates wholesale and therefore prepares: refused when it holds caller data,
   * wiped when `force` is set. Connectors copy or write a whole Motion package into this one.
   */
  packageDir?: string;
  /** Other directories under `<out>` this connector recreates wholesale before writing into them. */
  ownedDirs: string[];
  /**
   * Files this connector writes at the ROOT of `<out>` (the Cut import plan, the connector receipt).
   * Checked here rather than where they are written, at the end of a run: a refusal that arrives
   * after the render is a refusal that already cost the caller the work.
   */
  ownedFiles?: string[];
  /** The caller passed `--force`. */
  force: boolean;
}

/**
 * Refuse before a connector writes anything if it would overwrite a caller's files.
 *
 * @param input.packageDir Prepared (and, with `force`, wiped) after all checks pass.
 * @param input.ownedDirs Prepared as empty Motion-owned directories after read-only admission.
 * @param input.ownedFiles Read-only checked without force, or unlinked as the exact leaf with force.
 * @param input.force Caller opted into overwriting.
 * @throws MotionOutputGuardError with the code and path the caller can act on. Side effects on the
 *         accepted path: every declared directory exists and is empty; declared files are absent.
 *         The caller must use exclusive no-follow publication for files it writes later. None on the
 *         non-forced refusal path.
 */
export async function assertConnectorOutputOwnership(input: ConnectorOutputOwnershipInput): Promise<void> {
  const ownedDirectories = [
    ...(input.packageDir ? [input.packageDir] : []),
    ...input.ownedDirs
  ];
  if (!input.force) {
    for (const path of ownedDirectories) {
      const refusal = await refuseUnsafeOutputDirReuse(path);
      if (refusal) throw new MotionOutputGuardError(refusal.code, refusal.message, refusal.path);
    }
    for (const path of input.ownedFiles ?? []) {
      // `force: false` makes this read-only: prepareOutputFile only unlinks on the forced path.
      assertOutputDirGuard(await prepareOutputFile(path, { force: false }));
    }
  }
  for (const path of ownedDirectories) assertOutputDirGuard(await prepareOutputDir(path, { force: input.force }));
  for (const path of input.ownedFiles ?? []) assertOutputDirGuard(await prepareOutputFile(path, { force: input.force }));
}
