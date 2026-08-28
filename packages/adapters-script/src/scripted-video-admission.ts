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

type JsonRecord = Record<string, unknown>;

const MAX_SCRIPTED_VIDEO_STRING_BYTES = 16 * 1024;
const MAX_TEMPLATE_VARIABLE_BYTES = 64 * 1024;
const MAX_TEMPLATE_VARIABLE_DEPTH = 8;
const MAX_TEMPLATE_VARIABLE_ENTRIES = 64;
const MAX_TEMPLATE_VARIABLE_NODES = 512;
const MAX_SCRIPTED_PACKAGE_JSON_STRING_BYTES = 64 * 1024;
const MAX_SCRIPTED_PACKAGE_JSON_DEPTH = 64;
const MAX_SCRIPTED_PACKAGE_JSON_NODES = 1_000_000;

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

/** Refuse retained scalar text before it can expand a package, receipt, or render layer. */
export function assertScriptedVideoString(value: string, path: string): string {
  const byteLength = Buffer.byteLength(value, "utf8");
  if (byteLength > MAX_SCRIPTED_VIDEO_STRING_BYTES) {
    throw new Error(`${path} exceeds the ${MAX_SCRIPTED_VIDEO_STRING_BYTES}-byte scripted-video string limit.`);
  }
  return value;
}

/**
 * Template variables are retained as storyboard metadata. Normalize the closed JSON subset so
 * callers cannot smuggle a huge, deep, mutable object into later receipt hashing or publication.
 */
export function normalizeScriptedTemplateVariables(value: unknown, path: string): JsonRecord {
  const state = { bytes: 0, nodes: 0, parents: [] as object[] };
  const normalized = normalizeTemplateJson(value, path, state, 0);
  if (!isPlainRecord(normalized)) throw new Error(`${path} must be an object.`);
  return normalized;
}

/**
 * Prove a Script package JSON leaf fits Core's write cap before JSON.stringify allocates the
 * complete payload. The accepted writer surface is deliberately JSON data, never callbacks,
 * custom serializers, or class instances.
 */
export function normalizeBoundedScriptedPackageJson(value: unknown, label: string, maxBytes: number): unknown {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error(`${label} JSON byte limit is invalid.`);
  const state = { bytes: 0, nodes: 0, parents: [] as object[] };
  return normalizePackageJson(value, label, state, 0, maxBytes);
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

function normalizeTemplateJson(
  value: unknown,
  path: string,
  state: { bytes: number; nodes: number; parents: object[] },
  depth: number
): unknown {
  if (depth > MAX_TEMPLATE_VARIABLE_DEPTH) {
    throw new Error(`${path} exceeds the ${MAX_TEMPLATE_VARIABLE_DEPTH}-level template.variables depth limit.`);
  }
  state.nodes += 1;
  if (state.nodes > MAX_TEMPLATE_VARIABLE_NODES) {
    throw new Error(`${path} exceeds the ${MAX_TEMPLATE_VARIABLE_NODES}-node template.variables limit.`);
  }
  if (value === null) {
    reserveTemplateBytes(4, path, state);
    return value;
  }
  if (typeof value === "boolean") {
    reserveTemplateBytes(value ? 4 : 5, path, state);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} must contain finite JSON numbers.`);
    reserveTemplateBytes(Buffer.byteLength(JSON.stringify(value), "utf8"), path, state);
    return value;
  }
  if (typeof value === "string") {
    assertScriptedVideoString(value, path);
    reserveTemplateBytes(Buffer.byteLength(JSON.stringify(value), "utf8"), path, state);
    return value;
  }
  if (typeof value !== "object") throw new Error(`${path} must contain JSON values only.`);
  if (state.parents.includes(value)) throw new Error(`${path} cannot contain a cycle.`);
  state.parents.push(value);
  if (Array.isArray(value)) {
    try {
      if (value.length > MAX_TEMPLATE_VARIABLE_ENTRIES) {
        throw new Error(`${path} supports at most ${MAX_TEMPLATE_VARIABLE_ENTRIES} template.variables entries.`);
      }
      return value.map((entry, index) => normalizeTemplateJson(entry, `${path}[${index}]`, state, depth + 1));
    } finally {
      state.parents.pop();
    }
  }
  try {
    if (!isPlainRecord(value)) throw new Error(`${path} must contain plain JSON records only.`);
    const entries = Object.entries(value);
    if (entries.length > MAX_TEMPLATE_VARIABLE_ENTRIES) {
      throw new Error(`${path} supports at most ${MAX_TEMPLATE_VARIABLE_ENTRIES} template.variables entries.`);
    }
    const result: JsonRecord = {};
    for (const [key, entry] of entries) {
      assertScriptedVideoString(key, `${path} key`);
      reserveTemplateBytes(Buffer.byteLength(JSON.stringify(key), "utf8"), path, state);
      result[key] = normalizeTemplateJson(entry, `${path}.${key}`, state, depth + 1);
    }
    return result;
  } finally {
    state.parents.pop();
  }
}

function reserveTemplateBytes(bytes: number, path: string, state: { bytes: number }): void {
  state.bytes += bytes;
  if (state.bytes > MAX_TEMPLATE_VARIABLE_BYTES) {
    throw new Error(`${path} exceeds the ${MAX_TEMPLATE_VARIABLE_BYTES}-byte template.variables limit.`);
  }
}

function normalizePackageJson(
  value: unknown,
  path: string,
  state: { bytes: number; nodes: number; parents: object[] },
  depth: number,
  maxBytes: number
): unknown {
  if (depth > MAX_SCRIPTED_PACKAGE_JSON_DEPTH) {
    throw new Error(`${labelAt(path)} exceeds the ${MAX_SCRIPTED_PACKAGE_JSON_DEPTH}-level Script package JSON depth limit.`);
  }
  state.nodes += 1;
  if (state.nodes > MAX_SCRIPTED_PACKAGE_JSON_NODES) {
    throw new Error(`${labelAt(path)} exceeds the ${MAX_SCRIPTED_PACKAGE_JSON_NODES}-node Script package JSON limit.`);
  }
  if (value === null) { reservePackageBytes(4, path, state, maxBytes); return value; }
  if (typeof value === "boolean") { reservePackageBytes(value ? 4 : 5, path, state, maxBytes); return value; }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${labelAt(path)} must contain finite JSON numbers.`);
    reservePackageBytes(Buffer.byteLength(JSON.stringify(value), "utf8"), path, state, maxBytes);
    return value;
  }
  if (typeof value === "string") {
    const rawBytes = Buffer.byteLength(value, "utf8");
    if (rawBytes > MAX_SCRIPTED_PACKAGE_JSON_STRING_BYTES) {
      throw new Error(`${labelAt(path)} exceeds the ${MAX_SCRIPTED_PACKAGE_JSON_STRING_BYTES}-byte Script package JSON string limit.`);
    }
    reservePackageBytes(Buffer.byteLength(JSON.stringify(value), "utf8"), path, state, maxBytes);
    return value;
  }
  if (typeof value !== "object") throw new Error(`${labelAt(path)} must contain JSON values only.`);
  if (state.parents.includes(value)) throw new Error(`${labelAt(path)} cannot contain a cycle.`);
  state.parents.push(value);
  if (Array.isArray(value)) {
    try {
      assertDataOnlyJsonContainer(value, path);
      reservePackageBytes(2, path, state, maxBytes);
      const normalized: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor)) throw new Error(`${labelAt(path)} must be a dense data-only JSON array.`);
        if (index > 0) reservePackageBytes(1, path, state, maxBytes);
        reservePackageBytes(1 + (depth + 1) * 2, path, state, maxBytes);
        normalized.push(normalizePackageJson(descriptor.value, `${path}[${index}]`, state, depth + 1, maxBytes));
      }
      if (value.length > 0) reservePackageBytes(1 + depth * 2, path, state, maxBytes);
      return normalized;
    } finally {
      state.parents.pop();
    }
  }
  try {
    if (!isPlainRecord(value)) throw new Error(`${labelAt(path)} must contain plain JSON records only.`);
    assertDataOnlyJsonContainer(value, path);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const entries = Object.keys(value).map((key) => [key, descriptors[key]!] as const);
    const normalized: JsonRecord = Object.create(null) as JsonRecord;
    reservePackageBytes(2, path, state, maxBytes);
    for (const [index, [key, descriptor]] of entries.entries()) {
      if (index > 0) reservePackageBytes(1, path, state, maxBytes);
      const keyBytes = Buffer.byteLength(key, "utf8");
      if (keyBytes > MAX_SCRIPTED_PACKAGE_JSON_STRING_BYTES) {
        throw new Error(`${labelAt(path)} has an oversized Script package JSON key.`);
      }
      reservePackageBytes(1 + (depth + 1) * 2 + Buffer.byteLength(JSON.stringify(key), "utf8") + 2, path, state, maxBytes);
      normalized[key] = normalizePackageJson(descriptor.value, `${path}.${key}`, state, depth + 1, maxBytes);
    }
    if (entries.length > 0) reservePackageBytes(1 + depth * 2, path, state, maxBytes);
    return normalized;
  } finally {
    state.parents.pop();
  }
}

function assertDataOnlyJsonContainer(value: object, path: string): void {
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new Error(`${labelAt(path)} must not contain symbol properties.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (Array.isArray(value) && key === "length") continue;
    if (!("value" in descriptor)) {
      throw new Error(`${labelAt(path)} must contain data properties only; accessors are not permitted.`);
    }
    if (!descriptor.enumerable) {
      throw new Error(`${labelAt(path)} must not contain hidden JSON properties.`);
    }
  }
}

function reservePackageBytes(bytes: number, path: string, state: { bytes: number }, maxBytes: number): void {
  state.bytes += bytes;
  if (state.bytes > maxBytes) throw new Error(`${labelAt(path)} exceeds the ${maxBytes}-byte Script package JSON limit.`);
}

function isPlainRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function labelAt(path: string): string { return path || "Script package JSON"; }
