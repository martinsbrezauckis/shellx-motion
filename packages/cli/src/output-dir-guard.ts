/**
 * The CLI's face of the shared output guard, which lives in core.
 *
 * The policy moved to `@shellx-motion/core` because the connectors needed the same rules and could
 * not import from the CLI — and not having it there is exactly how the same destructive-output
 * defect was written a second (and third) time.
 *
 * This module adds the two CLI-shaped adapters `renderCommand` needs. They return the refusal (or
 * `null`) instead of a result object so a call site is two lines, which matters: `main.ts` is under
 * a module-size gate, and a guard that is awkward to call at the sixth site is a guard that gets
 * skipped at the seventh.
 *
 * Dependencies: `@shellx-motion/core` (`prepareFramesDir`, `prepareOutputFile`).
 * Primary callers: `packages/cli/src/main.ts` — `renderCommand`.
 */
import { prepareFramesDir, prepareOutputFile, type OutputDirGuardError } from "@shellx-motion/core";

export {
  prepareOutputDir,
  prepareFramesDir,
  prepareOutputFile,
  refuseUnsafeOutputDirReuse,
  type OutputDirGuardError,
  type OutputDirGuardErrorCode,
  type OutputDirGuardResult,
  type PrepareOutputDirOptions,
  type PrepareFramesDirOptions
} from "@shellx-motion/core";

/**
 * Prepare the encoder's frame directory, returning the refusal to hand back to the caller.
 *
 * @param path Resolved frames directory (`<frames-root>/<packageId>`).
 * @param options.force `--force` was passed.
 * @param options.callerSupplied The frames root came from `--frames-dir` or an embedder's scratch
 *        root — i.e. NOT Motion's own default `.scratch/frames`. See the core policy doc.
 * @returns `null` once the directory exists and is empty; otherwise the typed refusal, with nothing
 *          created or removed.
 */
export async function framesDirRefusal(
  path: string,
  options: { force: boolean; callerSupplied: boolean; withinRoot?: string }
): Promise<OutputDirGuardError | null> {
  const result = await prepareFramesDir(path, options);
  return result.ok ? null : result.error;
}

/** Refuse an occupied final file before preparing frames, then enforce the frame-directory guard. */
export async function materializedDeliveryRefusal(
  outputPath: string,
  framesPath: string,
  options: { force: boolean; callerSupplied: boolean; withinRoot?: string }
): Promise<OutputDirGuardError | { code: "derived_output_exists" | "derived_output_unsafe_parent"; message: string; path: string; artifact?: "media_output" } | null> {
  if (!options.force) {
    const output = await outputFileRefusal(outputPath, { force: false });
    if (output) {
      const code = output.code === "output_path_unsafe_parent" ? "derived_output_unsafe_parent" : "derived_output_exists";
      return code === "derived_output_exists"
        ? { code, path: output.path, artifact: "media_output", message: `Render media output already exists at ${output.path}; it was preserved rather than overwritten.` }
        : { ...output, code };
    }
  }
  return await framesDirRefusal(framesPath, options);
}

/**
 * Guard a single-file deliverable (`--out clip.mp4`) the same way `--out <dir>` is guarded.
 *
 * @param path Resolved output file path.
 * @param options.force `--force` was passed: unlink the existing file first.
 * @returns `null` when the path is free to write, otherwise the typed refusal.
 */
export async function outputFileRefusal(
  path: string,
  options: { force: boolean }
): Promise<OutputDirGuardError | null> {
  const result = await prepareOutputFile(path, options);
  return result.ok ? null : result.error;
}
