import { describe, expect, it } from "vitest";
import {
  CHROMA_KEY_SCHEMA,
  ROTO_MASK_SCHEMA,
  ROTO_TRACKING_ATTACHMENT_SCHEMA,
  resolveRotoFrame,
  resolvedMotionChromaKey,
  rotoFrameSvgPath,
  validateLayerKeyingAndRoto,
  type MotionMask,
} from "./keying";
import { loadSchema, validateDocument } from "./validate";

const rotoMask: MotionMask = {
  type: "roto",
  schema: ROTO_MASK_SCHEMA,
  closed: true,
  featherPx: 8,
  expansionPx: -2,
  frames: [
    {
      atMs: 0,
      vertices: [
        { id: "a", x: 0.1, y: 0.2, outTangent: { x: 0.05, y: 0 } },
        { id: "b", x: 0.8, y: 0.2, inTangent: { x: -0.05, y: 0 } },
        { id: "c", x: 0.5, y: 0.8 },
      ],
    },
    {
      atMs: 1_000,
      vertices: [
        { id: "a", x: 0.2, y: 0.3, outTangent: { x: 0.1, y: 0 } },
        { id: "b", x: 0.9, y: 0.3, inTangent: { x: -0.1, y: 0 } },
        { id: "c", x: 0.6, y: 0.9 },
      ],
    },
  ],
  tracking: {
    schema: ROTO_TRACKING_ATTACHMENT_SCHEMA,
    analysisId: "hero-track",
    sourceSha256: "a".repeat(64),
    segmentIndex: 0,
    model: "similarity",
  },
};

describe("bounded keying and roto contracts", () => {
  it("normalizes professional chroma defaults without hidden unbounded controls", () => {
    const resolved = resolvedMotionChromaKey({
      schema: CHROMA_KEY_SCHEMA,
      keyColor: "#00FF00",
      matte: { denoiseRadiusPx: 2, growShrinkPx: -1, chokePx: 1, featherPx: 4 },
    });
    expect(resolved).toMatchObject({
      keyColor: "#00ff00",
      similarity: 0.18,
      smoothness: 0.12,
      spillSuppression: 0.55,
      matte: { denoiseRadiusPx: 2, growShrinkPx: -1, chokePx: 1, featherPx: 4 },
    });
  });

  it("validates a tracked animated roto mask and rejects unknown package authority", () => {
    const layer = {
      id: "footage",
      type: "video",
      startMs: 0,
      durationMs: 1_000,
      keying: {
        schema: CHROMA_KEY_SCHEMA,
        keyColor: "#00ff00",
        similarity: 0.2,
        smoothness: 0.15,
        spillSuppression: 0.7,
        matte: { blackClip: 0.03, whiteClip: 0.96 },
      },
      mask: rotoMask,
    };
    expect(validateLayerKeyingAndRoto(layer, "/layers/0")).toEqual([]);
    expect(validateLayerKeyingAndRoto({
      ...layer,
      keying: { ...layer.keying, executable: "plugin.js" },
    }, "/layers/0")).toContainEqual({
      path: "/layers/0/keying/executable",
      message: "is not supported",
    });
  });

  it("participates in complete Motion document validation", async () => {
    const result = await validateDocument(await loadSchema("motion"), {
      schema: "shellx-motion/motion@1",
      id: "keyed-subject",
      name: "Keyed subject",
      durationMs: 1_000,
      fps: 30,
      width: 1_920,
      height: 1_080,
      layers: [{
        id: "subject",
        type: "video",
        source: "assets/subject.mp4",
        startMs: 0,
        durationMs: 1_000,
        keying: { schema: CHROMA_KEY_SCHEMA, keyColor: "#00ff00" },
        mask: rotoMask,
      }],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" },
    });

    expect(result).toEqual({ ok: true });
  });

  it("requires stable vertex identity across frames", () => {
    const changed = structuredClone(rotoMask);
    changed.frames![1].vertices[1].id = "replacement";
    expect(validateLayerKeyingAndRoto({
      type: "video",
      startMs: 0,
      durationMs: 1_000,
      mask: changed,
    }, "/layers/0")).toContainEqual({
      path: "/layers/0/mask/frames/1/vertices",
      message: "every frame must preserve vertex id and order",
    });
  });

  it("interpolates vertices and tangents deterministically", () => {
    const frame = resolveRotoFrame(rotoMask, 500);
    expect(frame.vertices[0].id).toBe("a");
    expect(frame.vertices[0].x).toBeCloseTo(0.15);
    expect(frame.vertices[0].y).toBeCloseTo(0.25);
    expect(frame.vertices[0].outTangent?.x).toBeCloseTo(0.075);
    expect(frame.vertices[0].outTangent?.y).toBe(0);
    expect(rotoFrameSvgPath(frame, 100, 100)).toBe(
      "M 15 25 C 22.5 25 77.5 25 85 25 C 85 25 55 85 55 85 C 55 85 15 25 15 25 Z",
    );
  });
});
