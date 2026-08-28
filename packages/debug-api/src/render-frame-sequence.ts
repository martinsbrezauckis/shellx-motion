/** Shared final-render frame naming and timeline sampling rules. */

export function frameCountFor(durationMs: number, fps: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0 || !Number.isFinite(fps) || fps <= 0) return 1;
  return Math.max(1, Math.ceil((durationMs / 1000) * fps));
}

export function frameTimestampMs(frameIndex: number, fps: number, durationMs: number): number {
  const atMs = Math.round((frameIndex * 1000) / fps);
  return Math.max(0, Math.min(atMs, Math.max(0, durationMs - 1)));
}

export function sequenceFrameIndexForAtMs(atMs: number, durationMs: number, fps: number): number {
  const frameCount = frameCountFor(durationMs, fps);
  if (!Number.isFinite(atMs) || atMs <= 0) return 0;
  const clampedAtMs = Math.min(atMs, Math.max(0, durationMs - 1));
  const frameIndex = Math.round((clampedAtMs / 1000) * fps);
  return Math.max(0, Math.min(frameIndex, frameCount - 1));
}

export function frameFileName(frameIndex: number): string {
  return `${String(frameIndex + 1).padStart(6, "0")}.png`;
}
