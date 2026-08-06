import type { MotionLayer } from "./types";

export function requiredLayerFeatures(layer: MotionLayer): string[] {
  const features = new Set<string>();
  const transform = readRecord(layer.transform);
  const rotation = readNumber(transform.rotation);
  if (rotation !== null && rotation !== 0) features.add("transform.rotation");
  if (readNumber(transform.originX) !== null || readNumber(transform.originY) !== null) {
    features.add("transform.origin");
  }

  const style = readRecord(layer.style);
  addLayerTypeFeatures(layer, style, features);
  addMediaFeatures(layer, features);
  addShapeFeatures(layer, style, features);
  addStyleFeatures(style, features);
  addKeyframeFeatures(layer, features);
  addMaskAndMatteFeatures(layer, features);
  addEffectFeatures(layer, features);
  addTransitionFeatures(layer, features);
  return [...features];
}

function addLayerTypeFeatures(
  layer: MotionLayer,
  style: Record<string, unknown>,
  features: Set<string>,
): void {
  if (layer.type === "camera") features.add("camera.2d");
  if (layer.type === "shader") features.add("shader.restricted-glsl");
  if (layer.type === "scene3d") {
    const hasMesh = layer.scene3d?.objects.some((object) => object.primitive === "mesh") ?? false;
    features.add(hasMesh ? "scene3d.gltf-mesh" : "scene3d.fixed-primitives");
  }
  if (layer.type === "environment") {
    const kind = layer.environment?.kind;
    features.add(kind === "water"
      ? "environment.water.fixed-simulation"
      : kind === "snow"
        ? "environment.snow.fixed-simulation"
        : kind === "fog"
          ? "environment.fog.fixed-simulation"
          : "environment.rain.fixed-simulation");
  }
  if (readNumber(layer.depth) !== null) features.add("camera.depth");
  if (layer.type === "particles") features.add("particles.seeded");
  if (layer.type === "text" || layer.type === "caption") {
    const direction = readString(style.direction)?.trim().toLowerCase();
    if (direction === "rtl" || direction === "auto") features.add("text.direction");
    const text = readString(layer.text) ?? "";
    if (containsComplexTextShaping(text)) {
      features.add("text.shaping.complex");
    }
    // the text-delivery invariant: a lane without a font rasterizer (native block glyphs) can only draw a fixed
    // ASCII bitmap set; every other codepoint became deterministic noise. Declaring the requirement
    // here lets the capability gate refuse those lanes instead of shipping a corrupted render.
    if (containsNonAsciiText(text)) {
      features.add("text.charset.non-ascii");
    }
  }
}

function addMediaFeatures(layer: MotionLayer, features: Set<string>): void {
  if (
    (layer.type === "image" || layer.type === "video")
    && Object.keys(readRecord(layer.crop)).length > 0
  ) {
    features.add(`${layer.type}.crop`);
  }
  if (layer.type === "image" || layer.type === "video") {
    const fit = advancedMediaFit(layer);
    if (fit) features.add(`${layer.type}.fit.${fit}`);
  }
  if (layer.type === "video") addVideoControlFeatures(layer, features);
  if (layer.type === "audio" || (layer.type === "video" && layer.includeAudio === true)) {
    addAudioControlFeatures(layer, features);
  }
}

function addShapeFeatures(
  layer: MotionLayer,
  style: Record<string, unknown>,
  features: Set<string>,
): void {
  const stroke = readString(style.stroke);
  const strokeWidth = readNumber(style.strokeWidth) ?? (stroke ? readNumber(style.width) : null);
  if (layer.type === "shape" && stroke && (strokeWidth === null || strokeWidth > 0)) {
    features.add("shape.stroke");
  }
  if (layer.type !== "shape") return;
  const shapeKind = canonicalShapeKind(readString(layer.shape) ?? "rect", layer);
  if (shapeKind === "path" && pathUsesCurveCommands(layer)) {
    features.add("shape.path.curve");
  } else {
    features.add(`shape.${shapeKind}`);
  }
  if (hasPositiveLengthValue(style.radius) || hasPositiveLengthValue(style.borderRadius)) {
    features.add("shape.radius");
  }
  if (Object.keys(readRecord(layer.gradient)).length > 0) features.add("shape.gradient");
}

function addStyleFeatures(style: Record<string, unknown>, features: Set<string>): void {
  if (hasStyleValue(style.shadow) || hasStyleValue(style.boxShadow)) {
    features.add("style.shadow");
  }
  if (hasStyleValue(style.textShadow)) features.add("style.textShadow");
}

function addKeyframeFeatures(layer: MotionLayer, features: Set<string>): void {
  const keyframes = readRecord(layer.keyframes);
  for (const [target, value] of Object.entries(keyframes)) {
    if (!Array.isArray(value) || value.length === 0) continue;
    if (target === "transform.originX" || target === "transform.originY") {
      features.add("transform.origin");
    }
    if (target === "blendMode") {
      for (const frame of value) {
        const blendMode = readString(readRecord(frame).value);
        if (blendMode && blendMode !== "normal") features.add(`blend.${blendMode}`);
      }
    }
    features.add(target.startsWith("shader.uniforms.")
      ? "keyframe.shader.uniform"
      : `keyframe.${target}`);
  }
}

function addMaskAndMatteFeatures(layer: MotionLayer, features: Set<string>): void {
  const mask = readRecord(layer.mask);
  const maskType = readString(mask.type);
  if (maskType) features.add(`mask.${maskType}`);
  if (maskType === "roto" && Object.keys(readRecord(mask.tracking)).length > 0) {
    features.add("mask.roto.tracked");
  }
  if (Object.keys(readRecord(layer.keying)).length > 0) features.add("keying.chroma");
  const matteType = readString(readRecord(layer.matte).type);
  if (matteType) features.add(`matte.${matteType}`);
}

function addEffectFeatures(layer: MotionLayer, features: Set<string>): void {
  const effects = readRecord(layer.effects);
  for (const [name, value] of Object.entries(effects)) {
    if (readNumber(value) !== null) features.add(`effect.${name}`);
  }
  if (Object.keys(readRecord(effects.glow)).length > 0) features.add("effect.glow");
  if (Object.keys(readRecord(effects.motionBlur)).length > 0) features.add("effect.motionBlur");
  if (Object.keys(readRecord(effects.vignette)).length > 0) features.add("effect.vignette");
  if (Object.keys(readRecord(effects.filmGrain)).length > 0) features.add("effect.filmGrain");
  const blendMode = readString(layer.blendMode);
  if (blendMode && blendMode !== "normal") features.add(`blend.${blendMode}`);
}

function addTransitionFeatures(layer: MotionLayer, features: Set<string>): void {
  const transitions = readRecord(layer.transitions);
  for (const edge of ["in", "out"]) {
    const transitionType = readString(readRecord(transitions[edge]).type);
    if (transitionType) features.add(`transition.${transitionType}`);
  }
}

function canonicalShapeKind(value: string, layer: MotionLayer): string {
  if (value === "freeform" && hasFreeformPath(layer)) return "path";
  return value === "rectangle" ? "rect" : value;
}

function addVideoControlFeatures(layer: MotionLayer, features: Set<string>): void {
  if (readNumber(layer.trimStartMs) !== null || readNumber(layer.trimDurationMs) !== null) {
    features.add("video.trim");
  }
  if (layer.loop === true) features.add("video.loop");
  const playbackRate = readNumber(layer.playbackRate);
  if (playbackRate !== null && playbackRate !== 1) features.add("video.playbackRate");
  if (layer.includeAudio === true) features.add("video.includeAudio");
}

function addAudioControlFeatures(layer: MotionLayer, features: Set<string>): void {
  if (readNumber(layer.trimStartMs) !== null || readNumber(layer.trimDurationMs) !== null) {
    features.add("audio.trim");
  }
  if (layer.loop === true) features.add("audio.loop");
  const playbackRate = readNumber(layer.playbackRate);
  if (playbackRate !== null && playbackRate !== 1) features.add("audio.playbackRate");
  if (readNumber(layer.volume) !== null) features.add("audio.volume");
  if (readNumber(layer.pan) !== null) features.add("audio.pan");
  if (layer.muted === true) features.add("audio.muted");
  if (readNumber(layer.fadeInMs) !== null || readNumber(layer.fadeOutMs) !== null) {
    features.add("audio.fade");
  }
  if (layer.normalizeLoudness === true) features.add("audio.normalizeLoudness");
  if (Object.keys(readRecord(layer.ducking)).length > 0) features.add("audio.ducking");
}

function hasFreeformPath(layer: MotionLayer): boolean {
  return readString(layer["x-path"]) !== null || readString(readRecord(layer.style).path) !== null;
}

function pathUsesCurveCommands(layer: MotionLayer): boolean {
  const pathData = readString(layer["x-path"]) ?? readString(readRecord(layer.style).path) ?? "";
  return /[AaCcQqSsTt]/.test(pathData);
}

function advancedMediaFit(layer: MotionLayer): "none" | "scale-down" | null {
  const style = readRecord(layer.style);
  const fit = (
    readString(layer.fit) ?? readString(style.objectFit) ?? readString(style.fit) ?? ""
  ).trim().toLowerCase();
  return fit === "none" || fit === "scale-down" ? fit : null;
}

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function hasStyleValue(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number") return Number.isFinite(value);
  return Object.keys(readRecord(value)).length > 0;
}

function hasPositiveLengthValue(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value) && value > 0;
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  const numeric = /^(-?(?:\d+|\d*\.\d+))(?:px|em|rem|%|vh|vw)?$/i.exec(trimmed);
  return numeric ? Number(numeric[1]) > 0 : true;
}

function containsComplexTextShaping(text: string): boolean {
  return /[\u0300-\u036f\u0590-\u0fff\u1000-\u109f\u1780-\u17ff\u200c\u200d\ufb1d-\ufdff\ufe70-\ufefc]/u.test(text);
}

/**
 * Whether `text` needs glyph coverage beyond printable US-ASCII.
 *
 * Deliberately a charset test rather than a script list (the text-delivery invariant): the previous gate enumerated
 * only complex-shaping scripts (combining marks, Hebrew, Arabic, Indic, Thai, Khmer, Myanmar), so
 * Latin-Extended (Latvian E-macron / L-cedilla, French e-acute), Greek, Cyrillic, CJK, emoji and
 * typographic punctuation (em dash, curly quotes) passed the gate and were then drawn by the native
 * lane's block-glyph fallback as codepoint-derived noise. Any lane that carries a real font
 * rasterizer declares `text.charset.non-ascii`; the native block-glyph lane does not, and therefore
 * refuses instead of corrupting the text.
 *
 * Layout whitespace (space, tab, CR, LF) passes; every other character outside printable ASCII
 * U+0020-U+007E counts, including the remaining C0 control characters.
 *
 * @param text Raw layer text.
 * @returns True when at least one character is outside printable ASCII plus layout whitespace.
 */
function containsNonAsciiText(text: string): boolean {
  return /[^\t\n\r\x20-\x7e]/u.test(text);
}
