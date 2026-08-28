interface ScriptedFrameAdmission {
  body?: string;
  caption?: string;
  assetRefs: readonly unknown[];
  sourceRefs: readonly unknown[];
  tags: readonly unknown[];
  effects: readonly ScriptedFrameEffectAdmission[];
}

interface ScriptedFrameEffectAdmission {
  type: "rain" | "signalPulse" | "cameraPush" | "particleField" | "scanSweep";
  intensity?: number;
}

const MAX_EFFECTS_PER_FRAME = 12;
const MAX_TOTAL_EFFECTS = 1_024;
const MAX_ASSET_REFS_PER_FRAME = 32;
const MAX_TOTAL_ASSET_REFS = 2_048;
const MAX_SOURCE_REFS_PER_FRAME = 24;
const MAX_TOTAL_SOURCE_REFS = 2_048;
const MAX_TAGS_PER_FRAME = 16;
const MAX_TOTAL_TAGS = 1_024;
const MAX_GENERATED_LAYERS_PER_FRAME = 128;
const MAX_TOTAL_GENERATED_LAYERS = 8_192;
const MAX_GENERATED_KEYFRAMES_PER_FRAME = 1_024;
const MAX_TOTAL_GENERATED_KEYFRAMES = 65_536;
const RAIN_KEYFRAMES_PER_LAYER = 6;
const PARTICLE_KEYFRAMES_PER_LAYER = 11;
const SCAN_SWEEP_KEYFRAMES_PER_LAYER = 6;
const SIGNAL_PULSE_KEYFRAMES = 6;
const CAMERA_PUSH_KEYFRAMES_PER_TARGET = 6;

const MAX_COLLECTION_ENTRIES = {
  effects: MAX_EFFECTS_PER_FRAME,
  assetRefs: MAX_ASSET_REFS_PER_FRAME,
  sourceRefs: MAX_SOURCE_REFS_PER_FRAME,
  tags: MAX_TAGS_PER_FRAME,
} as const;

export function assertScriptedVideoArrayEntryLimit(
  value: readonly unknown[],
  path: string,
  collection: keyof typeof MAX_COLLECTION_ENTRIES,
): void {
  const maxEntries = MAX_COLLECTION_ENTRIES[collection];
  if (value.length > maxEntries) throw new Error(`${path} supports at most ${maxEntries} entries.`);
}

export function assertScriptedVideoMetadataAdmission(frames: readonly ScriptedFrameAdmission[]): void {
  assertScriptedVideoMetadataBounds(frames);
}

export function assertScriptedVideoGeneratedWork(frames: readonly ScriptedFrameAdmission[]): void {
  reserveProjectedScriptedVideoWork(frames);
}

/**
 * Metadata is retained in scenes, manifests, and receipts. Bound it while every
 * collection is still small enough to inspect without flattening or serializing it.
 */
function assertScriptedVideoMetadataBounds(frames: readonly ScriptedFrameAdmission[]): void {
  let effects = 0;
  let assetRefs = 0;
  let sourceRefs = 0;
  let tags = 0;
  for (const frame of frames) {
    effects += frame.effects.length;
    assetRefs += frame.assetRefs.length;
    sourceRefs += frame.sourceRefs.length;
    tags += frame.tags.length;
    assertAggregateLimit(effects, "effects", MAX_TOTAL_EFFECTS);
    assertAggregateLimit(assetRefs, "asset references", MAX_TOTAL_ASSET_REFS);
    assertAggregateLimit(sourceRefs, "source references", MAX_TOTAL_SOURCE_REFS);
    assertAggregateLimit(tags, "tags", MAX_TOTAL_TAGS);
  }
}

/**
 * Compute every effect-owned layer and keyframe before `frameLayers` can allocate
 * them. Rain, particles, and scans are the only effects that add layers; pulse
 * and camera effects add keyframes to the fixed frame layout.
 */
function reserveProjectedScriptedVideoWork(frames: readonly ScriptedFrameAdmission[]): void {
  let generatedLayers = 0;
  let generatedKeyframes = 0;
  for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
    const projected = projectFrameGeneratedWork(frames[frameIndex]);
    if (projected.layers > MAX_GENERATED_LAYERS_PER_FRAME) {
      throw new Error(`frames[${frameIndex}] projects ${projected.layers} generated layers; supports at most ${MAX_GENERATED_LAYERS_PER_FRAME}.`);
    }
    if (projected.keyframes > MAX_GENERATED_KEYFRAMES_PER_FRAME) {
      throw new Error(`frames[${frameIndex}] projects ${projected.keyframes} generated keyframes; supports at most ${MAX_GENERATED_KEYFRAMES_PER_FRAME}.`);
    }
    generatedLayers += projected.layers;
    generatedKeyframes += projected.keyframes;
    assertAggregateLimit(generatedLayers, "generated layers", MAX_TOTAL_GENERATED_LAYERS);
    assertAggregateLimit(generatedKeyframes, "generated keyframes", MAX_TOTAL_GENERATED_KEYFRAMES);
  }
}

function projectFrameGeneratedWork(frame: ScriptedFrameAdmission): { layers: number; keyframes: number } {
  let layers = 0;
  let keyframes = 0;
  for (const effect of frame.effects) {
    if (effect.type === "rain") {
      const count = effect.intensity ?? 16;
      layers += count;
      keyframes += count * RAIN_KEYFRAMES_PER_LAYER;
    } else if (effect.type === "particleField") {
      const count = effect.intensity ?? 12;
      layers += count;
      keyframes += count * PARTICLE_KEYFRAMES_PER_LAYER;
    } else if (effect.type === "scanSweep") {
      layers += 1;
      keyframes += SCAN_SWEEP_KEYFRAMES_PER_LAYER;
    }
  }
  if (frame.effects.some((effect) => effect.type === "signalPulse")) {
    keyframes += SIGNAL_PULSE_KEYFRAMES;
  }
  if (frame.effects.some((effect) => effect.type === "cameraPush")) {
    keyframes += (frameBaseLayerCount(frame) - 2) * CAMERA_PUSH_KEYFRAMES_PER_TARGET;
  }
  return { layers, keyframes };
}

function frameBaseLayerCount(frame: ScriptedFrameAdmission): number {
  return 6 + (frame.body ? 1 : 0) + (frame.caption ? 2 : 0);
}

function assertAggregateLimit(value: number, label: string, max: number): void {
  if (value > max) throw new Error(`Scripted video supports at most ${max} ${label} across frames.`);
}
