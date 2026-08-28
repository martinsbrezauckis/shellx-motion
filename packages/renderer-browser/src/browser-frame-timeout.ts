/**
 * Source-owned wall-clock policy for one Browser batch frame.
 *
 * The former 30s fixed default was sized for small previews. A final proof frame has a declared
 * output workload: viewport pixels (including device scale) are the raster work Chromium must
 * settle and capture. Give that work a deterministic allowance while retaining a hard ceiling so
 * a stalled page still tears down the shared session rather than waiting without bound.
 */
export const BROWSER_FRAME_TIMEOUT_POLICY = Object.freeze({
  baseMs: 30_000,
  perMegapixelMs: 15_000,
  minMs: 100,
  maxMs: 120_000
});

export interface BrowserFrameTimeoutViewport {
  width: number;
  height: number;
  deviceScaleFactor?: number;
}

/**
 * Resolve the per-frame deadline from declared output work, unless the caller deliberately asks
 * for a stricter or otherwise bounded value. This is shared by every Browser batch caller; it is
 * not a host- or operating-system-specific exception.
 */
export function resolveBrowserFrameTimeoutMs(
  viewport: BrowserFrameTimeoutViewport,
  requestedTimeoutMs?: number
): number {
  if (requestedTimeoutMs !== undefined) return boundedBrowserFrameTimeout(requestedTimeoutMs);
  const scale = viewport.deviceScaleFactor ?? 1;
  const pixels = viewport.width * viewport.height * scale * scale;
  // Frame admission validates dimensions before Chromium allocation. Keep this resolver total as
  // well, so an invalid request cannot turn timeout arithmetic into an unbounded timer while that
  // validation is reached.
  if (!Number.isFinite(pixels) || pixels <= 0) return BROWSER_FRAME_TIMEOUT_POLICY.baseMs;
  const workloadMs = Math.ceil((pixels * BROWSER_FRAME_TIMEOUT_POLICY.perMegapixelMs) / 1_000_000);
  return Math.min(BROWSER_FRAME_TIMEOUT_POLICY.maxMs, BROWSER_FRAME_TIMEOUT_POLICY.baseMs + workloadMs);
}

export function boundedBrowserFrameTimeout(value: number): number {
  if (!Number.isInteger(value) || value < BROWSER_FRAME_TIMEOUT_POLICY.minMs || value > BROWSER_FRAME_TIMEOUT_POLICY.maxMs) {
    throw new Error("Browser per-frame timeout must be an integer from 100 to 120000ms.");
  }
  return value;
}
