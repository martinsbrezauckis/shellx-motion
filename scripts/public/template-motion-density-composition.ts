/**
 * Materialize the composition-only alternate required to measure a package
 * whose decorative film grain changes every frame.  This is intentionally
 * narrow: removing arbitrary effects would turn a release gate into a second
 * renderer, whereas `filmGrain` is the documented non-composition signal.
 */
import assert from "node:assert/strict";
import { join } from "node:path";

export interface MotionDensityCompositionPaths {
  packageRoot: string;
  scratchRoot: string;
  outputPath: string;
}

/**
 * Derive every private path for the grain-stripped alternate from one stable
 * family suffix. The copied package keeps its source package id, so its final
 * output must live below a separate render directory or the CLI's sibling
 * receipt would collide with the main render's caller-owned receipt.
 */
export function motionDensityCompositionPaths(input: {
  packageDirName: string;
  proofPackagesRoot: string;
  framesRoot: string;
  rendersRoot: string;
}): MotionDensityCompositionPaths {
  const diagnosticName = `${input.packageDirName}-motion-density-composition`;
  return {
    packageRoot: join(input.proofPackagesRoot, diagnosticName),
    scratchRoot: join(input.framesRoot, diagnosticName),
    outputPath: join(input.rendersRoot, diagnosticName, `${input.packageDirName}.mp4`)
  };
}

/** Remove declared film-grain effects in place and return the number removed. */
export function stripFilmGrainEffects(motion: Record<string, unknown>): number {
  const layers = motion.layers;
  assert(Array.isArray(layers), "motion-density composition alternate needs a layers array");
  let removed = 0;
  for (const layer of layers) {
    if (!layer || typeof layer !== "object" || Array.isArray(layer)) continue;
    const effects = (layer as Record<string, unknown>).effects;
    if (!effects || typeof effects !== "object" || Array.isArray(effects)) continue;
    const effectRecord = effects as Record<string, unknown>;
    if (!Object.hasOwn(effectRecord, "filmGrain")) continue;
    delete effectRecord.filmGrain;
    removed += 1;
    if (Object.keys(effectRecord).length === 0) delete (layer as Record<string, unknown>).effects;
  }
  return removed;
}
