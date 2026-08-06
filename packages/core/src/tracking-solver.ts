import { createHash } from "node:crypto";
import {
  MAX_TRACKING_SAMPLES,
  MAX_TRACKING_REFERENCE_POINTS,
  TRACKING_ANALYSIS_SCHEMA,
  trackingSettingsSha256,
  type TrackingAnalysis,
  type TrackingAnalysisMode,
  type TrackingAnalysisSettings,
  type TrackingAnalysisSpan,
  type TrackingMatrix3,
  type TrackingSourceIdentity,
  type TrackingTransformModel,
} from "./tracking-analysis";

const SOLVER_ID = "shellx-fixed-patch-tracker";
/**
 * 2.0.0, not 1.0.0: `pyramidLevels` and `maxIterations` now steer the search. Before this version
 * they were validated and hashed while the solver ran a single fixed-radius exhaustive scan, so an
 * analysis produced by 1.0.0 and one produced here can differ for the same settings. The version
 * and `implementationSha256` are what let a caller tell those two apart.
 */
const SOLVER_VERSION = "2.0.0";
const SOLVER_IMPLEMENTATION_SHA256 = createHash("sha256").update(`${SOLVER_ID}@${SOLVER_VERSION}`).digest("hex");
const PATCH_RADIUS = 3;
/** Window half-width used once a coarser level (or a previous iteration) has supplied an estimate. */
const REFINE_RADIUS = 2;
/** Smallest level that can still hold one whole patch, so the smallest usable pyramid level. */
const MIN_PYRAMID_EXTENT = PATCH_RADIUS * 2 + 1;
const MAX_MATCH_OPERATIONS = 250_000_000;
const MAX_DECODED_LUMA_PIXELS = 200_000_000;

export interface TrackingLumaFrame {
  atMs: number;
  width: number;
  height: number;
  /** One 8-bit luma sample per pixel, row-major. */
  luma: Uint8Array;
}

/** One resolution of a luma pyramid. Level 0 aliases the caller's frame; coarser levels are owned. */
interface TrackingLumaLevel {
  width: number;
  height: number;
  luma: Uint8Array;
  /**
   * Coarse levels sample with edge replication and allow a patch centre anywhere in the level;
   * level 0 keeps the original contract that a whole patch must fit inside the frame.
   *
   * Without this a pyramid is fenced in near the frame border: halving the frame also halves the
   * usable margin, so a match that sits a legal 10 px from the edge at full resolution lands 2 px
   * from the edge at level 2 and becomes unreachable. Measured, not theorised — the planar
   * similarity fixture went from `tracked` to `lost` at `pyramidLevels: 3` for exactly this reason.
   */
  replicateBorder: boolean;
}

export interface FixedTrackingRequest {
  id: string;
  source: TrackingSourceIdentity;
  mode: TrackingAnalysisMode;
  model: TrackingTransformModel;
  reference: TrackingAnalysis["reference"];
  settings: TrackingAnalysisSettings;
  frames: TrackingLumaFrame[];
  createdAt?: string;
  signal?: AbortSignal;
}

interface PointMatch {
  source: { x: number; y: number };
  target: { x: number; y: number };
  confidence: number;
}

/**
 * Deterministic bounded CPU tracker for the first local analysis lane. It consumes decoded luma
 * frames only; media decoding remains a separately contained host concern.
 *
 * Which settings actually steer the search:
 *  - `searchRadiusPx` — how far, in full-resolution pixels, the first scan of the coarsest level
 *    looks around the reference position.
 *  - `pyramidLevels` — coarse-to-fine depth. 1 is a single exhaustive full-resolution scan (the only
 *    behaviour this solver had before v2.0.0). Each extra level halves the resolution and the search
 *    radius, so the same `searchRadiusPx` costs roughly a quarter of the candidates per level added.
 *    That is what decides whether a large radius fits `MAX_MATCH_OPERATIONS` at all. Rejected up
 *    front, by name, when the source cannot hold a patch at the coarsest level.
 *    Depth is not free accuracy: a level whose pixels are wider than the tracked feature cannot see
 *    that feature, and coarse-to-fine will then lock onto a neighbouring one. Measured on the
 *    6-point homography fixture in `tracking-solver.test.ts`, whose features are 5 px wide: depth 2
 *    tracks it to a 0.19 px residual, depth 3 mis-associates points and returns 10.88 px and a
 *    `partial` status. Choose depth from the feature scale, not from the maximum the source allows.
 *  - `maxIterations` — how many times the window may re-centre on its own best match per level.
 *    1 pins the search to one window per level; higher values walk down the SAD gradient, so a
 *    displacement beyond `searchRadiusPx` can still be found on footage that has texture leading
 *    there. Iteration stops as soon as a scan cannot beat its own centre, so the search is
 *    strictly-decreasing and always terminates.
 *  - `confidenceFloor`, `startMs` / `endMs` / `direction` — as before.
 *
 * Which setting does NOT: `deterministicSeed`. The search is exhaustive and fully ordered; it
 * consumes no randomness, so no seed can move the result. It is accepted (the schema requires it),
 * hashed into `settingsSha256` as part of the request identity, and reported as inert by
 * `unsupportedTrackingSettings` / every receipt from `createTrackingOperationReceipt`.
 *
 * @param request bounded request plus already-decoded luma frames.
 * @returns a validated `TrackingAnalysis`.
 * @throws {Error} when the request is malformed, exceeds a bound, or is cancelled through `signal`.
 */
export function solveFixedTrackingAnalysis(request: FixedTrackingRequest): TrackingAnalysis {
  validateRequest(request);
  const orderedFrames = [...request.frames]
    .filter((frame) => frame.atMs >= request.settings.startMs && frame.atMs <= request.settings.endMs)
    .filter((frame) => request.settings.direction === "both"
      || (request.settings.direction === "forward" ? frame.atMs >= request.reference.atMs : frame.atMs <= request.reference.atMs))
    .sort((left, right) => left.atMs - right.atMs);
  if (orderedFrames.length < 1 || orderedFrames.length > MAX_TRACKING_SAMPLES) {
    throw new Error(`Tracking solver requires 1..${MAX_TRACKING_SAMPLES} in-range frames.`);
  }
  const referenceFrame = orderedFrames.find((frame) => frame.atMs === request.reference.atMs);
  if (!referenceFrame) throw new Error("Tracking solver requires a frame at reference.atMs.");
  const operations = orderedFrames.length
    * request.reference.points.length
    * matchCandidateBudget(request.settings)
    * (MIN_PYRAMID_EXTENT ** 2);
  if (!Number.isSafeInteger(operations) || operations > MAX_MATCH_OPERATIONS) {
    throw new Error(`Tracking solver exceeds the ${MAX_MATCH_OPERATIONS}-operation match budget.`);
  }

  // The reference pyramid is built once and reused for every frame: the reference patch never moves.
  const referencePyramid = buildLumaPyramid(referenceFrame, request.settings.pyramidLevels);
  const samples: TrackingAnalysis["samples"] = [];
  let priorLost = false;
  for (const frame of orderedFrames) {
    if (request.signal?.aborted) throw request.signal.reason ?? new Error("Tracking analysis was cancelled.");
    const framePyramid = frame === referenceFrame ? referencePyramid : buildLumaPyramid(frame, request.settings.pyramidLevels);
    const matches = request.reference.points.map((point) => matchPoint(
      referencePyramid,
      framePyramid,
      point,
      request.settings
    ));
    const matrix = fitTrackingMatrix(request.model, matches);
    const residualErrorPx = matrix ? fitResidual(matrix, matches) : undefined;
    const confidence = matches.length === 0 ? 0 : Math.min(...matches.map((match) => match.confidence));
    const enoughMatches = matches.filter((match) => match.confidence >= request.settings.confidenceFloor * 0.5).length >= minimumMatches(request.model);
    const lost = !matrix || !enoughMatches || confidence < request.settings.confidenceFloor * 0.25;
    const lowConfidence = !lost && (
      confidence < request.settings.confidenceFloor
      || (residualErrorPx ?? Number.POSITIVE_INFINITY) > Math.max(1, request.settings.searchRadiusPx * 0.2)
    );
    if (lost) {
      samples.push({ atMs: frame.atMs, state: "lost", confidence: roundConfidence(confidence) });
      priorLost = true;
      continue;
    }
    samples.push({
      atMs: frame.atMs,
      state: priorLost ? "recovered" : lowConfidence ? "low-confidence" : "tracked",
      confidence: roundConfidence(confidence),
      residualErrorPx: round(residualErrorPx!),
      matrix: matrix!.map(round) as TrackingMatrix3,
    });
    priorLost = false;
  }

  const spans = deriveTrackingSpans(samples);
  return {
    schema: TRACKING_ANALYSIS_SCHEMA,
    id: request.id,
    source: { ...request.source },
    mode: request.mode,
    model: request.model,
    status: samples.some((sample) => sample.state === "lost" || sample.state === "low-confidence") ? "partial" : "succeeded",
    reference: structuredClone(request.reference),
    settings: { ...request.settings },
    settingsSha256: trackingSettingsSha256(request.settings),
    solver: {
      id: SOLVER_ID,
      version: SOLVER_VERSION,
      implementationSha256: SOLVER_IMPLEMENTATION_SHA256,
    },
    samples,
    spans,
    createdAt: request.createdAt ?? new Date().toISOString(),
  };
}

export function deriveTrackingSpans(samples: TrackingAnalysis["samples"]): TrackingAnalysisSpan[] {
  const spans: TrackingAnalysisSpan[] = [];
  let active: TrackingAnalysisSpan | null = null;
  for (const sample of samples) {
    if (sample.state === "tracked") {
      if (active) spans.push(active);
      active = null;
      continue;
    }
    const state = sample.state;
    if (!active || active.state !== state) {
      if (active) spans.push(active);
      active = {
        startMs: sample.atMs,
        endMs: sample.atMs,
        state,
        minConfidence: sample.confidence,
        ...(sample.residualErrorPx !== undefined ? { maxResidualErrorPx: sample.residualErrorPx } : {}),
      };
    } else {
      active.endMs = sample.atMs;
      active.minConfidence = Math.min(active.minConfidence, sample.confidence);
      if (sample.residualErrorPx !== undefined) {
        active.maxResidualErrorPx = Math.max(active.maxResidualErrorPx ?? 0, sample.residualErrorPx);
      }
    }
  }
  if (active) spans.push(active);
  return spans;
}

function validateRequest(request: FixedTrackingRequest) {
  if (!request || typeof request !== "object") throw new Error("Tracking request must be an object.");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(request.id)) throw new Error("Tracking request id must be a safe identifier.");
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(request.source.assetId)
    || !/^[a-f0-9]{64}$/.test(request.source.sha256)
    || !Number.isSafeInteger(request.source.byteLength) || request.source.byteLength < 1
    || !Number.isSafeInteger(request.source.width) || request.source.width < 1 || request.source.width > 7_680
    || !Number.isSafeInteger(request.source.height) || request.source.height < 1 || request.source.height > 7_680
    || !Number.isFinite(request.source.durationMs) || request.source.durationMs <= 0 || request.source.durationMs > 86_400_000
  ) throw new Error("Tracking request source identity is invalid or exceeds bounds.");
  if (request.mode === "point" && request.model !== "translation") throw new Error("Point tracking requires translation model.");
  if (request.mode === "planar" && !["similarity", "homography"].includes(request.model)) {
    throw new Error("Planar tracking requires similarity or homography model.");
  }
  const minimum = minimumMatches(request.model);
  if (!Array.isArray(request.reference.points) || request.reference.points.length < minimum || request.reference.points.length > MAX_TRACKING_REFERENCE_POINTS) {
    throw new Error(`${request.model} tracking requires ${minimum}..${MAX_TRACKING_REFERENCE_POINTS} reference points.`);
  }
  const settings = request.settings;
  if (
    !Number.isFinite(settings.startMs) || settings.startMs < 0
    || !Number.isFinite(settings.endMs) || settings.endMs < settings.startMs || settings.endMs > request.source.durationMs
    || !Number.isFinite(settings.stepMs) || settings.stepMs < 1 || settings.stepMs > 10_000
    || !["forward", "backward", "both"].includes(settings.direction)
    || !Number.isSafeInteger(settings.searchRadiusPx) || settings.searchRadiusPx < 1 || settings.searchRadiusPx > 512
    || !Number.isSafeInteger(settings.pyramidLevels) || settings.pyramidLevels < 1 || settings.pyramidLevels > 8
    || !Number.isSafeInteger(settings.maxIterations) || settings.maxIterations < 1 || settings.maxIterations > 1_000
    || !Number.isFinite(settings.confidenceFloor) || settings.confidenceFloor < 0 || settings.confidenceFloor > 1
    || !Number.isSafeInteger(settings.deterministicSeed) || settings.deterministicSeed < 0 || settings.deterministicSeed > 2 ** 31 - 1
  ) throw new Error("Tracking request settings are invalid or exceed bounds.");
  if (!Number.isFinite(request.reference.atMs) || request.reference.atMs < settings.startMs || request.reference.atMs > settings.endMs) {
    throw new Error("Tracking reference time must be inside the requested range.");
  }
  if (!Array.isArray(request.frames) || request.frames.length < 1 || request.frames.length > MAX_TRACKING_SAMPLES) {
    throw new Error(`Tracking frames must contain 1..${MAX_TRACKING_SAMPLES} entries.`);
  }
  const seenTimes = new Set<number>();
  let decodedPixels = 0;
  for (const frame of request.frames) {
    if (!Number.isFinite(frame.atMs) || seenTimes.has(frame.atMs)) throw new Error("Tracking frame timestamps must be finite and unique.");
    seenTimes.add(frame.atMs);
    if (!Number.isSafeInteger(frame.width) || !Number.isSafeInteger(frame.height) || frame.width < 1 || frame.height < 1) {
      throw new Error("Tracking frame dimensions must be positive integers.");
    }
    if (frame.width !== request.source.width || frame.height !== request.source.height) {
      throw new Error("Tracking frame dimensions must match source identity.");
    }
    if (!(frame.luma instanceof Uint8Array) || frame.luma.byteLength !== frame.width * frame.height) {
      throw new Error("Tracking frame luma must contain exactly one byte per pixel.");
    }
    decodedPixels += frame.width * frame.height;
    if (!Number.isSafeInteger(decodedPixels) || decodedPixels > MAX_DECODED_LUMA_PIXELS) {
      throw new Error(`Tracking frames exceed the ${MAX_DECODED_LUMA_PIXELS}-pixel decoded-luma budget.`);
    }
  }
  for (const point of request.reference.points) {
    if (
      point.x < PATCH_RADIUS || point.y < PATCH_RADIUS
      || point.x >= request.source.width - PATCH_RADIUS
      || point.y >= request.source.height - PATCH_RADIUS
    ) throw new Error("Tracking reference points must leave room for the fixed patch inside the frame.");
  }
  const supportedLevels = supportedPyramidLevels(request.source.width, request.source.height);
  if (settings.pyramidLevels > supportedLevels) {
    // Loud refusal instead of a silent clamp: a caller that asked for depth it cannot have would
    // otherwise get a quietly shallower search and never learn the number it chose was fiction.
    throw new Error(
      `Tracking pyramidLevels ${settings.pyramidLevels} is deeper than a ${request.source.width}x${request.source.height} source supports. `
      + `Every level halves the frame and the coarsest level must still hold one ${MIN_PYRAMID_EXTENT}x${MIN_PYRAMID_EXTENT} patch, `
      + `so this source supports ${supportedLevels}. Use pyramidLevels ${supportedLevels} or fewer.`
    );
  }
}

/**
 * Deepest pyramid a source of this size can carry: every level halves the frame, and the coarsest
 * level must still be at least one patch wide and tall.
 *
 * Reference-point margins deliberately do NOT constrain this — coarse levels sample with edge
 * replication, so a point near the border stays reachable there.
 *
 * @param width  source width in pixels.
 * @param height source height in pixels.
 * @returns level count including level 0; never below 1.
 */
function supportedPyramidLevels(width: number, height: number): number {
  let levels = 1;
  while (
    Math.floor(width / 2 ** levels) >= MIN_PYRAMID_EXTENT
    && Math.floor(height / 2 ** levels) >= MIN_PYRAMID_EXTENT
  ) levels += 1;
  return levels;
}

/**
 * Worst-case candidate positions evaluated for one point in one frame.
 *
 * Upper bound, not an estimate: every window is clamped to the frame, so real work is only ever
 * lower. Shaped exactly like the search below — one full-width scan at the coarsest level, then a
 * refine-sized window for every remaining iteration at every level.
 *
 * @param settings requested settings (only `searchRadiusPx`, `pyramidLevels`, `maxIterations` matter).
 * @returns candidate count per point per frame.
 */
function matchCandidateBudget(settings: TrackingAnalysisSettings): number {
  const coarseRadius = coarseSearchRadius(settings);
  const refineScans = settings.pyramidLevels * settings.maxIterations - 1;
  return (coarseRadius * 2 + 1) ** 2 + refineScans * ((REFINE_RADIUS * 2 + 1) ** 2);
}

/** Search half-width, in coarsest-level pixels, that still covers `searchRadiusPx` full-res pixels. */
function coarseSearchRadius(settings: TrackingAnalysisSettings): number {
  return Math.max(1, Math.ceil(settings.searchRadiusPx / 2 ** (settings.pyramidLevels - 1)));
}

/**
 * Build a 2x box-averaged luma pyramid. Level 0 aliases the caller's buffer (never written to);
 * every coarser level is a new `Uint8Array` of a quarter the pixels, so the whole pyramid costs
 * under a third of the frame on top of the frame itself.
 *
 * Integer arithmetic with round-half-up on purpose: no float, no `Math` transcendental, so the
 * pyramid is bit-identical on every host.
 *
 * @param frame  decoded luma frame.
 * @param levels number of levels including level 0; validated against the frame beforehand.
 * @returns levels ordered finest (index 0) to coarsest.
 */
function buildLumaPyramid(frame: TrackingLumaFrame, levels: number): TrackingLumaLevel[] {
  const pyramid: TrackingLumaLevel[] = [{ width: frame.width, height: frame.height, luma: frame.luma, replicateBorder: false }];
  for (let level = 1; level < levels; level += 1) {
    const source = pyramid[level - 1];
    const width = Math.floor(source.width / 2);
    const height = Math.floor(source.height / 2);
    const luma = new Uint8Array(width * height);
    for (let y = 0; y < height; y += 1) {
      const topRow = y * 2 * source.width;
      const bottomRow = (y * 2 + 1) * source.width;
      for (let x = 0; x < width; x += 1) {
        const left = x * 2;
        luma[y * width + x] = (
          source.luma[topRow + left] + source.luma[topRow + left + 1]
          + source.luma[bottomRow + left] + source.luma[bottomRow + left + 1] + 2
        ) >> 2;
      }
    }
    pyramid.push({ width, height, luma, replicateBorder: true });
  }
  return pyramid;
}

/**
 * Coarse-to-fine, iteratively re-centred patch match for one reference point.
 *
 * Walks the pyramid from the coarsest level down. The first scan of the coarsest level covers the
 * whole requested radius; every later scan is a `REFINE_RADIUS` window around the current estimate.
 * A scan that cannot beat the score at its own centre ends the iteration for that level, so the
 * best score strictly decreases across iterations and the loop always terminates — no cycles, no
 * tie-break ambiguity, no dependence on scan order for the final position.
 *
 * @param referencePyramid pyramid of the reference frame.
 * @param framePyramid     pyramid of the frame being matched.
 * @param point            reference point in full-resolution pixels.
 * @param settings         requested settings; `searchRadiusPx`, `pyramidLevels`, `maxIterations`.
 * @returns the matched position plus a confidence combining patch similarity and how much the best
 *          position beat the runner-up in the final full-resolution window.
 */
function matchPoint(
  referencePyramid: TrackingLumaLevel[],
  framePyramid: TrackingLumaLevel[],
  point: { x: number; y: number },
  settings: TrackingAnalysisSettings
): PointMatch {
  const sourceX = Math.round(point.x);
  const sourceY = Math.round(point.y);
  const coarsest = referencePyramid.length - 1;
  let targetX = sourceX >> coarsest;
  let targetY = sourceY >> coarsest;
  let best = Number.POSITIVE_INFINITY;
  let second = Number.POSITIVE_INFINITY;

  for (let level = coarsest; level >= 0; level -= 1) {
    const reference = referencePyramid[level];
    const frame = framePyramid[level];
    // The reference patch is anchored at the point scaled into this level; `>>` matches the way
    // buildLumaPyramid maps pixel x at level k-1 onto x/2 at level k.
    const referenceX = sourceX >> level;
    const referenceY = sourceY >> level;
    let radius = level === coarsest ? coarseSearchRadius(settings) : REFINE_RADIUS;
    for (let iteration = 0; iteration < settings.maxIterations; iteration += 1) {
      const scan = scanWindow(reference, referenceX, referenceY, frame, targetX, targetY, radius);
      best = scan.best;
      second = scan.second;
      radius = REFINE_RADIUS;
      // Converged when the window centre already holds the best score at this level.
      const converged = scan.x === scan.centreX && scan.y === scan.centreY;
      targetX = scan.x;
      targetY = scan.y;
      if (converged) break;
    }
    // Propagate the estimate into the next finer level; the refine window absorbs the ±1 pixel the
    // halving lost.
    if (level > 0) {
      targetX *= 2;
      targetY *= 2;
    }
  }

  const uniqueness = Number.isFinite(second) ? Math.max(0, (second - best) / Math.max(1, second)) : 0;
  const maxSad = (MIN_PYRAMID_EXTENT ** 2) * 255;
  const similarity = Math.max(0, 1 - best / maxSad);
  return {
    source: { x: point.x, y: point.y },
    target: { x: targetX, y: targetY },
    confidence: Math.max(0, Math.min(1, Math.sqrt(uniqueness * similarity))),
  };
}

/**
 * One exhaustive scan of a square window at a single pyramid level.
 *
 * The window centre is clamped into the region where a whole patch fits, then evaluated FIRST and
 * kept on ties, so a tied neighbour can never displace the incumbent and start an oscillation.
 *
 * @returns the winning position, the clamped centre it was measured against, and the best and
 *          runner-up scores (the runner-up feeds the uniqueness half of confidence).
 */
function scanWindow(
  reference: TrackingLumaLevel,
  referenceX: number,
  referenceY: number,
  frame: TrackingLumaLevel,
  centreX: number,
  centreY: number,
  radius: number
): { x: number; y: number; centreX: number; centreY: number; best: number; second: number } {
  // Level 0 keeps the original rule that a whole patch must fit inside the frame; coarse levels
  // replicate their edge pixels instead, so the search is not fenced away from the border.
  const lowest = frame.replicateBorder ? 0 : PATCH_RADIUS;
  const highestX = frame.replicateBorder ? frame.width - 1 : frame.width - PATCH_RADIUS - 1;
  const highestY = frame.replicateBorder ? frame.height - 1 : frame.height - PATCH_RADIUS - 1;
  const clampedCentreX = clamp(centreX, lowest, highestX);
  const clampedCentreY = clamp(centreY, lowest, highestY);
  const minX = Math.max(lowest, clampedCentreX - radius);
  const maxX = Math.min(highestX, clampedCentreX + radius);
  const minY = Math.max(lowest, clampedCentreY - radius);
  const maxY = Math.min(highestY, clampedCentreY + radius);
  let best = patchSad(reference, referenceX, referenceY, frame, clampedCentreX, clampedCentreY);
  let second = Number.POSITIVE_INFINITY;
  let bestX = clampedCentreX;
  let bestY = clampedCentreY;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      if (x === clampedCentreX && y === clampedCentreY) continue;
      const score = patchSad(reference, referenceX, referenceY, frame, x, y);
      if (score < best) {
        second = best;
        best = score;
        bestX = x;
        bestY = y;
      } else if (score < second) {
        second = score;
      }
    }
  }
  return { x: bestX, y: bestY, centreX: clampedCentreX, centreY: clampedCentreY, best, second };
}

/**
 * Sum of absolute differences between the reference patch and a candidate patch.
 *
 * On level 0 both patches are guaranteed to lie wholly inside the frame, so the hot loop indexes
 * directly — byte-identical to the pre-pyramid solver. On coarse levels a patch may hang over the
 * edge, and both sides sample with edge replication so the comparison stays symmetric.
 */
function patchSad(reference: TrackingLumaLevel, sourceX: number, sourceY: number, frame: TrackingLumaLevel, targetX: number, targetY: number): number {
  let total = 0;
  if (reference.replicateBorder || frame.replicateBorder) {
    for (let offsetY = -PATCH_RADIUS; offsetY <= PATCH_RADIUS; offsetY += 1) {
      for (let offsetX = -PATCH_RADIUS; offsetX <= PATCH_RADIUS; offsetX += 1) {
        total += Math.abs(
          sampleReplicated(reference, sourceX + offsetX, sourceY + offsetY)
          - sampleReplicated(frame, targetX + offsetX, targetY + offsetY)
        );
      }
    }
    return total;
  }
  for (let offsetY = -PATCH_RADIUS; offsetY <= PATCH_RADIUS; offsetY += 1) {
    const sourceRow = (sourceY + offsetY) * reference.width;
    const targetRow = (targetY + offsetY) * frame.width;
    for (let offsetX = -PATCH_RADIUS; offsetX <= PATCH_RADIUS; offsetX += 1) {
      total += Math.abs(reference.luma[sourceRow + sourceX + offsetX] - frame.luma[targetRow + targetX + offsetX]);
    }
  }
  return total;
}

/** Read one luma sample, repeating the edge pixel for coordinates outside the level. */
function sampleReplicated(level: TrackingLumaLevel, x: number, y: number): number {
  return level.luma[clamp(y, 0, level.height - 1) * level.width + clamp(x, 0, level.width - 1)];
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function fitTrackingMatrix(model: TrackingTransformModel, matches: PointMatch[]): TrackingMatrix3 | null {
  const usable = matches.filter((match) => match.confidence > 0);
  if (usable.length < minimumMatches(model)) return null;
  if (model === "translation") {
    const dx = usable.reduce((sum, match) => sum + match.target.x - match.source.x, 0) / usable.length;
    const dy = usable.reduce((sum, match) => sum + match.target.y - match.source.y, 0) / usable.length;
    return [1, 0, dx, 0, 1, dy, 0, 0, 1];
  }
  if (model === "similarity") return fitSimilarity(usable);
  return fitHomography(usable);
}

function fitSimilarity(matches: PointMatch[]): TrackingMatrix3 | null {
  const sourceCenter = centroid(matches.map((match) => match.source));
  const targetCenter = centroid(matches.map((match) => match.target));
  let dot = 0;
  let cross = 0;
  let denominator = 0;
  for (const match of matches) {
    const px = match.source.x - sourceCenter.x;
    const py = match.source.y - sourceCenter.y;
    const qx = match.target.x - targetCenter.x;
    const qy = match.target.y - targetCenter.y;
    dot += px * qx + py * qy;
    cross += px * qy - py * qx;
    denominator += px * px + py * py;
  }
  if (denominator < 1e-9) return null;
  const a = dot / denominator;
  const b = cross / denominator;
  const tx = targetCenter.x - a * sourceCenter.x + b * sourceCenter.y;
  const ty = targetCenter.y - b * sourceCenter.x - a * sourceCenter.y;
  return [a, -b, tx, b, a, ty, 0, 0, 1];
}

function fitHomography(matches: PointMatch[]): TrackingMatrix3 | null {
  const normal = Array.from({ length: 8 }, () => Array(8).fill(0) as number[]);
  const target = Array(8).fill(0) as number[];
  const addEquation = (row: number[], value: number) => {
    for (let column = 0; column < 8; column += 1) {
      target[column] += row[column] * value;
      for (let inner = 0; inner < 8; inner += 1) normal[column][inner] += row[column] * row[inner];
    }
  };
  for (const match of matches) {
    const { x, y } = match.source;
    const { x: u, y: v } = match.target;
    addEquation([x, y, 1, 0, 0, 0, -u * x, -u * y], u);
    addEquation([0, 0, 0, x, y, 1, -v * x, -v * y], v);
  }
  const solved = solveLinearSystem(normal, target);
  return solved ? [...solved, 1] as TrackingMatrix3 : null;
}

function solveLinearSystem(matrix: number[][], vector: number[]): number[] | null {
  const rows = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < rows.length; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < rows.length; row += 1) {
      if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) pivot = row;
    }
    if (Math.abs(rows[pivot][column]) < 1e-10) return null;
    [rows[column], rows[pivot]] = [rows[pivot], rows[column]];
    const divisor = rows[column][column];
    for (let index = column; index <= rows.length; index += 1) rows[column][index] /= divisor;
    for (let row = 0; row < rows.length; row += 1) {
      if (row === column) continue;
      const factor = rows[row][column];
      for (let index = column; index <= rows.length; index += 1) rows[row][index] -= factor * rows[column][index];
    }
  }
  return rows.map((row) => row[rows.length]);
}

function fitResidual(matrix: TrackingMatrix3, matches: PointMatch[]): number {
  const squared = matches.map((match) => {
    const projected = project(matrix, match.source);
    return (projected.x - match.target.x) ** 2 + (projected.y - match.target.y) ** 2;
  });
  return Math.sqrt(squared.reduce((sum, value) => sum + value, 0) / squared.length);
}

function project(matrix: TrackingMatrix3, point: { x: number; y: number }) {
  const divisor = matrix[6] * point.x + matrix[7] * point.y + matrix[8];
  return {
    x: (matrix[0] * point.x + matrix[1] * point.y + matrix[2]) / divisor,
    y: (matrix[3] * point.x + matrix[4] * point.y + matrix[5]) / divisor,
  };
}

function centroid(points: Array<{ x: number; y: number }>) {
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
  };
}

function minimumMatches(model: TrackingTransformModel): number {
  return model === "translation" ? 1 : model === "similarity" ? 2 : 4;
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function roundConfidence(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 1_000_000) / 1_000_000;
}
