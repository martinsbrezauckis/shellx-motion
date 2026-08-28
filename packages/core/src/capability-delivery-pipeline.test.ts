import { describe, expect, it } from "vitest";
import { matchRendererCapabilityCards } from "./capabilities";
import type { MotionDocument } from "./types";

const nativeSafeDelivery: MotionDocument = {
  schema: "shellx-motion/motion@1",
  id: "native_delivery_safe",
  name: "Native Delivery Safe",
  durationMs: 1000,
  fps: 10,
  width: 1280,
  height: 720,
  background: "#000000",
  layers: [
    { id: "title", type: "text", text: "SHELLX 2026!", startMs: 0, durationMs: 1000 },
    { id: "backdrop", type: "shape", shape: "rect", startMs: 0, durationMs: 1000 }
  ],
  assets: [],
  provenance: { sourceApp: "shellx-motion", createdBy: "test" }
};

describe("native final-delivery capability pipeline", () => {
  it("advertises the implemented native PNG sequence and selects it when requested", () => {
    const sequence = matchRendererCapabilityCards(nativeSafeDelivery, {
      output: "png-sequence",
      target: "frame-sequence"
    });
    expect(sequence.matches.find((match) => match.lane === "native")).toMatchObject({
      ok: true,
      outputOk: true,
      targetOk: true,
      unsupported: [],
      card: { outputs: expect.arrayContaining(["png-sequence"]), renderTargets: expect.arrayContaining(["frame-sequence"]) }
    });

    const final = matchRendererCapabilityCards(nativeSafeDelivery, {
      output: "mp4-h264",
      target: "final",
      preferLane: "native"
    });
    expect(final.recommendedPipeline).toEqual({
      lanes: ["native", "ffmpeg"],
      frameLane: "native",
      finalLane: "ffmpeg",
      reason: "Lane ffmpeg requires native frame capture before final encode."
    });
  });

  it.each([
    ["case-folded text", { ...nativeSafeDelivery, layers: [{ id: "title", type: "text", text: "ShellX", startMs: 0, durationMs: 1000 }] }, "text.case.preserved", "would case-fold delivered text"],
    ["fallback text", { ...nativeSafeDelivery, layers: [{ id: "title", type: "text", text: "SHELLX @", startMs: 0, durationMs: 1000 }] }, "text.block-glyphs.fallback", "would draw fallback noise boxes"],
    ["non-ASCII text", { ...nativeSafeDelivery, layers: [{ id: "title", type: "text", text: "ZIEMEĻU", startMs: 0, durationMs: 1000 }] }, "text.charset.non-ascii", "does not support text.charset.non-ascii"],
    ["requested fonts", { ...nativeSafeDelivery, layers: [{ id: "title", type: "text", text: "SHELLX", startMs: 0, durationMs: 1000, style: { fontFamily: "Inter" } }] }, "text.font.family", "delivered text would not use it"],
    ["web layers", { ...nativeSafeDelivery, layers: [{ id: "card", type: "web", src: "card.html", startMs: 0, durationMs: 1000 }] }, "layer.type:web", "does not support web layers"]
  ] as Array<[string, MotionDocument, string, string]>)("keeps %s out of the native final pipeline", (_label, motion, feature, reason) => {
    const result = matchRendererCapabilityCards(motion, {
      output: "mp4-h264",
      target: "final",
      preferLane: "native"
    });
    expect(result.matches.find((match) => match.lane === "native")).toMatchObject({
      unsupported: expect.arrayContaining([expect.objectContaining({ feature, reason: expect.stringContaining(reason) })])
    });
    expect(result.recommendedPipeline).toEqual({
      lanes: ["browser", "ffmpeg"],
      frameLane: "browser",
      finalLane: "ffmpeg",
      reason: "Lane ffmpeg requires browser frame capture before final encode."
    });
  });
});
