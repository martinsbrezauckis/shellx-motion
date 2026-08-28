import { MAX_KEYING_PIXELS } from "./matte";

export const BROWSER_KEYING_RUNTIME_VERSION = "shellx-motion/browser-keying-runtime@1" as const;

export interface BrowserKeyingRuntimeLayerEvidence {
  layerId: string;
  width: number;
  height: number;
  transparentPixels: number;
  edgePixels: number;
  opaquePixels: number;
  spillAdjustedPixels: number;
}

export interface BrowserKeyingRuntimeEvidence {
  version: typeof BROWSER_KEYING_RUNTIME_VERSION;
  maxPixels: number;
  layers: BrowserKeyingRuntimeLayerEvidence[];
}

/** Installs fixed host code; package data can select only validated numeric controls. */
export function browserKeyingRuntimeScript(): string {
  // esbuild may preserve helper calls in Function#toString output without the
  // module-scoped helper. The fixed identity helper keeps the host runtime
  // self-contained in CLI/tsx production execution as well as test bundles.
  return `<script>const __name=(target,_name)=>target;(${installBrowserKeyingRuntime.toString()})(${MAX_KEYING_PIXELS},${JSON.stringify(BROWSER_KEYING_RUNTIME_VERSION)});</script>`;
}

function installBrowserKeyingRuntime(maxPixels: number, version: typeof BROWSER_KEYING_RUNTIME_VERSION): void {
  type Settings = {
    keyColor: string;
    similarity: number;
    smoothness: number;
    shadow: number;
    spillSuppression: number;
    spillBalance: number;
    edgeColorCorrection: number;
    matte: {
      denoiseRadiusPx: number;
      growShrinkPx: number;
      chokePx: number;
      featherPx: number;
      blackClip: number;
      whiteClip: number;
    };
  };
  const root = globalThis as typeof globalThis & {
    __SHELLX_MOTION_APPLY_KEYING__?: () => Promise<BrowserKeyingRuntimeEvidence>;
  };
  const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
  const byte = (value: number): number => Math.round(clamp(value, 0, 255));
  const chroma = (r: number, g: number, b: number): { cb: number; cr: number } => ({
    cb: (-0.168736 * r - 0.331264 * g + 0.5 * b) / 255,
    cr: (0.5 * r - 0.418688 * g - 0.081312 * b) / 255,
  });
  const smoothstep = (start: number, end: number, value: number): number => {
    const amount = clamp((value - start) / (end - start), 0, 1);
    return amount * amount * (3 - 2 * amount);
  };
  const parseKey = (value: string): { r: number; g: number; b: number } => ({
    r: Number.parseInt(value.slice(1, 3), 16),
    g: Number.parseInt(value.slice(3, 5), 16),
    b: Number.parseInt(value.slice(5, 7), 16),
  });
  const boxBlur = (source: Uint8Array, width: number, height: number, radius: number): Uint8Array => {
    const horizontal = new Float64Array(source.length);
    const output = new Uint8Array(source.length);
    for (let y = 0; y < height; y += 1) {
      let sum = 0;
      for (let x = -radius; x <= radius; x += 1) sum += source[y * width + clamp(x, 0, width - 1)];
      for (let x = 0; x < width; x += 1) {
        horizontal[y * width + x] = sum / (radius * 2 + 1);
        sum += source[y * width + clamp(x + radius + 1, 0, width - 1)] - source[y * width + clamp(x - radius, 0, width - 1)];
      }
    }
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      for (let y = -radius; y <= radius; y += 1) sum += horizontal[clamp(y, 0, height - 1) * width + x];
      for (let y = 0; y < height; y += 1) {
        output[y * width + x] = byte(sum / (radius * 2 + 1));
        sum += horizontal[clamp(y + radius + 1, 0, height - 1) * width + x] - horizontal[clamp(y - radius, 0, height - 1) * width + x];
      }
    }
    return output;
  };
  const extremaLine = (
    length: number,
    radius: number,
    grow: boolean,
    read: (index: number) => number,
    write: (index: number, value: number) => void,
    indices: Int32Array,
    values: Uint8Array,
  ): void => {
    let head = 0; let tail = 0;
    for (let sample = -radius; sample < length + radius; sample += 1) {
      const value = read(clamp(sample, 0, length - 1));
      while (tail > head && (grow ? value >= values[tail - 1] : value <= values[tail - 1])) tail -= 1;
      indices[tail] = sample; values[tail] = value; tail += 1;
      const windowStart = sample - radius * 2;
      while (tail > head && indices[head] < windowStart) head += 1;
      const outputIndex = sample - radius;
      if (outputIndex >= 0 && outputIndex < length) write(outputIndex, values[head]);
    }
  };
  const morphology = (source: Uint8Array, width: number, height: number, radius: number, grow: boolean): Uint8Array => {
    const horizontal = new Uint8Array(source.length);
    const output = new Uint8Array(source.length);
    const indices = new Int32Array(Math.max(width, height) + radius * 2);
    const values = new Uint8Array(indices.length);
    for (let y = 0; y < height; y += 1) extremaLine(
      width, radius, grow,
      (x) => source[y * width + x],
      (x, value) => { horizontal[y * width + x] = value; },
      indices, values,
    );
    for (let x = 0; x < width; x += 1) extremaLine(
      height, radius, grow,
      (y) => horizontal[y * width + x],
      (y, value) => { output[y * width + x] = value; },
      indices, values,
    );
    return output;
  };
  const cleanup = (source: Uint8Array, width: number, height: number, settings: Settings["matte"]): Uint8Array => {
    let alpha: Uint8Array = new Uint8Array(source);
    if (settings.denoiseRadiusPx > 0) {
      const blurred = boxBlur(alpha, width, height, settings.denoiseRadiusPx);
      alpha = alpha.map((value, index) => Math.abs(value - blurred[index]) >= 48 ? blurred[index] : byte(value * 0.75 + blurred[index] * 0.25));
    }
    if (settings.growShrinkPx !== 0) alpha = morphology(alpha, width, height, Math.abs(settings.growShrinkPx), settings.growShrinkPx > 0);
    if (settings.chokePx > 0) alpha = morphology(alpha, width, height, settings.chokePx, false);
    if (settings.featherPx > 0) alpha = boxBlur(alpha, width, height, settings.featherPx);
    const span = settings.whiteClip - settings.blackClip;
    return alpha.map((value) => byte(((value / 255 - settings.blackClip) / span) * 255));
  };
  const surfaceFor = async (element: Element): Promise<HTMLCanvasElement> => {
    if (element instanceof HTMLCanvasElement) return element;
    if (!(element instanceof HTMLImageElement)) throw new Error("Keying supports only decoded image or frozen-video surfaces.");
    if (!element.complete || element.naturalWidth < 1) await element.decode();
    const sourcePixels = element.naturalWidth * element.naturalHeight;
    if (!Number.isSafeInteger(sourcePixels) || sourcePixels < 1 || sourcePixels > maxPixels) {
      throw new Error(`Keying surface exceeds the ${maxPixels}-pixel budget.`);
    }
    const canvas = document.createElement("canvas");
    canvas.width = element.naturalWidth;
    canvas.height = element.naturalHeight;
    for (const attribute of Array.from(element.attributes)) if (attribute.name !== "src") canvas.setAttribute(attribute.name, attribute.value);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Keying could not allocate an image surface.");
    context.drawImage(element, 0, 0);
    element.replaceWith(canvas);
    return canvas;
  };
  root.__SHELLX_MOTION_APPLY_KEYING__ = async () => {
    const layers: BrowserKeyingRuntimeLayerEvidence[] = [];
    const elements = Array.from(document.querySelectorAll("[data-motion-keying]"));
    for (const element of elements) {
      const settings = JSON.parse((element as HTMLElement).dataset.motionKeying ?? "null") as Settings | null;
      if (!settings) throw new Error("Keying settings are missing.");
      const surface = await surfaceFor(element);
      const pixels = surface.width * surface.height;
      if (pixels < 1 || pixels > maxPixels) throw new Error(`Keying surface exceeds the ${maxPixels}-pixel budget.`);
      const context = surface.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("Keying could not read its render surface.");
      const frame = context.getImageData(0, 0, surface.width, surface.height);
      const rgba = frame.data;
      const matte = new Uint8Array(pixels);
      const key = parseKey(settings.keyColor);
      const keyChroma = chroma(key.r, key.g, key.b);
      let spillAdjustedPixels = 0;
      for (let pixel = 0; pixel < pixels; pixel += 1) {
        const offset = pixel * 4;
        const r = rgba[offset]; const g = rgba[offset + 1]; const b = rgba[offset + 2];
        const sourceAlpha = rgba[offset + 3] / 255;
        const value = chroma(r, g, b);
        const distance = Math.hypot(value.cb - keyChroma.cb, value.cr - keyChroma.cr) / 1.5;
        const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
        const threshold = settings.similarity * (0.75 + settings.shadow * 0.25 * luma);
        const foreground = smoothstep(threshold, threshold + Math.max(0.0001, settings.smoothness), distance);
        matte[pixel] = byte(foreground * sourceAlpha * 255);
        const channels = [r, g, b]; const keyChannels = [key.r, key.g, key.b];
        const dominant = keyChannels.indexOf(Math.max(...keyChannels));
        const others = [0, 1, 2].filter((channel) => channel !== dominant);
        const neutral = channels[others[0]] + (channels[others[1]] - channels[others[0]]) * ((settings.spillBalance + 1) / 2);
        const excess = Math.max(0, channels[dominant] - neutral);
        const edgeWeight = 1 - foreground;
        const edgeCorrection = settings.edgeColorCorrection * edgeWeight;
        const reduction = excess * clamp(settings.spillSuppression * edgeWeight + edgeCorrection, 0, 1);
        channels[dominant] -= reduction;
        if (edgeCorrection > 0) {
          const correction = reduction * edgeCorrection * 0.35;
          channels[others[0]] += correction * (1 - settings.spillBalance) / 2;
          channels[others[1]] += correction * (1 + settings.spillBalance) / 2;
        }
        rgba[offset] = byte(channels[0]); rgba[offset + 1] = byte(channels[1]); rgba[offset + 2] = byte(channels[2]);
        if (reduction >= 0.5) spillAdjustedPixels += 1;
      }
      const cleaned = cleanup(matte, surface.width, surface.height, settings.matte);
      let transparentPixels = 0; let edgePixels = 0; let opaquePixels = 0;
      for (let pixel = 0; pixel < pixels; pixel += 1) {
        const alpha = Math.min(cleaned[pixel], rgba[pixel * 4 + 3]);
        rgba[pixel * 4 + 3] = alpha;
        if (alpha === 0) transparentPixels += 1; else if (alpha === 255) opaquePixels += 1; else edgePixels += 1;
      }
      context.putImageData(frame, 0, 0);
      surface.dataset.motionKeyingState = "ready";
      layers.push({ layerId: surface.dataset.layerId ?? "(unknown)", width: surface.width, height: surface.height, transparentPixels, edgePixels, opaquePixels, spillAdjustedPixels });
    }
    return { version, maxPixels, layers };
  };
}
