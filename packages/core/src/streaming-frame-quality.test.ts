import { describe, expect, it } from "vitest";
import { encodeRgbaPng } from "./quality";
import {
  createStreamingFrameQualityAccumulator,
  MAX_STREAMING_UNIQUE_FRAME_HASHES,
  streamingFrameDimensionsRefusal,
  streamingFrameQualityHashRetentionCapacity,
  streamingFrameTimestampMs
} from "./streaming-frame-quality";

const CONTRAST_PNG = encodeRgbaPng(2, 2, Buffer.from([
  0, 0, 0, 255,
  255, 255, 255, 255,
  10, 80, 180, 255,
  250, 30, 40, 255
]));
const SECOND_PNG = encodeRgbaPng(2, 2, Buffer.from([
  255, 255, 255, 255,
  0, 0, 0, 255,
  180, 80, 10, 255,
  40, 30, 250, 255
]));
const BLACK_PNG = encodeRgbaPng(2, 2, Buffer.from([
  0, 0, 0, 255,
  0, 0, 0, 255,
  0, 0, 0, 255,
  0, 0, 0, 255
]));
const CONTRAST_RGBA = Buffer.from([
  0, 0, 0, 255,
  255, 255, 255, 255,
  10, 80, 180, 255,
  250, 30, 40, 255
]);

describe("streaming frame quality accumulator", () => {
  it("preserves deterministic identity and the non-blank, unique-frame gate without retaining frames", () => {
    const first = render([CONTRAST_PNG, SECOND_PNG]);
    const second = render([CONTRAST_PNG, SECOND_PNG]);

    expect(first).toMatchObject({
      ok: true,
      identity: { schema: "shellx-motion/streamed-frame-sequence@1" },
      summary: { frameCount: 2, blankFrames: 0, uniqueFrameHashes: 2, uniqueFrameHashesExact: true }
    });
    expect(second).toMatchObject({ ok: true });
    if (first.ok && second.ok) expect(first.identity.sha256).toBe(second.identity.sha256);
  });

  it("refuses blank and static sequences instead of dropping those gates", () => {
    const blank = render([BLACK_PNG, BLACK_PNG]);
    const staticFrames = render([CONTRAST_PNG, CONTRAST_PNG]);

    expect(blank).toMatchObject({ ok: false, code: "blank_frames" });
    expect(staticFrames).toMatchObject({ ok: false, code: "static_frames" });
  });

  it("rejects an oversized unique-frame policy rather than retaining caller-sized hash state", () => {
    const quality = createStreamingFrameQualityAccumulator({
      frameCount: 1,
      durationMs: 1000,
      fps: 1,
      width: 2,
      height: 2,
      quality: { minUniqueFrameHashes: MAX_STREAMING_UNIQUE_FRAME_HASHES + 1 }
    });
    quality.observe({ index: 0, atMs: 0, png: CONTRAST_PNG });

    expect(quality.finish()).toMatchObject({ ok: false, code: "streaming_quality_policy_unsupported" });
    expect(streamingFrameQualityHashRetentionCapacity({ minUniqueFrameHashes: Number.MAX_SAFE_INTEGER })).toBe(MAX_STREAMING_UNIQUE_FRAME_HASHES);
  });

  it("marks a unique hash count as a lower bound only after a new hash exceeds the retained cap", () => {
    const third = encodeRgbaPng(2, 2, Buffer.from([
      20, 20, 20, 255,
      30, 30, 30, 255,
      40, 40, 40, 255,
      50, 50, 50, 255
    ]));
    const result = render([CONTRAST_PNG, SECOND_PNG, third]);

    expect(result).toMatchObject({ ok: true, summary: { uniqueFrameHashes: 2, uniqueFrameHashesExact: false } });
  });

  it("refuses out-of-order input with a typed quality failure", () => {
    const quality = createStreamingFrameQualityAccumulator({ frameCount: 2, durationMs: 1000, fps: 2, width: 2, height: 2 });
    expect(quality.observe({ index: 1, atMs: 500, png: CONTRAST_PNG })).toMatchObject({ ok: false, code: "invalid_frame" });
    expect(quality.finish()).toMatchObject({ ok: false, code: "invalid_frame" });
  });

  it("shares the decoder's portrait and side limits before a streamed PNG is produced", () => {
    expect(streamingFrameDimensionsRefusal(2_160, 3_840)).toBeUndefined();
    expect(streamingFrameDimensionsRefusal(3_841, 2)).toContain("PNG inspection budget");
  });

  it("inspects tightly packed straight-alpha sRGB without a PNG intermediate", () => {
    const quality = createStreamingFrameQualityAccumulator({ frameCount: 1, durationMs: 1000, fps: 1, width: 2, height: 2 });
    expect(quality.observe({
      index: 0,
      atMs: 0,
      format: "rgba",
      rgba: CONTRAST_RGBA,
      width: 2,
      height: 2,
      strideBytes: 8,
      colorSpace: "srgb",
      alphaMode: "straight"
    })).toMatchObject({ ok: true, width: 2, height: 2, blank: false });
    expect(quality.finish()).toMatchObject({ ok: true, summary: { frameCount: 1, blankFrames: 0 } });
  });

  it("refuses malformed raw RGBA contracts", () => {
    const quality = createStreamingFrameQualityAccumulator({ frameCount: 1, durationMs: 1000, fps: 1, width: 2, height: 2 });
    expect(quality.observe({
      index: 0,
      atMs: 0,
      format: "rgba",
      rgba: CONTRAST_RGBA,
      width: 2,
      height: 2,
      strideBytes: 16,
      colorSpace: "srgb",
      alphaMode: "straight"
    })).toMatchObject({ ok: false });
    expect(quality.finish()).toMatchObject({ ok: false, code: "invalid_frame" });
  });
});

function render(frames: Buffer[]) {
  const quality = createStreamingFrameQualityAccumulator({
    frameCount: frames.length,
    durationMs: 1000,
    fps: frames.length,
    width: 2,
    height: 2,
    quality: { minUniqueFrameHashes: 2 }
  });
  frames.forEach((png, index) => quality.observe({ index, atMs: streamingFrameTimestampMs(index, frames.length, 1000), png }));
  return quality.finish();
}
