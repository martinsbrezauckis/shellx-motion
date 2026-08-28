/**
 * Bounded readers shared by static Lottie lowering paths. In strict mode they
 * reject malformed or out-of-range supplied values rather than synthesizing a
 * visually similar fallback for the exact GPU-precomposition contract.
 */
export function staticLottieVector(value: unknown, fallback: number[], strict = false): number[] {
  if (value === undefined) return [...fallback];
  const property = jsonRecord(value);
  const raw = property.k ?? value;
  if (!Array.isArray(raw) || raw.length < 2 || (strict && raw.length !== 2 && raw.length !== 3)) {
    if (strict) throw new Error("Lottie lowering requires static vector values.");
    return [...fallback];
  }
  const numbers = raw.map(jsonNumber);
  if (numbers.some((entry) => entry === null)) throw new Error("Lottie lowering requires finite static vector values.");
  // Standard 2D Lottie layers commonly carry a passive third component
  // (`p/a` z and `s` z-scale). The GPU precomp boundary separately rejects
  // `ddd != 0`, so retaining the first two components here is exact 2D
  // projection rather than a 3D fallback.
  return strict ? (numbers as number[]).slice(0, 2) : numbers as number[];
}

export function staticLottieScalar(value: unknown, fallback: number, strict = false): number {
  if (value === undefined) return fallback;
  const property = jsonRecord(value);
  const parsed = jsonNumber(property.k ?? value);
  if (parsed === null && strict) throw new Error("Lottie lowering requires a finite static scalar value.");
  return parsed ?? fallback;
}

export function staticPositiveLottieScalar(value: unknown, fallback: number, label: string, strict: boolean): number {
  const scalar = staticLottieScalar(value, fallback, strict);
  if (scalar <= 0) {
    if (strict) throw new Error(`Lottie lowering requires positive ${label}.`);
    return fallback;
  }
  return scalar;
}

export function staticLottieStrokeWidth(stroke: Record<string, unknown> | undefined, strict: boolean): number {
  if (!stroke) return 0;
  const width = staticLottieScalar(stroke.w, 0, strict);
  if (width < 0) {
    if (strict) throw new Error("Lottie lowering requires non-negative static stroke width.");
    return 0;
  }
  return width;
}

export function lottieColor(value: unknown, fallback: string, strict = false): string {
  if (!Array.isArray(value) || value.length < 3 || (strict && value.length > 4)) {
    if (strict) throw new Error("Lottie lowering requires three or four normalized static color channels.");
    return fallback;
  }
  const channels = value.slice(0, 4).map(jsonNumber);
  if (channels.slice(0, strict ? 4 : 3).some((entry) => entry === null)) {
    if (strict) throw new Error("Lottie lowering requires finite static color channels.");
    return fallback;
  }
  if (strict && channels.some((entry) => entry !== null && (entry < 0 || entry > 1))) {
    throw new Error("Lottie lowering requires normalized static color channels.");
  }
  const normalized = channels.map((entry, index) => {
    const channel = entry ?? (index === 3 ? 1 : 0);
    return Math.round(Math.max(0, Math.min(1, channel)) * 255).toString(16).padStart(2, "0");
  });
  return `#${normalized.slice(0, 4).join("")}`;
}

export function lottieStrokeLinecap(value: number | null, strict = false): "butt" | "round" | "square" {
  if (strict && value !== null && value !== 1 && value !== 2 && value !== 3) {
    throw new Error("Lottie lowering requires a supported static stroke line cap.");
  }
  return value === 2 ? "round" : value === 3 ? "square" : "butt";
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function jsonNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
