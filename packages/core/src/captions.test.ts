import { describe, expect, it } from "vitest";
import {
  DEFAULT_CAPTION_IDENTIFIER_MAX_LENGTH,
  MAX_CAPTION_LAYER_PREFIX_LENGTH,
  normalizeCaptionIdentifier,
} from "./caption-identifiers";
import type { MotionDocument } from "./types";
import {
  importTimelineCaptions,
  parseCaptionCues,
  upsertTimelineCaption,
} from "./captions";

describe("timeline captions", () => {
  it("parses SRT and VTT cues into normalized caption timing", () => {
    const srt = [
      "1",
      "00:00:00,000 --> 00:00:01,250",
      "Hello world",
      "",
      "2",
      "00:00:01,500 --> 00:00:02,750",
      "Second line",
      "continued"
    ].join("\n");
    const vtt = [
      "WEBVTT",
      "",
      "intro",
      "00:00:03.000 --> 00:00:04.500",
      "VTT caption"
    ].join("\n");

    expect(parseCaptionCues(srt, { format: "srt" })).toEqual([
      { id: "cue_0001", startMs: 0, durationMs: 1250, text: "Hello world" },
      { id: "cue_0002", startMs: 1500, durationMs: 1250, text: "Second line\ncontinued" }
    ]);
    expect(parseCaptionCues(vtt, { format: "vtt" })).toEqual([
      { id: "intro", startMs: 3000, durationMs: 1500, text: "VTT caption" }
    ]);
  });

  it("shares a bounded single-pass identifier normalizer between layer prefixes and named VTT cues", () => {
    expect(normalizeCaptionIdentifier(" \t__Intro / scene!!__\n")).toBe("Intro_scene");
    expect(normalizeCaptionIdentifier("___")).toBe("caption");
    expect(normalizeCaptionIdentifier("a__!__b")).toBe("a_____b");

    const prefix = "p".repeat(MAX_CAPTION_LAYER_PREFIX_LENGTH);
    const imported = importTimelineCaptions(baseMotion(), {
      source: "00:00:00,000 --> 00:00:01,000\nCaption",
      format: "srt",
      layerPrefix: prefix,
    });
    expect(imported.insertedLayerIds).toEqual([`${prefix}_0001`]);
    expect(imported.insertedLayerIds[0]).toHaveLength(DEFAULT_CAPTION_IDENTIFIER_MAX_LENGTH);

    const cueId = "v".repeat(DEFAULT_CAPTION_IDENTIFIER_MAX_LENGTH);
    expect(parseCaptionCues([
      "WEBVTT", "", cueId, "00:00:00.000 --> 00:00:01.000", "Caption",
    ].join("\n"), { format: "vtt" })).toMatchObject([{ id: cueId }]);
  });

  it("rejects over-bound raw identifiers before normalizing them", () => {
    expect(() => normalizeCaptionIdentifier(" ".repeat(DEFAULT_CAPTION_IDENTIFIER_MAX_LENGTH + 1)))
      .toThrow(`at most ${DEFAULT_CAPTION_IDENTIFIER_MAX_LENGTH} code units`);
    expect(() => importTimelineCaptions(baseMotion(), {
      source: "00:00:00,000 --> 00:00:01,000\nCaption",
      format: "srt",
      layerPrefix: "p".repeat(MAX_CAPTION_LAYER_PREFIX_LENGTH + 1),
    })).toThrow(`at most ${MAX_CAPTION_LAYER_PREFIX_LENGTH} code units`);
    expect(() => parseCaptionCues([
      "WEBVTT", "", "v".repeat(DEFAULT_CAPTION_IDENTIFIER_MAX_LENGTH + 1), "00:00:00.000 --> 00:00:01.000", "Caption",
    ].join("\n"), { format: "vtt" })).toThrow(`at most ${DEFAULT_CAPTION_IDENTIFIER_MAX_LENGTH} code units`);
  });

  it("rejects a hostile over-bound identifier without scanning it", () => {
    const hostile = "_".repeat(1_000_000);
    expect(() => normalizeCaptionIdentifier(hostile)).toThrow(`at most ${DEFAULT_CAPTION_IDENTIFIER_MAX_LENGTH} code units`);
  });

  it("imports parsed caption cues as deterministic caption layers on a caption track", () => {
    const motion = baseMotion();
    const result = importTimelineCaptions(motion, {
      source: [
        "1",
        "00:00:00,000 --> 00:00:01,000",
        "First caption",
        "",
        "2",
        "00:00:01,250 --> 00:00:02,500",
        "Second caption"
      ].join("\n"),
      format: "srt",
      trackId: "captions",
      trackName: "Captions",
      layerPrefix: "caption",
      transform: { x: 96, y: 288, width: 448, height: 56 },
      style: { color: "#ffffff", fontSize: 32, textAlign: "center" }
    });

    expect(result).toMatchObject({
      action: "imported",
      cueCount: 2,
      insertedLayerIds: ["caption_0001", "caption_0002"],
      replacedLayerIds: [],
      trackCreated: true,
      changedPaths: expect.arrayContaining(["/tracks/captions", "/layers/caption_0001", "/layers/caption_0002", "/durationMs"])
    });
    expect(result.motion.durationMs).toBe(2500);
    expect(result.motion.tracks).toEqual([
      { id: "captions", type: "caption", name: "Captions", order: 1, layerIds: ["caption_0001", "caption_0002"] }
    ]);
    expect(result.motion.layers).toEqual([
      {
        id: "caption_0001",
        type: "caption",
        text: "First caption",
        trackId: "captions",
        startMs: 0,
        durationMs: 1000,
        transform: { x: 96, y: 288, width: 448, height: 56 },
        style: { color: "#ffffff", fontSize: 32, textAlign: "center" },
        sourceCueId: "cue_0001"
      },
      {
        id: "caption_0002",
        type: "caption",
        text: "Second caption",
        trackId: "captions",
        startMs: 1250,
        durationMs: 1250,
        transform: { x: 96, y: 288, width: 448, height: 56 },
        style: { color: "#ffffff", fontSize: 32, textAlign: "center" },
        sourceCueId: "cue_0002"
      }
    ]);
  });

  it("upserts one caption layer and preserves caption track order", () => {
    const imported = importTimelineCaptions(baseMotion(), {
      source: "00:00:00,000 --> 00:00:01,000\nOriginal caption",
      format: "srt",
      trackId: "captions",
      layerPrefix: "caption"
    });

    const result = upsertTimelineCaption(imported.motion, {
      id: "caption_0001",
      text: "Edited caption",
      startMs: 100,
      durationMs: 900,
      trackId: "captions",
      style: { color: "#ffcc00" }
    });

    expect(result).toMatchObject({
      action: "replaced",
      changedPaths: expect.arrayContaining(["/layers/caption_0001"]),
      previousLayer: { id: "caption_0001", text: "Original caption" },
      layer: {
        id: "caption_0001",
        type: "caption",
        text: "Edited caption",
        trackId: "captions",
        startMs: 100,
        durationMs: 900,
        style: { color: "#ffcc00" }
      },
      trackCreated: false
    });
    expect(result.motion.tracks?.[0].layerIds).toEqual(["caption_0001"]);
  });

  it("moves an existing caption between caption tracks without leaving stale track refs", () => {
    const motion: MotionDocument = {
      ...baseMotion(),
      durationMs: 1000,
      tracks: [
        { id: "captions", type: "caption", name: "Captions", order: 1, layerIds: ["caption_0001"] },
        { id: "localized", type: "caption", name: "Localized", order: 2, layerIds: [] }
      ],
      layers: [
        { id: "caption_0001", type: "caption", text: "Original", trackId: "captions", startMs: 0, durationMs: 1000 }
      ]
    };

    const result = upsertTimelineCaption(motion, {
      id: "caption_0001",
      text: "Localized",
      startMs: 0,
      durationMs: 1000,
      trackId: "localized"
    });

    expect(result.motion.layers[0]).toMatchObject({ id: "caption_0001", trackId: "localized", text: "Localized" });
    expect(result.motion.tracks).toEqual([
      { id: "captions", type: "caption", name: "Captions", order: 1, layerIds: [] },
      { id: "localized", type: "caption", name: "Localized", order: 2, layerIds: ["caption_0001"] }
    ]);
    expect(result.changedPaths).toEqual(expect.arrayContaining([
      "/tracks/captions/layerIds",
      "/tracks/localized/layerIds"
    ]));
  });

  it("rejects replacing locked caption layers through upsert and deterministic imports", () => {
    const motion: MotionDocument = {
      ...baseMotion(),
      durationMs: 1000,
      tracks: [
        { id: "captions", type: "caption", name: "Captions", order: 1, layerIds: ["caption_0001"] }
      ],
      layers: [
        { id: "caption_0001", type: "caption", text: "Locked caption", locked: true, trackId: "captions", startMs: 0, durationMs: 1000 }
      ]
    };

    expect(() => upsertTimelineCaption(motion, {
      id: "caption_0001",
      text: "Edited caption",
      startMs: 0,
      durationMs: 1000,
      trackId: "captions"
    })).toThrow("Cannot edit locked layer: caption_0001.");
    expect(() => importTimelineCaptions(motion, {
      source: "00:00:00,000 --> 00:00:01,000\nImported caption",
      format: "srt",
      trackId: "captions",
      layerPrefix: "caption"
    })).toThrow("Cannot edit locked layer: caption_0001.");
    expect(motion.layers[0]).toMatchObject({ id: "caption_0001", text: "Locked caption", locked: true });
  });

  it("rejects non-caption tracks as caption targets", () => {
    const motion: MotionDocument = {
      ...baseMotion(),
      tracks: [
        { id: "overlay", type: "overlay", name: "Overlay", order: 1, layerIds: [] }
      ],
      layers: []
    };

    expect(() => upsertTimelineCaption(motion, {
      id: "caption_0001",
      text: "Caption",
      startMs: 0,
      durationMs: 1000,
      trackId: "overlay"
    })).toThrow("Track overlay is not a caption track.");
  });

  it("rejects deterministic import ids that collide with non-caption layers", () => {
    const motion: MotionDocument = {
      ...baseMotion(),
      tracks: [
        { id: "overlay", type: "overlay", name: "Overlay", order: 1, layerIds: ["caption_0001"] }
      ],
      layers: [
        { id: "caption_0001", type: "text", text: "Existing title", trackId: "overlay", startMs: 0, durationMs: 1000 }
      ]
    };

    expect(() => importTimelineCaptions(motion, {
      source: "00:00:00,000 --> 00:00:01,000\nImported caption",
      format: "srt",
      trackId: "captions",
      layerPrefix: "caption"
    })).toThrow("Caption layer id collides with non-caption layer: caption_0001.");
    expect(motion.layers[0]).toMatchObject({ id: "caption_0001", type: "text", text: "Existing title" });
  });

  it("rejects caption cues with non-positive duration", () => {
    expect(() => parseCaptionCues("00:00:02,000 --> 00:00:01,000\nBackwards", { format: "srt" }))
      .toThrow("Caption cue end time must be after start time.");
  });
});

function baseMotion(): MotionDocument {
  return {
    schema: "shellx-motion/motion@1",
    id: "motion_caption_core",
    name: "Caption Core",
    durationMs: 1000,
    fps: 30,
    width: 640,
    height: 360,
    layers: [],
    assets: [],
    provenance: { sourceApp: "shellx-motion", createdBy: "test", workflow: "caption-import" }
  };
}
