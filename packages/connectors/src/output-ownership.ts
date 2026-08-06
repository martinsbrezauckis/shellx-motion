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
 *   - the check is READ-ONLY across all directories before any of them is created, so a refusal on
 *     the fourth directory cannot leave the first three behind.
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
  /** Other directories under `<out>` this connector writes into; checked, never pre-created. */
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
 * @param input.ownedDirs Checked read-only; existing-but-empty is fine, non-empty refuses.
 * @param input.ownedFiles Checked read-only; any existing path refuses.
 * @param input.force Caller opted into overwriting.
 * @throws MotionOutputGuardError with the code and path the caller can act on. Side effects on the
 *         accepted path: `packageDir` exists and is empty. None on the refusal path.
 */
export async function assertConnectorOutputOwnership(input: ConnectorOutputOwnershipInput): Promise<void> {
  if (!input.force) {
    for (const path of input.ownedDirs) {
      const refusal = await refuseUnsafeOutputDirReuse(path);
      if (refusal) throw new MotionOutputGuardError(refusal.code, refusal.message, refusal.path);
    }
    for (const path of input.ownedFiles ?? []) {
      // `force: false` makes this read-only: prepareOutputFile only unlinks on the forced path.
      assertOutputDirGuard(await prepareOutputFile(path, { force: false }));
    }
  }
  if (input.packageDir) {
    assertOutputDirGuard(await prepareOutputDir(input.packageDir, { force: input.force }));
  }
}
