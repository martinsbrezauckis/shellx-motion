import { describe, expect, it } from "vitest";
import * as timeline from "./timeline";
import { assignLayerTrack, cleanupMotionTimeline, createTimelineLayer, createTimelineScene, createTimelineTrack, deleteLayerKeyframe, deleteLayerTransition, deleteTimelineLayer, deleteTimelineMarker, deleteTimelineScene, deleteTimelineTrack, duplicateTimelineLayer, effectiveLayerAtMs, interpolateNumber, renameTimelineTrack, reorderTimelineScene, reorderTimelineTrack, resizeTimelineScene, resolveEasing, setTimelineLayerBlendMode, setTimelineLayerCrop, setTimelineLayerDucking, setTimelineLayerEffect, setTimelineLayerFit, setTimelineLayerLock, setTimelineLayerMask, setTimelineLayerMediaSource, setTimelineLayerName, setTimelineLayerStyle, setTimelineLayerText, setTimelineLayerTransform, setTimelineLayerVisibility, setTimelineSceneName, setTimelineTrackLock, splitLayerAtMs, timelineLayerLockedTrackId, timelineLayerMutedTrackId, timelineLayerSoloedTrackId, timelineLayerTrackFade, timelineLayerTrackVolume, trimLayerTiming, upsertLayerKeyframe, upsertLayerTransition, upsertTimelineMarker } from "./timeline";
import type { MotionDocument, MotionKeyframe, MotionKeyframeTarget, MotionLayer } from "./types";

describe("Motion timeline interpolation", () => {
  it("upserts timeline markers and scene refs immutably", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      scenes: [{ id: "intro", startMs: 0, durationMs: 1000 }],
      markers: [{ id: "start", atMs: 0, label: "Start", type: "cue" }],
      layers: [],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    const inserted = upsertTimelineMarker(motion, {
      id: "beat",
      atMs: 500,
      durationMs: 120,
      label: "Beat",
      type: "beat",
      color: "#ffcc00",
      sceneId: "intro"
    });
    const replaced = upsertTimelineMarker(inserted.motion, {
      id: "start",
      atMs: 100,
      label: "Cold open",
      type: "cue"
    });

    expect(motion.markers).toEqual([{ id: "start", atMs: 0, label: "Start", type: "cue" }]);
    expect(motion.scenes?.[0]).toEqual({ id: "intro", startMs: 0, durationMs: 1000 });
    expect(inserted).toEqual({
      motion: expect.objectContaining({
        markers: [
          { id: "start", atMs: 0, label: "Start", type: "cue" },
          { id: "beat", atMs: 500, durationMs: 120, label: "Beat", type: "beat", color: "#ffcc00" }
        ],
        scenes: [{ id: "intro", startMs: 0, durationMs: 1000, markerIds: ["beat"] }]
      }),
      changedPath: "/markers/1",
      changedPaths: ["/markers/1", "/scenes/0/markerIds"],
      action: "inserted",
      marker: { id: "beat", atMs: 500, durationMs: 120, label: "Beat", type: "beat", color: "#ffcc00" },
      previousMarker: undefined,
      attachedSceneId: "intro"
    });
    expect(replaced).toEqual({
      motion: expect.objectContaining({
        markers: [
          { id: "start", atMs: 100, label: "Cold open", type: "cue" },
          { id: "beat", atMs: 500, durationMs: 120, label: "Beat", type: "beat", color: "#ffcc00" }
        ]
      }),
      changedPath: "/markers/0",
      changedPaths: ["/markers/0"],
      action: "replaced",
      marker: { id: "start", atMs: 100, label: "Cold open", type: "cue" },
      previousMarker: { id: "start", atMs: 0, label: "Start", type: "cue" },
      attachedSceneId: undefined
    });
  });

  it("deletes timeline markers and prunes stale scene refs", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      scenes: [{ id: "intro", startMs: 0, durationMs: 1000, markerIds: ["start", "beat"] }],
      markers: [
        { id: "start", atMs: 0, label: "Start", type: "cue" },
        { id: "beat", atMs: 500, durationMs: 120, label: "Beat", type: "beat" }
      ],
      layers: [],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    const deleted = deleteTimelineMarker(motion, { id: "beat" });
    const fullyPruned = deleteTimelineMarker(deleted.motion, { id: "start" });

    expect(motion.markers).toHaveLength(2);
    expect(deleted).toEqual({
      motion: expect.objectContaining({
        markers: [{ id: "start", atMs: 0, label: "Start", type: "cue" }],
        scenes: [{ id: "intro", startMs: 0, durationMs: 1000, markerIds: ["start"] }]
      }),
      changedPath: "/markers/1",
      changedPaths: ["/markers/1", "/scenes/0/markerIds"],
      action: "deleted",
      removed: { id: "beat", atMs: 500, durationMs: 120, label: "Beat", type: "beat" },
      remainingCount: 1,
      removedSceneRefs: ["intro"]
    });
    expect(fullyPruned).toMatchObject({
      changedPath: "/markers/0",
      changedPaths: ["/markers/0", "/scenes/0/markerIds"],
      action: "deleted",
      removed: { id: "start", atMs: 0, label: "Start", type: "cue" },
      remainingCount: 0,
      removedSceneRefs: ["intro"]
    });
    expect(fullyPruned.motion.markers).toBeUndefined();
    expect("markers" in fullyPruned.motion).toBe(false);
    expect(fullyPruned.motion.scenes?.[0].markerIds).toBeUndefined();
    expect("markerIds" in fullyPruned.motion.scenes![0]).toBe(false);
  });

  it("rejects invalid timeline marker edits", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      scenes: [{ id: "intro", startMs: 0, durationMs: 1000 }],
      markers: [{ id: "start", atMs: 0 }],
      layers: [],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    expect(() => upsertTimelineMarker(motion, { id: "", atMs: 100 })).toThrow("Marker id is required.");
    expect(() => upsertTimelineMarker(motion, { id: "bad", atMs: -1 })).toThrow("Marker atMs must be a non-negative finite number.");
    expect(() => upsertTimelineMarker(motion, { id: "bad", atMs: 1001 })).toThrow("Marker atMs must fit within document durationMs.");
    expect(() => upsertTimelineMarker(motion, { id: "bad", atMs: 100, durationMs: -1 })).toThrow("Marker durationMs must be a non-negative finite number.");
    expect(() => upsertTimelineMarker(motion, { id: "bad", atMs: 100, sceneId: "missing" })).toThrow("Motion scene not found: missing.");
    expect(() => deleteTimelineMarker(motion, { id: "missing" })).toThrow("Motion marker not found: missing.");
    expect(() => deleteTimelineMarker(motion, { id: "" })).toThrow("Marker id is required.");
  });

  it("resizes timeline scenes with ripple updates for later scenes layers and markers", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      scenes: [
        { id: "intro", startMs: 0, durationMs: 500, markerIds: ["start"] },
        { id: "outro", startMs: 500, durationMs: 500, markerIds: ["outro"] }
      ],
      markers: [
        { id: "start", atMs: 0, label: "Start" },
        { id: "outro", atMs: 500, label: "Outro" },
        { id: "end", atMs: 900, label: "End" }
      ],
      tracks: [
        { id: "overlay", type: "overlay", layerIds: ["intro_title", "outro_title"] }
      ],
      layers: [
        { id: "intro_title", type: "text", trackId: "overlay", startMs: 100, durationMs: 300 },
        { id: "outro_title", type: "text", trackId: "overlay", startMs: 500, durationMs: 300 }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    const resized = resizeTimelineScene(motion, { sceneId: "intro", durationMs: 800, ripple: true });

    expect(motion.scenes?.[0].durationMs).toBe(500);
    expect(resized).toMatchObject({
      action: "resized",
      sceneId: "intro",
      oldDurationMs: 500,
      newDurationMs: 800,
      deltaMs: 300,
      ripple: true,
      shiftedSceneIds: ["outro"],
      shiftedLayerIds: ["outro_title"],
      shiftedMarkerIds: ["outro", "end"],
      changedPaths: [
        "/scenes/intro/durationMs",
        "/scenes/outro/startMs",
        "/layers/outro_title/startMs",
        "/markers/outro/atMs",
        "/markers/end/atMs",
        "/durationMs"
      ]
    });
    expect(resized.motion).toMatchObject({
      durationMs: 1300,
      scenes: [
        { id: "intro", startMs: 0, durationMs: 800 },
        { id: "outro", startMs: 800, durationMs: 500 }
      ],
      markers: [
        { id: "start", atMs: 0 },
        { id: "outro", atMs: 800 },
        { id: "end", atMs: 1200 }
      ],
      layers: [
        { id: "intro_title", startMs: 100, durationMs: 300 },
        { id: "outro_title", startMs: 800, durationMs: 300 }
      ]
    });
  });

  it("resizes timeline scenes without ripple and preserves later timeline positions", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      scenes: [
        { id: "intro", startMs: 0, durationMs: 500 },
        { id: "outro", startMs: 500, durationMs: 500 }
      ],
      markers: [{ id: "outro", atMs: 500 }],
      layers: [
        { id: "outro_title", type: "text", startMs: 500, durationMs: 300 }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    const resized = resizeTimelineScene(motion, { sceneId: "intro", durationMs: 700 });

    expect(resized.motion.scenes).toEqual([
      { id: "intro", startMs: 0, durationMs: 700 },
      { id: "outro", startMs: 500, durationMs: 500 }
    ]);
    expect(resized.motion.markers).toEqual([{ id: "outro", atMs: 500 }]);
    expect(resized.motion.layers[0]).toMatchObject({ id: "outro_title", startMs: 500 });
    expect(resized.motion.durationMs).toBe(1000);
    expect(resized.changedPaths).toEqual(["/scenes/intro/durationMs"]);
  });

  it("keeps duration policy protected regions synced when ripple shifts outro timing", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      scenes: [
        { id: "intro", startMs: 0, durationMs: 200 },
        { id: "middle", startMs: 200, durationMs: 600 },
        { id: "outro", startMs: 800, durationMs: 200 }
      ],
      markers: [{ id: "outro", atMs: 800 }],
      layers: [{ id: "outro_title", type: "text", startMs: 800, durationMs: 200 }],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" },
      "x-shellx-duration-policy": {
        schema: "shellx-motion/duration-policy@1",
        minDurationMs: 800,
        maxDurationMs: 1400,
        resizeMode: "stretch-middle",
        protectedRegions: [
          { id: "intro-lock", role: "intro", startMs: 0, durationMs: 120 },
          { id: "outro-lock", role: "outro", startMs: 800, durationMs: 200 }
        ]
      }
    };

    const resized = resizeTimelineScene(motion, { sceneId: "middle", durationMs: 800, ripple: true });

    expect(resized.motion.durationMs).toBe(1200);
    expect(resized.motion.scenes).toEqual([
      { id: "intro", startMs: 0, durationMs: 200 },
      { id: "middle", startMs: 200, durationMs: 800 },
      { id: "outro", startMs: 1000, durationMs: 200 }
    ]);
    expect(resized.motion.markers).toEqual([{ id: "outro", atMs: 1000 }]);
    expect(resized.motion.layers[0]).toMatchObject({ id: "outro_title", startMs: 1000 });
    expect(resized.motion["x-shellx-duration-policy"]).toMatchObject({
      protectedRegions: [
        { id: "intro-lock", role: "intro", startMs: 0, durationMs: 120 },
        { id: "outro-lock", role: "outro", startMs: 1000, durationMs: 200 }
      ]
    });
    expect(resized.changedPaths).toContain("/x-shellx-duration-policy/protectedRegions/outro-lock/startMs");
  });

  it("rejects scene resize edits that would truncate protected regions or exceed duration policy bounds", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      scenes: [
        { id: "intro", startMs: 0, durationMs: 200 },
        { id: "middle", startMs: 200, durationMs: 600 },
        { id: "outro", startMs: 800, durationMs: 200 }
      ],
      layers: [],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" },
      "x-shellx-duration-policy": {
        schema: "shellx-motion/duration-policy@1",
        minDurationMs: 900,
        maxDurationMs: 1100,
        protectedRegions: [
          { id: "intro-lock", role: "intro", startMs: 0, durationMs: 120 },
          { id: "outro-lock", role: "outro", startMs: 800, durationMs: 200 }
        ]
      }
    };

    expect(() => resizeTimelineScene(motion, { sceneId: "intro", durationMs: 100 })).toThrow("Scene resize would truncate protected region: intro-lock.");
    expect(() => resizeTimelineScene(motion, { sceneId: "middle", durationMs: 800, ripple: true })).toThrow("Scene resize would exceed duration policy maxDurationMs: 1100.");
  });

  it("interpolates shadow component keyframes into nested style objects", () => {
    const layer: MotionLayer = {
      id: "shadow-panel",
      type: "shape",
      shape: "rect",
      startMs: 0,
      durationMs: 1000,
      style: {
        fill: "#ffffff",
        shadow: { x: 0, y: 2, offsetX: 0, offsetY: 2, blur: 0, spread: 0, blurRadius: 0, spreadRadius: 0, color: "#00000000" },
        textShadow: { x: 0, y: 0, offsetX: 0, offsetY: 0, blur: 0, blurRadius: 0, color: "#00000000" }
      },
      keyframes: {
        "style.shadow.x": [
          { atMs: 0, value: 0, easing: "linear" },
          { atMs: 1000, value: 20 }
        ],
        "style.shadow.offsetX": [
          { atMs: 0, value: 0, easing: "linear" },
          { atMs: 1000, value: 24 }
        ],
        "style.shadow.offsetY": [
          { atMs: 0, value: 2, easing: "linear" },
          { atMs: 1000, value: 10 }
        ],
        "style.shadow.blurRadius": [
          { atMs: 0, value: 0, easing: "linear" },
          { atMs: 1000, value: 6 }
        ],
        "style.shadow.spreadRadius": [
          { atMs: 0, value: 0, easing: "linear" },
          { atMs: 1000, value: 8 }
        ],
        "style.shadow.color": [
          { atMs: 0, value: "#00000000", easing: "linear" },
          { atMs: 1000, value: "#000000" }
        ],
        "style.textShadow.blur": [
          { atMs: 0, value: 0, easing: "linear" },
          { atMs: 1000, value: 4 }
        ],
        "style.textShadow.offsetX": [
          { atMs: 0, value: 0, easing: "linear" },
          { atMs: 1000, value: 10 }
        ],
        "style.textShadow.offsetY": [
          { atMs: 0, value: 0, easing: "linear" },
          { atMs: 1000, value: 12 }
        ],
        "style.textShadow.blurRadius": [
          { atMs: 0, value: 0, easing: "linear" },
          { atMs: 1000, value: 6 }
        ],
        "style.textShadow.color": [
          { atMs: 0, value: "transparent", easing: "linear" },
          { atMs: 1000, value: "black" }
        ]
      } as MotionLayer["keyframes"]
    };

    const mid = effectiveLayerAtMs(layer, 500);

    expect(mid.style?.shadow).toEqual({
      x: 10,
      y: 2,
      offsetX: 12,
      offsetY: 6,
      blur: 0,
      spread: 0,
      blurRadius: 3,
      spreadRadius: 4,
      color: "rgba(0, 0, 0, 0.502)"
    });
    expect(mid.style?.textShadow).toEqual({
      x: 0,
      y: 0,
      offsetX: 5,
      offsetY: 6,
      blur: 2,
      blurRadius: 3,
      color: "rgba(0, 0, 0, 0.502)"
    });
  });

  it("holds discrete text alignment keyframes until the next keyframe", () => {
    const layer: MotionLayer = {
      id: "aligned-title",
      type: "text",
      text: "II",
      startMs: 0,
      durationMs: 1000,
      style: { textAlign: "left", verticalAlign: "top", alignY: "top" },
      keyframes: {
        "style.textAlign": [
          { atMs: 0, value: "left", easing: "hold" },
          { atMs: 1000, value: "right" }
        ],
        "style.verticalAlign": [
          { atMs: 0, value: "top", easing: "hold" },
          { atMs: 1000, value: "bottom" }
        ],
        "style.alignY": [
          { atMs: 0, value: "top", easing: "hold" },
          { atMs: 1000, value: "middle" }
        ]
      } as MotionLayer["keyframes"]
    };

    expect(effectiveLayerAtMs(layer, 500).style).toMatchObject({
      textAlign: "left",
      verticalAlign: "top",
      alignY: "top"
    });
    expect(effectiveLayerAtMs(layer, 1000).style).toMatchObject({
      textAlign: "right",
      verticalAlign: "bottom",
      alignY: "middle"
    });
  });

  it("rejects invalid scene resize edits and locked-track ripple moves", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      scenes: [
        { id: "intro", startMs: 0, durationMs: 500 },
        { id: "outro", startMs: 500, durationMs: 500 }
      ],
      tracks: [{ id: "locked", type: "overlay", locked: true, layerIds: ["outro_title"] }],
      layers: [
        { id: "outro_title", type: "text", trackId: "locked", startMs: 500, durationMs: 300 }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    expect(() => resizeTimelineScene(motion, { sceneId: "", durationMs: 700 })).toThrow("Scene id is required.");
    expect(() => resizeTimelineScene(motion, { sceneId: "missing", durationMs: 700 })).toThrow("Motion scene not found: missing.");
    expect(() => resizeTimelineScene(motion, { sceneId: "intro", durationMs: 0 })).toThrow("Scene durationMs must be a positive finite number.");
    expect(() => resizeTimelineScene(motion, { sceneId: "intro", durationMs: Number.NaN })).toThrow("Scene durationMs must be a positive finite number.");
    expect(() => resizeTimelineScene(motion, { sceneId: "intro", durationMs: 800, ripple: true })).toThrow("Ripple would move layer on locked track: locked.");
    expect(() => resizeTimelineScene(motion, { sceneId: "intro", durationMs: 500 })).toThrow("Scene resize did not change duration.");
  });

  it("creates timeline scenes immutably with optional refs and duration evidence", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      scenes: [{ id: "intro", name: "Intro", startMs: 0, durationMs: 500, trackIds: ["overlay"], markerIds: ["start"] }],
      tracks: [{ id: "overlay", type: "overlay", layerIds: ["title"] }],
      markers: [{ id: "start", atMs: 0, label: "Start" }],
      layers: [{ id: "title", type: "text", trackId: "overlay", startMs: 0, durationMs: 500 }],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    const created = createTimelineScene(motion, {
      index: 1,
      scene: {
        id: " outro ",
        name: " Final CTA ",
        startMs: 1000,
        durationMs: 500,
        layerIds: [" title "],
        trackIds: [" overlay "],
        markerIds: [" start "]
      }
    });

    expect(motion.scenes).toHaveLength(1);
    expect(created).toEqual({
      motion: {
        ...motion,
        durationMs: 1500,
        scenes: [
          { id: "intro", name: "Intro", startMs: 0, durationMs: 500, trackIds: ["overlay"], markerIds: ["start"] },
          { id: "outro", name: "Final CTA", startMs: 1000, durationMs: 500, layerIds: ["title"], trackIds: ["overlay"], markerIds: ["start"] }
        ]
      },
      changedPaths: ["/scenes/outro", "/durationMs"],
      action: "created",
      sceneId: "outro",
      index: 1,
      scene: { id: "outro", name: "Final CTA", startMs: 1000, durationMs: 500, layerIds: ["title"], trackIds: ["overlay"], markerIds: ["start"] },
      referencedLayerIds: ["title"],
      referencedTrackIds: ["overlay"],
      referencedMarkerIds: ["start"],
      oldSceneCount: 1,
      newSceneCount: 2,
      oldDurationMs: 1000,
      newDurationMs: 1500,
      durationChanged: true
    });
  });

  it("creates the first timeline scene without extending duration when it fits", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      layers: [],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    const created = createTimelineScene(motion, { scene: { id: "intro", startMs: 0, durationMs: 500 } });

    expect(created.motion.scenes).toEqual([{ id: "intro", startMs: 0, durationMs: 500 }]);
    expect(created.changedPaths).toEqual(["/scenes/intro"]);
    expect(created.oldDurationMs).toBe(1000);
    expect(created.newDurationMs).toBe(1000);
    expect(created.durationChanged).toBe(false);
  });

  it("rejects invalid duplicate and stale-ref timeline scene creates", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      scenes: [{ id: "intro", startMs: 0, durationMs: 1000 }],
      tracks: [{ id: "overlay", type: "overlay" }],
      markers: [{ id: "start", atMs: 0 }],
      layers: [{ id: "title", type: "text", startMs: 0, durationMs: 1000 }],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    expect(() => createTimelineScene(motion, { scene: { id: "", startMs: 0, durationMs: 100 } })).toThrow("Scene id is required.");
    expect(() => createTimelineScene(motion, { scene: { id: "bad", startMs: -1, durationMs: 100 } })).toThrow("Scene startMs must be a non-negative finite number.");
    expect(() => createTimelineScene(motion, { scene: { id: "bad", startMs: 0, durationMs: 0 } })).toThrow("Scene durationMs must be a positive finite number.");
    expect(() => createTimelineScene(motion, { scene: { id: "intro", startMs: 0, durationMs: 100 } })).toThrow("Motion scene id already exists: intro.");
    expect(() => createTimelineScene(motion, { scene: { id: "bad", name: 123 as unknown as string, startMs: 0, durationMs: 100 } })).toThrow("Scene name must be a non-empty string when provided.");
    expect(() => createTimelineScene(motion, { scene: { id: "bad", startMs: 0, durationMs: 100 }, index: -1 })).toThrow("Scene create index must be a non-negative integer within the scene list.");
    expect(() => createTimelineScene(motion, { scene: { id: "bad", startMs: 0, durationMs: 100 }, index: 2 })).toThrow("Scene create index must be a non-negative integer within the scene list.");
    expect(() => createTimelineScene(motion, { scene: { id: "bad", startMs: 0, durationMs: 100, layerIds: ["missing"] } })).toThrow("Motion layer not found: missing.");
    expect(() => createTimelineScene(motion, { scene: { id: "bad", startMs: 0, durationMs: 100, trackIds: ["missing"] } })).toThrow("Motion track not found: missing.");
    expect(() => createTimelineScene(motion, { scene: { id: "bad", startMs: 0, durationMs: 100, markerIds: ["missing"] } })).toThrow("Motion marker not found: missing.");
    expect(() => createTimelineScene(motion, { scene: { id: "bad", startMs: 0, durationMs: 100, layerIds: ["title", "title"] } })).toThrow("Scene layerIds must be unique.");
    expect(() => createTimelineScene(motion, { scene: { id: "bad", startMs: 0, durationMs: 100, trackIds: ["overlay", "overlay"] } })).toThrow("Scene trackIds must be unique.");
    expect(() => createTimelineScene(motion, { scene: { id: "bad", startMs: 0, durationMs: 100, markerIds: ["start", "start"] } })).toThrow("Scene markerIds must be unique.");
  });

  it("deletes timeline scenes immutably without deleting referenced timeline content", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1200,
      fps: 30,
      width: 1280,
      height: 720,
      scenes: [
        { id: "intro", name: "Intro", startMs: 0, durationMs: 500, trackIds: ["overlay"], markerIds: ["start"] },
        { id: "outro", name: "Outro", startMs: 500, durationMs: 700, trackIds: ["overlay"], markerIds: ["outro"] }
      ],
      tracks: [{ id: "overlay", type: "overlay", layerIds: ["title"] }],
      markers: [
        { id: "start", atMs: 0, label: "Start" },
        { id: "outro", atMs: 500, label: "Outro" }
      ],
      layers: [{ id: "title", type: "text", trackId: "overlay", startMs: 0, durationMs: 1200 }],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    const deleted = deleteTimelineScene(motion, { sceneId: " intro " });

    expect(motion.scenes).toHaveLength(2);
    expect(deleted).toEqual({
      motion: {
        ...motion,
        scenes: [
          { id: "outro", name: "Outro", startMs: 500, durationMs: 700, trackIds: ["overlay"], markerIds: ["outro"] }
        ]
      },
      changedPaths: ["/scenes/intro"],
      action: "deleted",
      sceneId: "intro",
      removed: { id: "intro", name: "Intro", startMs: 0, durationMs: 500, trackIds: ["overlay"], markerIds: ["start"] },
      index: 0,
      oldSceneCount: 2,
      newSceneCount: 1,
      oldDurationMs: 1200,
      newDurationMs: 1200,
      durationChanged: false
    });
    expect(deleted.motion.durationMs).toBe(1200);
    expect(deleted.motion.tracks).toEqual(motion.tracks);
    expect(deleted.motion.markers).toEqual(motion.markers);
    expect(deleted.motion.layers).toEqual(motion.layers);
  });

  it("deletes the last timeline scene and removes the optional scenes field", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      scenes: [{ id: "intro", startMs: 0, durationMs: 1000 }],
      layers: [],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    const deleted = deleteTimelineScene(motion, { sceneId: "intro" });

    expect(deleted.changedPaths).toEqual(["/scenes/intro"]);
    expect(deleted.oldSceneCount).toBe(1);
    expect(deleted.newSceneCount).toBe(0);
    expect(deleted.oldDurationMs).toBe(1000);
    expect(deleted.newDurationMs).toBe(1000);
    expect(deleted.durationChanged).toBe(false);
    expect(deleted.motion.scenes).toBeUndefined();
    expect("scenes" in deleted.motion).toBe(false);
    expect(deleted.motion.durationMs).toBe(1000);
  });

  it("rejects invalid timeline scene deletes", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      scenes: [{ id: "intro", startMs: 0, durationMs: 1000 }],
      layers: [],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    expect(() => deleteTimelineScene(motion, { sceneId: "" })).toThrow("Scene id is required.");
    expect(() => deleteTimelineScene(motion, { sceneId: "missing" })).toThrow("Motion scene not found: missing.");
    expect(() => deleteTimelineScene({ ...motion, scenes: undefined }, { sceneId: "intro" })).toThrow("Motion document has no timeline scenes.");
  });

  it("reorders timeline scenes immutably without changing timing or duration", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1200,
      fps: 30,
      width: 1280,
      height: 720,
      scenes: [
        { id: "intro", name: "Intro", startMs: 0, durationMs: 400, trackIds: ["overlay"], markerIds: ["start"] },
        { id: "middle", name: "Middle", startMs: 400, durationMs: 400, trackIds: ["overlay"] },
        { id: "outro", name: "Outro", startMs: 800, durationMs: 400, trackIds: ["overlay"], markerIds: ["end"] }
      ],
      tracks: [{ id: "overlay", type: "overlay", layerIds: ["title"] }],
      markers: [
        { id: "start", atMs: 0, label: "Start" },
        { id: "end", atMs: 1000, label: "End" }
      ],
      layers: [{ id: "title", type: "text", trackId: "overlay", startMs: 0, durationMs: 1200 }],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    const reordered = reorderTimelineScene(motion, { sceneId: " outro ", index: 0 });

    expect(motion.scenes?.map((scene) => scene.id)).toEqual(["intro", "middle", "outro"]);
    expect(reordered).toEqual({
      motion: {
        ...motion,
        scenes: [
          { id: "outro", name: "Outro", startMs: 800, durationMs: 400, trackIds: ["overlay"], markerIds: ["end"] },
          { id: "intro", name: "Intro", startMs: 0, durationMs: 400, trackIds: ["overlay"], markerIds: ["start"] },
          { id: "middle", name: "Middle", startMs: 400, durationMs: 400, trackIds: ["overlay"] }
        ]
      },
      changedPaths: ["/scenes"],
      action: "reordered",
      sceneId: "outro",
      oldIndex: 2,
      newIndex: 0,
      oldSceneOrder: ["intro", "middle", "outro"],
      newSceneOrder: ["outro", "intro", "middle"],
      scene: { id: "outro", name: "Outro", startMs: 800, durationMs: 400, trackIds: ["overlay"], markerIds: ["end"] },
      oldDurationMs: 1200,
      newDurationMs: 1200,
      durationChanged: false
    });
    expect(reordered.motion.tracks).toEqual(motion.tracks);
    expect(reordered.motion.markers).toEqual(motion.markers);
    expect(reordered.motion.layers).toEqual(motion.layers);
  });

  it("rejects invalid timeline scene reorders", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      scenes: [
        { id: "intro", startMs: 0, durationMs: 500 },
        { id: "outro", startMs: 500, durationMs: 500 }
      ],
      layers: [],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    expect(() => reorderTimelineScene(motion, { sceneId: "", index: 0 })).toThrow("Scene id is required.");
    expect(() => reorderTimelineScene({ ...motion, scenes: undefined }, { sceneId: "intro", index: 0 })).toThrow("Motion document has no timeline scenes.");
    expect(() => reorderTimelineScene(motion, { sceneId: "intro", index: -1 })).toThrow("Scene reorder index must be a non-negative integer within the scene list.");
    expect(() => reorderTimelineScene(motion, { sceneId: "intro", index: 2 })).toThrow("Scene reorder index must be a non-negative integer within the scene list.");
    expect(() => reorderTimelineScene(motion, { sceneId: "missing", index: 0 })).toThrow("Motion scene not found: missing.");
    expect(() => reorderTimelineScene(motion, { sceneId: "intro", index: 0 })).toThrow("Scene reorder did not change scene order.");
  });

  it("sets timeline scene display names immutably", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      scenes: [
        { id: "intro", startMs: 0, durationMs: 500, trackIds: ["overlay"], markerIds: ["start"] },
        { id: "outro", name: "Old Outro", startMs: 500, durationMs: 500, trackIds: ["overlay"] }
      ],
      tracks: [{ id: "overlay", type: "overlay", layerIds: ["title"] }],
      markers: [{ id: "start", atMs: 0, label: "Start" }],
      layers: [{ id: "title", type: "text", trackId: "overlay", startMs: 0, durationMs: 500 }],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    const named = setTimelineSceneName(motion, { sceneId: "intro", name: "Cold Open" });
    const renamed = setTimelineSceneName(motion, { sceneId: "outro", name: "Final CTA" });

    expect(motion.scenes?.[0].name).toBeUndefined();
    expect(named).toEqual({
      motion: {
        ...motion,
        scenes: [
          { id: "intro", name: "Cold Open", startMs: 0, durationMs: 500, trackIds: ["overlay"], markerIds: ["start"] },
          { id: "outro", name: "Old Outro", startMs: 500, durationMs: 500, trackIds: ["overlay"] }
        ]
      },
      changedPaths: ["/scenes/intro/name"],
      action: "renamed",
      sceneId: "intro",
      oldName: null,
      newName: "Cold Open",
      scene: { id: "intro", name: "Cold Open", startMs: 0, durationMs: 500, trackIds: ["overlay"], markerIds: ["start"] }
    });
    expect(renamed).toMatchObject({
      changedPaths: ["/scenes/outro/name"],
      action: "renamed",
      sceneId: "outro",
      oldName: "Old Outro",
      newName: "Final CTA",
      scene: { id: "outro", name: "Final CTA", startMs: 500, durationMs: 500, trackIds: ["overlay"] }
    });
  });

  it("rejects invalid and no-op timeline scene name edits", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      scenes: [{ id: "intro", name: "Intro", startMs: 0, durationMs: 1000 }],
      layers: [],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    expect(() => setTimelineSceneName(motion, { sceneId: "", name: "Cold Open" })).toThrow("Scene id is required.");
    expect(() => setTimelineSceneName(motion, { sceneId: "missing", name: "Cold Open" })).toThrow("Motion scene not found: missing.");
    expect(() => setTimelineSceneName(motion, { sceneId: "intro", name: "" })).toThrow("Scene name is required.");
    expect(() => setTimelineSceneName(motion, { sceneId: "intro", name: "   " })).toThrow("Scene name is required.");
    expect(() => setTimelineSceneName(motion, { sceneId: "intro", name: 123 as unknown as string })).toThrow("Scene name is required.");
    expect(() => setTimelineSceneName(motion, { sceneId: "intro", name: "Intro" })).toThrow("Scene name did not change.");
    expect(() => setTimelineSceneName(motion, { sceneId: "intro", name: " Intro " })).toThrow("Scene name did not change.");
  });

  it("creates text timeline layers, inserts track refs, and extends document duration", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 500,
      fps: 30,
      width: 1280,
      height: 720,
      tracks: [{ id: "overlay", type: "overlay", layerIds: ["title"] }],
      layers: [
        { id: "title", type: "text", trackId: "overlay", startMs: 0, durationMs: 500 }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    const created = createTimelineLayer(motion, {
      layer: {
        id: "subtitle",
        type: "text",
        text: "Subtitle",
        trackId: "overlay",
        startMs: 400,
        durationMs: 300,
        style: { color: "#ffffff", fontSize: 24 }
      },
      index: 1,
      trackIndex: 1
    });

    expect(motion.layers.map((layer) => layer.id)).toEqual(["title"]);
    expect(motion.tracks?.[0].layerIds).toEqual(["title"]);
    expect(created).toEqual({
      motion: {
        ...motion,
        durationMs: 700,
        tracks: [{ id: "overlay", type: "overlay", layerIds: ["title", "subtitle"] }],
        layers: [
          { id: "title", type: "text", trackId: "overlay", startMs: 0, durationMs: 500 },
          {
            id: "subtitle",
            type: "text",
            text: "Subtitle",
            trackId: "overlay",
            startMs: 400,
            durationMs: 300,
            style: { color: "#ffffff", fontSize: 24 }
          }
        ]
      },
      changedPaths: ["/layers/subtitle", "/tracks/0/layerIds", "/durationMs"],
      action: "created",
      layerId: "subtitle",
      index: 1,
      trackId: "overlay",
      trackIndex: 1,
      layer: {
        id: "subtitle",
        type: "text",
        text: "Subtitle",
        trackId: "overlay",
        startMs: 400,
        durationMs: 300,
        style: { color: "#ffffff", fontSize: 24 }
      },
      oldLayerCount: 1,
      newLayerCount: 2,
      insertedTrackRefs: ["overlay"]
    });
  });

  it("creates shape timeline layers without track refs when no track is selected", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 500,
      fps: 30,
      width: 1280,
      height: 720,
      layers: [
        { id: "title", type: "text", startMs: 0, durationMs: 500 }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    const created = createTimelineLayer(motion, {
      layer: { id: "badge", type: "shape", shape: "rect", fill: "#00cc88", startMs: 100, durationMs: 200 },
      index: 0
    });

    expect(created.motion.layers).toEqual([
      { id: "badge", type: "shape", shape: "rect", fill: "#00cc88", startMs: 100, durationMs: 200 },
      { id: "title", type: "text", startMs: 0, durationMs: 500 }
    ]);
    expect(created.motion.durationMs).toBe(500);
    expect(created.changedPaths).toEqual(["/layers/badge"]);
    expect(created.insertedTrackRefs).toEqual([]);
  });

  it("rejects invalid duplicate and locked-track timeline layer creates", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 500,
      fps: 30,
      width: 1280,
      height: 720,
      tracks: [{ id: "locked", type: "overlay", locked: true, layerIds: ["title"] }],
      layers: [
        { id: "title", type: "text", trackId: "locked", startMs: 0, durationMs: 500 }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    expect(() => createTimelineLayer(motion, { layer: { id: "", type: "text", startMs: 0, durationMs: 100 } })).toThrow("Layer id is required.");
    expect(() => createTimelineLayer(motion, { layer: { id: "caption", type: "", startMs: 0, durationMs: 100 } })).toThrow("Layer type is required.");
    expect(() => createTimelineLayer(motion, { layer: { id: "caption", type: "text", startMs: -1, durationMs: 100 } })).toThrow("Layer startMs must be a non-negative finite number.");
    expect(() => createTimelineLayer(motion, { layer: { id: "caption", type: "text", startMs: 0, durationMs: 0 } })).toThrow("Layer durationMs must be a positive finite number.");
    expect(() => createTimelineLayer(motion, { layer: { id: "title", type: "text", startMs: 0, durationMs: 100 } })).toThrow("Motion layer id already exists: title.");
    expect(() => createTimelineLayer(motion, { layer: { id: "caption", type: "text", trackId: "missing", startMs: 0, durationMs: 100 } })).toThrow("Motion track not found: missing.");
    expect(() => createTimelineLayer(motion, { layer: { id: "caption", type: "text", trackId: "locked", startMs: 0, durationMs: 100 } })).toThrow("Cannot create layer on locked track: locked.");
    expect(() => createTimelineLayer(motion, { layer: { id: "caption", type: "text", startMs: 0, durationMs: 100 }, index: 3 })).toThrow("Layer create index must be a non-negative integer within the layer stack.");
    expect(() => createTimelineLayer(motion, { layer: { id: "caption", type: "text", trackId: "locked", startMs: 0, durationMs: 100 }, trackIndex: 3 })).toThrow("Layer track index must be a non-negative integer within the track layer refs.");
  });

  it("rejects timeline layer creates when stale track refs already use the new id", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 500,
      fps: 30,
      width: 1280,
      height: 720,
      tracks: [
        { id: "base", type: "overlay", layerIds: ["caption"] },
        { id: "overlay", type: "overlay", layerIds: ["title"] }
      ],
      layers: [
        { id: "title", type: "text", trackId: "overlay", startMs: 0, durationMs: 500 }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    expect(() => createTimelineLayer(motion, {
      layer: { id: "caption", type: "text", trackId: "overlay", startMs: 0, durationMs: 100 },
      trackIndex: 1
    })).toThrow("Motion track already references layer id: caption.");
  });

  it("deletes timeline layers, removes track refs, and recomputes document duration", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      tracks: [{ id: "overlay", type: "overlay", layerIds: ["title", "outro"] }],
      layers: [
        { id: "title", type: "text", trackId: "overlay", startMs: 0, durationMs: 500 },
        { id: "outro", type: "text", trackId: "overlay", startMs: 500, durationMs: 500 }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    const deleted = deleteTimelineLayer(motion, { layerId: "outro" });

    expect(motion.layers.map((layer) => layer.id)).toEqual(["title", "outro"]);
    expect(motion.tracks?.[0].layerIds).toEqual(["title", "outro"]);
    expect(deleted).toEqual({
      motion: {
        ...motion,
        durationMs: 500,
        tracks: [{ id: "overlay", type: "overlay", layerIds: ["title"] }],
        layers: [{ id: "title", type: "text", trackId: "overlay", startMs: 0, durationMs: 500 }]
      },
      changedPaths: ["/layers/outro", "/tracks/0/layerIds", "/durationMs"],
      action: "deleted",
      layerId: "outro",
      removed: { id: "outro", type: "text", trackId: "overlay", startMs: 500, durationMs: 500 },
      remainingCount: 1,
      removedTrackRefs: ["overlay"]
    });
  });

  it("rejects invalid and locked-track timeline layer deletes", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 500,
      fps: 30,
      width: 1280,
      height: 720,
      tracks: [{ id: "locked", type: "overlay", locked: true, layerIds: ["title"] }],
      layers: [
        { id: "title", type: "text", trackId: "locked", startMs: 0, durationMs: 500 }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    expect(() => deleteTimelineLayer(motion, { layerId: "" })).toThrow("Layer id is required.");
    expect(() => deleteTimelineLayer(motion, { layerId: "missing" })).toThrow("Motion layer not found: missing.");
    expect(() => deleteTimelineLayer(motion, { layerId: "title" })).toThrow("Cannot delete layer on locked track: locked.");
  });

  it("duplicates timeline layers with animation, timing offset, track order, and duration recompute", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      tracks: [{ id: "overlay", type: "overlay", layerIds: ["title", "badge"] }],
      layers: [
        {
          id: "title",
          type: "text",
          text: "Title",
          trackId: "overlay",
          startMs: 200,
          durationMs: 500,
          keyframes: { opacity: [{ atMs: 200, value: 0 }, { atMs: 700, value: 1, easing: "ease-out" }] },
          transitions: { in: { type: "fade", durationMs: 120 } }
        },
        { id: "badge", type: "shape", shape: "rect", trackId: "overlay", startMs: 0, durationMs: 1000 }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    const duplicated = duplicateTimelineLayer(motion, { layerId: "title", newLayerId: "title_copy", offsetMs: 350 });

    expect(motion.layers.map((layer) => layer.id)).toEqual(["title", "badge"]);
    expect(motion.tracks?.[0].layerIds).toEqual(["title", "badge"]);
    expect(duplicated).toMatchObject({
      changedPaths: ["/layers/title_copy", "/tracks/0/layerIds", "/durationMs"],
      action: "duplicated",
      layerId: "title",
      newLayerId: "title_copy",
      offsetMs: 350,
      insertedTrackRefs: ["overlay"]
    });
    expect(duplicated.sourceLayer).toEqual(motion.layers[0]);
    expect(duplicated.layer).toEqual({
      ...motion.layers[0],
      id: "title_copy",
      startMs: 550
    });
    expect(duplicated.motion.durationMs).toBe(1050);
    expect(duplicated.motion.layers).toEqual([
      motion.layers[0],
      { ...motion.layers[0], id: "title_copy", startMs: 550 },
      motion.layers[1]
    ]);
    expect(duplicated.motion.tracks?.[0].layerIds).toEqual(["title", "title_copy", "badge"]);
  });

  it("rejects invalid and locked-track timeline layer duplicates", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 500,
      fps: 30,
      width: 1280,
      height: 720,
      tracks: [{ id: "locked", type: "overlay", locked: true, layerIds: ["title"] }],
      layers: [
        { id: "title", type: "text", trackId: "locked", startMs: 0, durationMs: 500 }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    expect(() => duplicateTimelineLayer(motion, { layerId: "" })).toThrow("Layer id is required.");
    expect(() => duplicateTimelineLayer(motion, { layerId: "missing" })).toThrow("Motion layer not found: missing.");
    expect(() => duplicateTimelineLayer(motion, { layerId: "title", offsetMs: -1 })).toThrow("Layer duplicate offsetMs must be a non-negative finite number.");
    expect(() => duplicateTimelineLayer(motion, { layerId: "title", newLayerId: "title" })).toThrow("Motion layer id already exists: title.");
    expect(() => duplicateTimelineLayer(motion, { layerId: "title" })).toThrow("Cannot duplicate layer on locked track: locked.");
  });

  it("reorders timeline layer stack and syncs track layer order", () => {
    const reorderTimelineLayer = (timeline as { reorderTimelineLayer?: (motion: MotionDocument, input: { layerId: string; index: number }) => unknown }).reorderTimelineLayer;
    expect(typeof reorderTimelineLayer).toBe("function");
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      tracks: [
        { id: "base", type: "overlay", layerIds: ["background"] },
        { id: "overlay", type: "overlay", layerIds: ["title", "badge"] }
      ],
      layers: [
        { id: "background", type: "shape", trackId: "base", startMs: 0, durationMs: 1000 },
        { id: "title", type: "text", trackId: "overlay", startMs: 0, durationMs: 1000 },
        { id: "badge", type: "shape", trackId: "overlay", startMs: 0, durationMs: 1000 }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    const reordered = reorderTimelineLayer!(motion, { layerId: "badge", index: 1 });

    expect(motion.layers.map((layer) => layer.id)).toEqual(["background", "title", "badge"]);
    expect(motion.tracks?.[1].layerIds).toEqual(["title", "badge"]);
    expect(reordered).toEqual({
      motion: {
        ...motion,
        tracks: [
          { id: "base", type: "overlay", layerIds: ["background"] },
          { id: "overlay", type: "overlay", layerIds: ["badge", "title"] }
        ],
        layers: [
          { id: "background", type: "shape", trackId: "base", startMs: 0, durationMs: 1000 },
          { id: "badge", type: "shape", trackId: "overlay", startMs: 0, durationMs: 1000 },
          { id: "title", type: "text", trackId: "overlay", startMs: 0, durationMs: 1000 }
        ]
      },
      changedPaths: ["/layers", "/tracks/1/layerIds"],
      action: "reordered",
      layerId: "badge",
      oldIndex: 2,
      newIndex: 1,
      layer: { id: "badge", type: "shape", trackId: "overlay", startMs: 0, durationMs: 1000 },
      reorderedTrackRefs: ["overlay"]
    });
  });

  it("rejects invalid no-op and locked-track layer stack reorders", () => {
    const reorderTimelineLayer = (timeline as { reorderTimelineLayer?: (motion: MotionDocument, input: { layerId: string; index: number }) => unknown }).reorderTimelineLayer;
    expect(typeof reorderTimelineLayer).toBe("function");
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 500,
      fps: 30,
      width: 1280,
      height: 720,
      tracks: [{ id: "locked", type: "overlay", locked: true, layerIds: ["title"] }],
      layers: [
        { id: "title", type: "text", trackId: "locked", startMs: 0, durationMs: 500 },
        { id: "badge", type: "shape", startMs: 0, durationMs: 500 }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    expect(() => reorderTimelineLayer!(motion, { layerId: "", index: 1 })).toThrow("Layer id is required.");
    expect(() => reorderTimelineLayer!(motion, { layerId: "missing", index: 1 })).toThrow("Motion layer not found: missing.");
    expect(() => reorderTimelineLayer!(motion, { layerId: "badge", index: -1 })).toThrow("Layer reorder index must be a non-negative integer within the layer stack.");
    expect(() => reorderTimelineLayer!(motion, { layerId: "badge", index: 2 })).toThrow("Layer reorder index must be a non-negative integer within the layer stack.");
    expect(() => reorderTimelineLayer!(motion, { layerId: "badge", index: 1 })).toThrow("Layer stack order did not change.");
    expect(() => reorderTimelineLayer!(motion, { layerId: "title", index: 1 })).toThrow("Cannot reorder layer on locked track: locked.");
  });

  it("sets timeline layer text immutably", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      layers: [
        { id: "title", type: "text", text: "Old title", startMs: 0, durationMs: 1000 },
        { id: "caption", type: "caption", text: "Caption", startMs: 0, durationMs: 1000 }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    const edited = setTimelineLayerText(motion, { layerId: "title", text: "New title" });
    const blanked = setTimelineLayerText(motion, { layerId: "caption", text: "" });

    expect(motion.layers[0].text).toBe("Old title");
    expect(edited).toEqual({
      motion: {
        ...motion,
        layers: [
          { id: "title", type: "text", text: "New title", startMs: 0, durationMs: 1000 },
          { id: "caption", type: "caption", text: "Caption", startMs: 0, durationMs: 1000 }
        ]
      },
      changedPaths: ["/layers/title/text"],
      action: "updated",
      layerId: "title",
      oldText: "Old title",
      newText: "New title",
      layer: { id: "title", type: "text", text: "New title", startMs: 0, durationMs: 1000 }
    });
    expect(blanked.newText).toBe("");
    expect(blanked.changedPaths).toEqual(["/layers/caption/text"]);
  });

  it("rejects invalid no-op unsupported and locked timeline layer text edits", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      tracks: [{ id: "overlay", type: "overlay", locked: true, layerIds: ["title"] }],
      layers: [
        { id: "title", type: "text", trackId: "overlay", text: "Old title", startMs: 0, durationMs: 1000 },
        { id: "shape", type: "shape", startMs: 0, durationMs: 1000 }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    expect(() => setTimelineLayerText(motion, { layerId: "", text: "New title" })).toThrow("Layer id is required.");
    expect(() => setTimelineLayerText(motion, { layerId: "missing", text: "New title" })).toThrow("Motion layer not found: missing.");
    expect(() => setTimelineLayerText(motion, { layerId: "shape", text: "New title" })).toThrow("Layer type does not support text: shape.");
    expect(() => setTimelineLayerText(motion, { layerId: "title", text: "New title" })).toThrow("Cannot edit layer text on locked track: overlay.");
    expect(() => setTimelineLayerText({ ...motion, tracks: undefined }, { layerId: "title", text: "Old title" })).toThrow("Layer text did not change.");
  });

  it("sets timeline layer style immutably", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      layers: [
        { id: "title", type: "text", text: "Old title", startMs: 0, durationMs: 1000, style: { color: "#ffffff", fontSize: 24 } },
        { id: "shape", type: "shape", startMs: 0, durationMs: 1000, style: { fill: "#101828" } }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    const colorEdit = setTimelineLayerStyle(motion, { layerId: "title", property: "color", value: "#13d3ff" });
    const sizeEdit = setTimelineLayerStyle(motion, { layerId: "title", property: "fontSize", value: 36 });
    const fillEdit = setTimelineLayerStyle(motion, { layerId: "shape", property: "fill", value: "#0f172a" });

    expect(motion.layers[0].style).toEqual({ color: "#ffffff", fontSize: 24 });
    expect(colorEdit).toEqual({
      motion: {
        ...motion,
        layers: [
          { id: "title", type: "text", text: "Old title", startMs: 0, durationMs: 1000, style: { color: "#13d3ff", fontSize: 24 } },
          { id: "shape", type: "shape", startMs: 0, durationMs: 1000, style: { fill: "#101828" } }
        ]
      },
      changedPaths: ["/layers/title/style/color"],
      action: "updated",
      layerId: "title",
      property: "color",
      oldValue: "#ffffff",
      newValue: "#13d3ff",
      layer: { id: "title", type: "text", text: "Old title", startMs: 0, durationMs: 1000, style: { color: "#13d3ff", fontSize: 24 } }
    });
    expect(sizeEdit).toMatchObject({
      changedPaths: ["/layers/title/style/fontSize"],
      property: "fontSize",
      oldValue: 24,
      newValue: 36
    });
    expect(fillEdit).toMatchObject({
      changedPaths: ["/layers/shape/style/fill"],
      property: "fill",
      oldValue: "#101828",
      newValue: "#0f172a"
    });
  });

  it("sets tokenized and row-placeholder timeline layer style values", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      designTokens: { color: { accent: "#13d3ff" }, radius: { badge: 8 } },
      layers: [
        { id: "title", type: "text", text: "Old title", startMs: 0, durationMs: 1000, style: { color: "#ffffff", width: 520 } },
        { id: "badge", type: "shape", startMs: 0, durationMs: 1000, style: { radius: 4 } }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    const tokenColor = setTimelineLayerStyle(motion, { layerId: "title", property: "color", value: "{color.accent}" });
    const rowColor = setTimelineLayerStyle(tokenColor.motion, { layerId: "title", property: "style.color", value: "{{accent}}" });
    const tokenRadius = setTimelineLayerStyle(motion, { layerId: "badge", property: "radius", value: "{radius.badge}" });
    const rowWidth = setTimelineLayerStyle(motion, { layerId: "title", property: "width", value: "{{variant.titleWidth}}" });

    expect(tokenColor).toMatchObject({
      changedPaths: ["/layers/title/style/color"],
      property: "color",
      oldValue: "#ffffff",
      newValue: "{color.accent}"
    });
    expect(rowColor).toMatchObject({
      property: "color",
      oldValue: "{color.accent}",
      newValue: "{{accent}}"
    });
    expect(tokenRadius).toMatchObject({
      changedPaths: ["/layers/badge/style/radius"],
      property: "radius",
      oldValue: 4,
      newValue: "{radius.badge}"
    });
    expect(rowWidth).toMatchObject({
      changedPaths: ["/layers/title/style/width"],
      property: "width",
      oldValue: 520,
      newValue: "{{variant.titleWidth}}"
    });
  });

  it("deep-clones existing layer style state when setting a top-level style value", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      layers: [
        { id: "shape", type: "shape", startMs: 0, durationMs: 1000, style: { fill: "#101828", shadow: { x: 1, y: 2, color: "#000000" } } }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    const edited = setTimelineLayerStyle(motion, { layerId: "shape", property: "fill", value: "#13d3ff" });
    const originalShadow = motion.layers[0].style?.shadow as Record<string, unknown>;
    const editedShadow = edited.layer.style?.shadow as Record<string, unknown>;

    expect(edited.layer.style).not.toBe(motion.layers[0].style);
    expect(editedShadow).toEqual({ x: 1, y: 2, color: "#000000" });
    expect(editedShadow).not.toBe(originalShadow);
    editedShadow.x = 99;
    expect(originalShadow.x).toBe(1);
  });

  it("rejects invalid no-op unsupported and locked timeline layer style edits", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      tracks: [{ id: "overlay", type: "overlay", locked: true, layerIds: ["title"] }],
      layers: [
        { id: "title", type: "text", trackId: "overlay", text: "Old title", startMs: 0, durationMs: 1000, style: { color: "#ffffff", fontSize: 24 } },
        { id: "shape", type: "shape", startMs: 0, durationMs: 1000 }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    expect(() => setTimelineLayerStyle(motion, { layerId: "", property: "color", value: "#13d3ff" })).toThrow("Layer id is required.");
    expect(() => setTimelineLayerStyle(motion, { layerId: "missing", property: "color", value: "#13d3ff" })).toThrow("Motion layer not found: missing.");
    expect(() => setTimelineLayerStyle(motion, { layerId: "shape", property: "", value: "#13d3ff" })).toThrow("Style property is required.");
    expect(() => setTimelineLayerStyle(motion, { layerId: "shape", property: "shadow.color", value: "#13d3ff" })).toThrow("Unsupported layer style property: shadow.color.");
    expect(() => setTimelineLayerStyle(motion, { layerId: "shape", property: "color", value: "not-a-color" })).toThrow("Layer style color must be a supported color string.");
    expect(() => setTimelineLayerStyle(motion, { layerId: "shape", property: "color", value: "#12345" })).toThrow("Layer style color must be a supported color string.");
    expect(() => setTimelineLayerStyle(motion, { layerId: "shape", property: "fontSize", value: 0 })).toThrow("Layer style fontSize must be a positive finite number.");
    expect(() => setTimelineLayerStyle(motion, { layerId: "title", property: "color", value: "#13d3ff" })).toThrow("Cannot edit layer style on locked track: overlay.");
    expect(() => setTimelineLayerStyle({ ...motion, tracks: undefined }, { layerId: "title", property: "style.color", value: "#ffffff" })).toThrow("Layer style color did not change.");
  });

  it("sets timeline layer transform immutably", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      layers: [
        { id: "title", type: "text", text: "Old title", startMs: 0, durationMs: 1000, opacity: 1, transform: { x: 10, y: 20, width: 320, height: 90, scale: 1, rotation: 0 } },
        { id: "shape", type: "shape", startMs: 0, durationMs: 1000, transform: { x: 0 } }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    const xEdit = setTimelineLayerTransform(motion, { layerId: "title", property: "x", value: 120 });
    const widthEdit = setTimelineLayerTransform(motion, { layerId: "title", property: "width", value: 640 });
    const scaleEdit = setTimelineLayerTransform(motion, { layerId: "title", property: "scale", value: 1.25 });
    const opacityEdit = setTimelineLayerTransform(motion, { layerId: "title", property: "opacity", value: 0.5 });

    expect(motion.layers[0]).toMatchObject({ opacity: 1, transform: { x: 10, y: 20, width: 320, height: 90, scale: 1, rotation: 0 } });
    expect(xEdit).toEqual({
      motion: {
        ...motion,
        layers: [
          { id: "title", type: "text", text: "Old title", startMs: 0, durationMs: 1000, opacity: 1, transform: { x: 120, y: 20, width: 320, height: 90, scale: 1, rotation: 0 } },
          { id: "shape", type: "shape", startMs: 0, durationMs: 1000, transform: { x: 0 } }
        ]
      },
      changedPaths: ["/layers/title/transform/x"],
      action: "updated",
      layerId: "title",
      property: "x",
      oldValue: 10,
      newValue: 120,
      layer: { id: "title", type: "text", text: "Old title", startMs: 0, durationMs: 1000, opacity: 1, transform: { x: 120, y: 20, width: 320, height: 90, scale: 1, rotation: 0 } }
    });
    expect(widthEdit).toMatchObject({
      changedPaths: ["/layers/title/transform/width"],
      property: "width",
      oldValue: 320,
      newValue: 640
    });
    expect(scaleEdit).toMatchObject({
      changedPaths: ["/layers/title/transform/scale"],
      property: "scale",
      oldValue: 1,
      newValue: 1.25
    });
    expect(opacityEdit).toMatchObject({
      changedPaths: ["/layers/title/opacity"],
      property: "opacity",
      oldValue: 1,
      newValue: 0.5
    });
  });

  it("sets every supported numeric timeline layer transform property", () => {
    const baseMotion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      layers: [
        {
          id: "title",
          type: "text",
          text: "Old title",
          startMs: 0,
          durationMs: 1000,
          opacity: 1,
          transform: { x: 10, y: 20, width: 320, height: 90, scale: 1, rotation: 0, originX: 0, originY: 0 }
        }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };
    const cases: Array<{ property: string; value: number; path: string; oldValue: number }> = [
      { property: "x", value: 120, path: "/layers/title/transform/x", oldValue: 10 },
      { property: "y", value: 140, path: "/layers/title/transform/y", oldValue: 20 },
      { property: "width", value: 640, path: "/layers/title/transform/width", oldValue: 320 },
      { property: "height", value: 180, path: "/layers/title/transform/height", oldValue: 90 },
      { property: "scale", value: 1.25, path: "/layers/title/transform/scale", oldValue: 1 },
      { property: "rotation", value: 15, path: "/layers/title/transform/rotation", oldValue: 0 },
      { property: "originX", value: 0.5, path: "/layers/title/transform/originX", oldValue: 0 },
      { property: "originY", value: 0.5, path: "/layers/title/transform/originY", oldValue: 0 },
      { property: "opacity", value: 0.5, path: "/layers/title/opacity", oldValue: 1 }
    ];

    for (const item of cases) {
      const edited = setTimelineLayerTransform(baseMotion, { layerId: "title", property: item.property, value: item.value });
      expect(edited).toMatchObject({
        changedPaths: [item.path],
        property: item.property,
        oldValue: item.oldValue,
        newValue: item.value
      });
    }
  });

  it("canonicalizes legacy transform opacity to root layer opacity", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      layers: [
        { id: "title", type: "text", text: "Old title", startMs: 0, durationMs: 1000, transform: { x: 10, opacity: 0.5 } },
        { id: "badge", type: "shape", startMs: 0, durationMs: 1000, opacity: 0.5, transform: { opacity: 0.25 } }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    const canonicalized = setTimelineLayerTransform(motion, { layerId: "title", property: "opacity", value: 0.5 });
    const staleRemoved = setTimelineLayerTransform(motion, { layerId: "badge", property: "opacity", value: 0.5 });

    expect(canonicalized).toMatchObject({
      changedPaths: ["/layers/title/opacity", "/layers/title/transform/opacity"],
      property: "opacity",
      oldValue: 0.5,
      newValue: 0.5,
      layer: { id: "title", opacity: 0.5, transform: { x: 10 } }
    });
    expect(canonicalized.layer.transform).toEqual({ x: 10 });
    expect(staleRemoved).toMatchObject({
      changedPaths: ["/layers/badge/transform/opacity"],
      property: "opacity",
      oldValue: 0.5,
      newValue: 0.5,
      layer: { id: "badge", opacity: 0.5 }
    });
    expect(staleRemoved.layer.transform).toBeUndefined();
  });

  it("rejects invalid no-op unsupported and locked timeline layer transform edits", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      tracks: [{ id: "overlay", type: "overlay", locked: true, layerIds: ["title"] }],
      layers: [
        { id: "title", type: "text", trackId: "overlay", text: "Old title", startMs: 0, durationMs: 1000, opacity: 1, transform: { x: 10, width: 320, scale: 1 } },
        { id: "shape", type: "shape", startMs: 0, durationMs: 1000, transform: { x: 0 } }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    expect(() => setTimelineLayerTransform(motion, { layerId: "", property: "x", value: 12 })).toThrow("Layer id is required.");
    expect(() => setTimelineLayerTransform(motion, { layerId: "missing", property: "x", value: 12 })).toThrow("Motion layer not found: missing.");
    expect(() => setTimelineLayerTransform(motion, { layerId: "shape", property: "", value: 12 })).toThrow("Transform property is required.");
    expect(() => setTimelineLayerTransform(motion, { layerId: "shape", property: "skew.x", value: 12 })).toThrow("Unsupported layer transform property: skew.x.");
    expect(() => setTimelineLayerTransform(motion, { layerId: "shape", property: "x", value: "{spacing.left}" })).toThrow("Layer transform x must be a finite number.");
    expect(() => setTimelineLayerTransform(motion, { layerId: "shape", property: "width", value: "{{variant.titleWidth}}" })).toThrow("Layer transform width must be a non-negative finite number.");
    expect(() => setTimelineLayerTransform(motion, { layerId: "shape", property: "width", value: -1 })).toThrow("Layer transform width must be a non-negative finite number.");
    expect(() => setTimelineLayerTransform(motion, { layerId: "shape", property: "scale", value: 0 })).toThrow("Layer transform scale must be a positive finite number.");
    expect(() => setTimelineLayerTransform(motion, { layerId: "shape", property: "opacity", value: 2 })).toThrow("Layer transform opacity must be a finite number between 0 and 1.");
    expect(() => setTimelineLayerTransform(motion, { layerId: "title", property: "x", value: 20 })).toThrow("Cannot edit layer transform on locked track: overlay.");
    expect(() => setTimelineLayerTransform({ ...motion, tracks: undefined }, { layerId: "title", property: "transform.x", value: 10 })).toThrow("Layer transform x did not change.");
  });

  it("sets timeline layer effects immutably", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      layers: [
        { id: "title", type: "text", text: "Old title", startMs: 0, durationMs: 1000, effects: { blur: 2, brightness: 1 } },
        { id: "shape", type: "shape", startMs: 0, durationMs: 1000 }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    const blurEdit = setTimelineLayerEffect(motion, { layerId: "title", property: "blur", value: 8 });
    const contrastEdit = setTimelineLayerEffect(motion, { layerId: "shape", property: "contrast", value: 1.2 });

    expect(motion.layers[0].effects).toEqual({ blur: 2, brightness: 1 });
    expect(blurEdit).toEqual({
      motion: {
        ...motion,
        layers: [
          { id: "title", type: "text", text: "Old title", startMs: 0, durationMs: 1000, effects: { blur: 8, brightness: 1 } },
          { id: "shape", type: "shape", startMs: 0, durationMs: 1000 }
        ]
      },
      changedPaths: ["/layers/title/effects/blur"],
      action: "updated",
      layerId: "title",
      property: "blur",
      oldValue: 2,
      newValue: 8,
      layer: { id: "title", type: "text", text: "Old title", startMs: 0, durationMs: 1000, effects: { blur: 8, brightness: 1 } }
    });
    expect(contrastEdit).toMatchObject({
      changedPaths: ["/layers/shape/effects/contrast"],
      property: "contrast",
      oldValue: null,
      newValue: 1.2
    });
  });

  it("sets every supported numeric timeline layer effect property", () => {
    const baseMotion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      layers: [
        {
          id: "title",
          type: "text",
          text: "Old title",
          startMs: 0,
          durationMs: 1000,
          effects: { blur: 2, brightness: 1, contrast: 1, saturate: 1, grayscale: 0 }
        }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };
    const cases: Array<{ property: string; value: number; path: string; oldValue: number }> = [
      { property: "blur", value: 8, path: "/layers/title/effects/blur", oldValue: 2 },
      { property: "brightness", value: 1.2, path: "/layers/title/effects/brightness", oldValue: 1 },
      { property: "contrast", value: 1.3, path: "/layers/title/effects/contrast", oldValue: 1 },
      { property: "saturate", value: 1.4, path: "/layers/title/effects/saturate", oldValue: 1 },
      { property: "grayscale", value: 0.6, path: "/layers/title/effects/grayscale", oldValue: 0 }
    ];

    for (const item of cases) {
      const edited = setTimelineLayerEffect(baseMotion, { layerId: "title", property: item.property, value: item.value });
      expect(edited).toMatchObject({
        changedPaths: [item.path],
        property: item.property,
        oldValue: item.oldValue,
        newValue: item.value
      });
    }
  });

  it("rejects invalid no-op unsupported and locked timeline layer effect edits", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      tracks: [{ id: "overlay", type: "overlay", locked: true, layerIds: ["title"] }],
      layers: [
        { id: "title", type: "text", trackId: "overlay", text: "Old title", startMs: 0, durationMs: 1000, effects: { blur: 2 } },
        { id: "shape", type: "shape", startMs: 0, durationMs: 1000, effects: { blur: 0 } }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    expect(() => setTimelineLayerEffect(motion, { layerId: "", property: "blur", value: 4 })).toThrow("Layer id is required.");
    expect(() => setTimelineLayerEffect(motion, { layerId: "missing", property: "blur", value: 4 })).toThrow("Motion layer not found: missing.");
    expect(() => setTimelineLayerEffect(motion, { layerId: "shape", property: "", value: 4 })).toThrow("Effect property is required.");
    expect(() => setTimelineLayerEffect(motion, { layerId: "shape", property: "shadow.blur", value: 4 })).toThrow("Unsupported layer effect property: shadow.blur.");
    expect(() => setTimelineLayerEffect(motion, { layerId: "shape", property: "blur", value: "{effect.blur}" })).toThrow("Layer effect blur must be a non-negative finite number.");
    expect(() => setTimelineLayerEffect(motion, { layerId: "shape", property: "blur", value: -1 })).toThrow("Layer effect blur must be a non-negative finite number.");
    expect(() => setTimelineLayerEffect(motion, { layerId: "title", property: "blur", value: 4 })).toThrow("Cannot edit layer effect on locked track: overlay.");
    expect(() => setTimelineLayerEffect({ ...motion, tracks: undefined }, { layerId: "shape", property: "effects.blur", value: 0 })).toThrow("Layer effect blur did not change.");
  });

  it("sets timeline layer blend mode immutably", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      layers: [
        { id: "title", type: "text", text: "Old title", startMs: 0, durationMs: 1000, blendMode: "normal" },
        { id: "shape", type: "shape", startMs: 0, durationMs: 1000 }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    const multiplyEdit = setTimelineLayerBlendMode(motion, { layerId: "title", blendMode: "multiply" });
    const screenEdit = setTimelineLayerBlendMode(motion, { layerId: "shape", blendMode: "screen" });

    expect(motion.layers[0].blendMode).toBe("normal");
    expect(multiplyEdit).toEqual({
      motion: {
        ...motion,
        layers: [
          { id: "title", type: "text", text: "Old title", startMs: 0, durationMs: 1000, blendMode: "multiply" },
          { id: "shape", type: "shape", startMs: 0, durationMs: 1000 }
        ]
      },
      changedPaths: ["/layers/title/blendMode"],
      action: "updated",
      layerId: "title",
      oldBlendMode: "normal",
      newBlendMode: "multiply",
      layer: { id: "title", type: "text", text: "Old title", startMs: 0, durationMs: 1000, blendMode: "multiply" }
    });
    expect(screenEdit).toMatchObject({
      changedPaths: ["/layers/shape/blendMode"],
      oldBlendMode: null,
      newBlendMode: "screen"
    });
  });

  it("sets every supported timeline layer blend mode", () => {
    const baseMotion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      layers: [
        { id: "title", type: "text", text: "Old title", startMs: 0, durationMs: 1000, blendMode: "normal" }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };
    const modes = ["multiply", "screen", "overlay", "darken", "lighten", "color-dodge", "color-burn", "hard-light", "soft-light", "difference", "exclusion", "hue", "saturation", "color", "luminosity", "plus-lighter"];

    for (const blendMode of modes) {
      const edited = setTimelineLayerBlendMode(baseMotion, { layerId: "title", blendMode });
      expect(edited).toMatchObject({
        changedPaths: ["/layers/title/blendMode"],
        oldBlendMode: "normal",
        newBlendMode: blendMode
      });
    }
  });

  it("rejects invalid no-op unsupported and locked timeline layer blend edits", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      tracks: [{ id: "overlay", type: "overlay", locked: true, layerIds: ["title"] }],
      layers: [
        { id: "title", type: "text", trackId: "overlay", text: "Old title", startMs: 0, durationMs: 1000, blendMode: "normal" },
        { id: "shape", type: "shape", startMs: 0, durationMs: 1000, blendMode: "screen" }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    expect(() => setTimelineLayerBlendMode(motion, { layerId: "", blendMode: "multiply" })).toThrow("Layer id is required.");
    expect(() => setTimelineLayerBlendMode(motion, { layerId: "missing", blendMode: "multiply" })).toThrow("Motion layer not found: missing.");
    expect(() => setTimelineLayerBlendMode(motion, { layerId: "shape", blendMode: "" })).toThrow("Layer blend mode is required.");
    expect(() => setTimelineLayerBlendMode(motion, { layerId: "shape", blendMode: "{blend.mode}" })).toThrow("Layer blend mode must be a supported blend mode.");
    expect(() => setTimelineLayerBlendMode(motion, { layerId: "shape", blendMode: "scripted-composite" })).toThrow("Layer blend mode must be a supported blend mode.");
    expect(() => setTimelineLayerBlendMode(motion, { layerId: "title", blendMode: "multiply" })).toThrow("Cannot edit layer blend mode on locked track: overlay.");
    expect(() => setTimelineLayerBlendMode({ ...motion, tracks: undefined }, { layerId: "shape", blendMode: "screen" })).toThrow("Layer blend mode did not change.");
  });

  it("sets timeline layer source crop immutably", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      layers: [
        { id: "product", type: "image", source: "assets/product.png", startMs: 0, durationMs: 1000, crop: { x: 0, y: 0, width: 320, height: 180 } },
        { id: "clip", type: "video", source: "assets/clip.mp4", startMs: 0, durationMs: 1000 }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    const imageEdit = setTimelineLayerCrop(motion, { layerId: "product", crop: { x: 10, y: 20, width: 200, height: 120 } });
    const videoEdit = setTimelineLayerCrop(motion, { layerId: "clip", crop: { x: 8, y: 4, width: 128, height: 72 } });

    expect(motion.layers[0].crop).toEqual({ x: 0, y: 0, width: 320, height: 180 });
    expect(imageEdit).toEqual({
      motion: {
        ...motion,
        layers: [
          { id: "product", type: "image", source: "assets/product.png", startMs: 0, durationMs: 1000, crop: { x: 10, y: 20, width: 200, height: 120 } },
          { id: "clip", type: "video", source: "assets/clip.mp4", startMs: 0, durationMs: 1000 }
        ]
      },
      changedPaths: ["/layers/product/crop/x", "/layers/product/crop/y", "/layers/product/crop/width", "/layers/product/crop/height"],
      action: "updated",
      layerId: "product",
      oldCrop: { x: 0, y: 0, width: 320, height: 180 },
      newCrop: { x: 10, y: 20, width: 200, height: 120 },
      layer: { id: "product", type: "image", source: "assets/product.png", startMs: 0, durationMs: 1000, crop: { x: 10, y: 20, width: 200, height: 120 } }
    });
    expect(videoEdit).toMatchObject({
      changedPaths: ["/layers/clip/crop/x", "/layers/clip/crop/y", "/layers/clip/crop/width", "/layers/clip/crop/height"],
      oldCrop: null,
      newCrop: { x: 8, y: 4, width: 128, height: 72 }
    });
  });

  it("only reports changed timeline layer source crop fields", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      layers: [
        { id: "product", type: "image", source: "assets/product.png", startMs: 0, durationMs: 1000, crop: { x: 0, y: 0, width: 320, height: 180 } }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    const edited = setTimelineLayerCrop(motion, { layerId: "product", crop: { x: 12, y: 0, width: 320, height: 90 } });

    expect(edited).toMatchObject({
      changedPaths: ["/layers/product/crop/x", "/layers/product/crop/height"],
      oldCrop: { x: 0, y: 0, width: 320, height: 180 },
      newCrop: { x: 12, y: 0, width: 320, height: 90 }
    });
  });

  it("rejects invalid no-op unsupported and locked timeline layer crop edits", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      tracks: [{ id: "media", type: "video", locked: true, layerIds: ["clip"] }],
      layers: [
        { id: "clip", type: "video", trackId: "media", source: "assets/clip.mp4", startMs: 0, durationMs: 1000, crop: { x: 0, y: 0, width: 320, height: 180 } },
        { id: "product", type: "image", source: "assets/product.png", startMs: 0, durationMs: 1000, crop: { x: 0, y: 0, width: 320, height: 180 } },
        { id: "title", type: "text", text: "No crop", startMs: 0, durationMs: 1000 }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    expect(() => setTimelineLayerCrop(motion, { layerId: "", crop: { x: 0, y: 0, width: 1, height: 1 } })).toThrow("Layer id is required.");
    expect(() => setTimelineLayerCrop(motion, { layerId: "missing", crop: { x: 0, y: 0, width: 1, height: 1 } })).toThrow("Motion layer not found: missing.");
    expect(() => setTimelineLayerCrop(motion, { layerId: "title", crop: { x: 0, y: 0, width: 1, height: 1 } })).toThrow("Layer type does not support crop: text.");
    expect(() => setTimelineLayerCrop(motion, { layerId: "product", crop: { x: "{crop.x}", y: 0, width: 1, height: 1 } })).toThrow("Layer crop x must be a non-negative finite number.");
    expect(() => setTimelineLayerCrop(motion, { layerId: "product", crop: { x: -1, y: 0, width: 1, height: 1 } })).toThrow("Layer crop x must be a non-negative finite number.");
    expect(() => setTimelineLayerCrop(motion, { layerId: "product", crop: { x: 0, y: 0, width: 0, height: 1 } })).toThrow("Layer crop width must be a positive finite number.");
    expect(() => setTimelineLayerCrop(motion, { layerId: "clip", crop: { x: 1, y: 0, width: 320, height: 180 } })).toThrow("Cannot edit layer crop on locked track: media.");
    expect(() => setTimelineLayerCrop(motion, { layerId: "product", crop: { x: 0, y: 0, width: 320, height: 180 } })).toThrow("Layer crop did not change.");
  });

  it("sets timeline layer masks immutably", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      layers: [
        { id: "shape", type: "shape", shape: "rect", startMs: 0, durationMs: 1000, mask: { type: "rect", inset: { top: 0, right: 0, bottom: 0, left: 0 } } },
        { id: "clip", type: "video", source: "assets/clip.mp4", startMs: 0, durationMs: 1000 }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    const shapeEdit = setTimelineLayerMask(motion, { layerId: "shape", mask: { type: "rounded-rect", inset: { top: 4, right: 8, bottom: 4, left: 8 }, radius: 12 } });
    const videoEdit = setTimelineLayerMask(motion, { layerId: "clip", mask: { type: "rect", inset: { top: 2, left: 3 } } });

    expect(motion.layers[0].mask).toEqual({ type: "rect", inset: { top: 0, right: 0, bottom: 0, left: 0 } });
    expect(shapeEdit).toEqual({
      motion: {
        ...motion,
        layers: [
          { id: "shape", type: "shape", shape: "rect", startMs: 0, durationMs: 1000, mask: { type: "rounded-rect", inset: { top: 4, right: 8, bottom: 4, left: 8 }, radius: 12 } },
          { id: "clip", type: "video", source: "assets/clip.mp4", startMs: 0, durationMs: 1000 }
        ]
      },
      changedPaths: ["/layers/shape/mask/type", "/layers/shape/mask/inset/top", "/layers/shape/mask/inset/right", "/layers/shape/mask/inset/bottom", "/layers/shape/mask/inset/left", "/layers/shape/mask/radius"],
      action: "updated",
      layerId: "shape",
      oldMask: { type: "rect", inset: { top: 0, right: 0, bottom: 0, left: 0 } },
      newMask: { type: "rounded-rect", inset: { top: 4, right: 8, bottom: 4, left: 8 }, radius: 12 },
      layer: { id: "shape", type: "shape", shape: "rect", startMs: 0, durationMs: 1000, mask: { type: "rounded-rect", inset: { top: 4, right: 8, bottom: 4, left: 8 }, radius: 12 } }
    });
    expect(videoEdit).toMatchObject({
      changedPaths: ["/layers/clip/mask/type", "/layers/clip/mask/inset/top", "/layers/clip/mask/inset/left"],
      oldMask: null,
      newMask: { type: "rect", inset: { top: 2, left: 3 } }
    });
  });

  it("reports changed timeline layer mask fields including removed optional fields", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      layers: [
        { id: "shape", type: "shape", shape: "rect", startMs: 0, durationMs: 1000, mask: { type: "rounded-rect", inset: { top: 4, right: 8, bottom: 4, left: 8 }, radius: 12 } }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    const edited = setTimelineLayerMask(motion, { layerId: "shape", mask: { type: "rounded-rect", inset: { top: 6, right: 8, bottom: 4, left: 8 } } });

    expect(edited).toMatchObject({
      changedPaths: ["/layers/shape/mask/inset/top", "/layers/shape/mask/radius"],
      oldMask: { type: "rounded-rect", inset: { top: 4, right: 8, bottom: 4, left: 8 }, radius: 12 },
      newMask: { type: "rounded-rect", inset: { top: 6, right: 8, bottom: 4, left: 8 } }
    });
  });

  it("sets bounded path masks with explicit local coordinates", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      layers: [{ id: "shape", type: "shape", shape: "rect", startMs: 0, durationMs: 1000, mask: { type: "rect" } }],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    const edited = setTimelineLayerMask(motion, {
      layerId: "shape",
      mask: { type: "path", path: "M 0 0 L 100 0 L 50 100 Z", viewBox: "0,0,100,100", fillRule: "evenodd" }
    });

    expect(edited.newMask).toEqual({
      type: "path",
      path: "M 0 0 L 100 0 L 50 100 Z",
      viewBox: "0 0 100 100",
      fillRule: "evenodd"
    });
    expect(edited.changedPaths).toEqual([
      "/layers/shape/mask/type",
      "/layers/shape/mask/path",
      "/layers/shape/mask/viewBox",
      "/layers/shape/mask/fillRule"
    ]);
    expect(motion.layers[0].mask).toEqual({ type: "rect" });
  });

  it("rejects invalid no-op unsupported and locked timeline layer mask edits", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      tracks: [{ id: "visual", type: "video", locked: true, layerIds: ["shape"] }],
      layers: [
        { id: "shape", type: "shape", trackId: "visual", shape: "rect", startMs: 0, durationMs: 1000, mask: { type: "rect", inset: { top: 0, right: 0, bottom: 0, left: 0 } } },
        { id: "title", type: "text", text: "Masked", startMs: 0, durationMs: 1000, mask: { type: "rect", inset: { top: 1 } } },
        { id: "music", type: "audio", source: "assets/music.wav", startMs: 0, durationMs: 1000 }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    expect(() => setTimelineLayerMask(motion, { layerId: "", mask: { type: "rect" } })).toThrow("Layer id is required.");
    expect(() => setTimelineLayerMask(motion, { layerId: "missing", mask: { type: "rect" } })).toThrow("Motion layer not found: missing.");
    expect(() => setTimelineLayerMask(motion, { layerId: "music", mask: { type: "rect" } })).toThrow("Layer type does not support mask: audio.");
    expect(() => setTimelineLayerMask(motion, { layerId: "title", mask: {} })).toThrow("Layer mask type is required.");
    expect(() => setTimelineLayerMask(motion, { layerId: "title", mask: { type: "circle" } })).toThrow("Layer mask type must be rect, rounded-rect, or path.");
    expect(() => setTimelineLayerMask(motion, { layerId: "title", mask: { type: "path", path: "M 0 0", viewBox: "0 0 100 100" } })).toThrow("requires at least one drawing segment");
    expect(() => setTimelineLayerMask(motion, { layerId: "title", mask: { type: "path", path: "M 0 0 L 1 1", viewBox: "0 0 100 100", inset: { left: 1 } } })).toThrow("do not support inset or radius");
    expect(() => setTimelineLayerMask({
      ...motion,
      layers: [{ ...motion.layers[1], transitions: { in: { type: "wipe", durationMs: 100 } } }]
    }, {
      layerId: "title",
      mask: { type: "path", path: "M 0 0 L 1 1", viewBox: "0 0 1 1" }
    })).toThrow("cannot yet be combined with wipe transitions");
    expect(() => setTimelineLayerMask(motion, { layerId: "title", mask: { type: "rect", inset: { top: -1 } } })).toThrow("Layer mask inset top must be a non-negative finite number.");
    expect(() => setTimelineLayerMask(motion, { layerId: "title", mask: { type: "rect", radius: "{mask.radius}" } })).toThrow("Layer mask radius must be a non-negative finite number.");
    expect(() => setTimelineLayerMask(motion, { layerId: "shape", mask: { type: "rect", inset: { top: 2 } } })).toThrow("Cannot edit layer mask on locked track: visual.");
    expect(() => setTimelineLayerMask(motion, { layerId: "title", mask: { type: "rect", inset: { top: 1 } } })).toThrow("Layer mask did not change.");
  });

  it("sets timeline layer media fit immutably", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      layers: [
        { id: "product", type: "image", source: "assets/product.png", startMs: 0, durationMs: 1000, fit: "cover" },
        { id: "clip", type: "video", source: "assets/clip.mp4", startMs: 0, durationMs: 1000 }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    const imageEdit = setTimelineLayerFit(motion, { layerId: "product", fit: "contain" });
    const videoEdit = setTimelineLayerFit(motion, { layerId: "clip", fit: "none" });

    expect(motion.layers[0].fit).toBe("cover");
    expect(imageEdit).toEqual({
      motion: {
        ...motion,
        layers: [
          { id: "product", type: "image", source: "assets/product.png", startMs: 0, durationMs: 1000, fit: "contain" },
          { id: "clip", type: "video", source: "assets/clip.mp4", startMs: 0, durationMs: 1000 }
        ]
      },
      changedPaths: ["/layers/product/fit"],
      action: "updated",
      layerId: "product",
      oldFit: "cover",
      newFit: "contain",
      layer: { id: "product", type: "image", source: "assets/product.png", startMs: 0, durationMs: 1000, fit: "contain" }
    });
    expect(videoEdit).toMatchObject({
      changedPaths: ["/layers/clip/fit"],
      oldFit: null,
      newFit: "none"
    });
  });

  it("canonicalizes legacy timeline layer media fit aliases", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      layers: [
        { id: "product", type: "image", source: "assets/product.png", startMs: 0, durationMs: 1000, style: { objectFit: "scale-down", fit: "none", borderRadius: 8 } }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    const edited = setTimelineLayerFit(motion, { layerId: "product", fit: "contain" });

    expect(edited).toMatchObject({
      changedPaths: ["/layers/product/fit", "/layers/product/style/objectFit", "/layers/product/style/fit"],
      oldFit: "scale-down",
      newFit: "contain"
    });
    expect(edited.layer).toEqual({ id: "product", type: "image", source: "assets/product.png", startMs: 0, durationMs: 1000, fit: "contain", style: { borderRadius: 8 } });
    expect(edited.motion.layers[0]).toEqual({ id: "product", type: "image", source: "assets/product.png", startMs: 0, durationMs: 1000, fit: "contain", style: { borderRadius: 8 } });
  });

  it("rejects invalid no-op unsupported and locked timeline layer fit edits", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      tracks: [{ id: "media", type: "video", locked: true, layerIds: ["clip"] }],
      layers: [
        { id: "clip", type: "video", trackId: "media", source: "assets/clip.mp4", startMs: 0, durationMs: 1000, fit: "cover" },
        { id: "product", type: "image", source: "assets/product.png", startMs: 0, durationMs: 1000, fit: "contain" },
        { id: "title", type: "text", text: "No fit", startMs: 0, durationMs: 1000 }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    expect(() => setTimelineLayerFit(motion, { layerId: "", fit: "cover" })).toThrow("Layer id is required.");
    expect(() => setTimelineLayerFit(motion, { layerId: "missing", fit: "cover" })).toThrow("Motion layer not found: missing.");
    expect(() => setTimelineLayerFit(motion, { layerId: "title", fit: "cover" })).toThrow("Layer type does not support fit: text.");
    expect(() => setTimelineLayerFit(motion, { layerId: "product", fit: "" })).toThrow("Layer fit is required.");
    expect(() => setTimelineLayerFit(motion, { layerId: "product", fit: "stretch" })).toThrow("Layer fit must be a supported media fit.");
    expect(() => setTimelineLayerFit(motion, { layerId: "clip", fit: "contain" })).toThrow("Cannot edit layer fit on locked track: media.");
    expect(() => setTimelineLayerFit(motion, { layerId: "product", fit: "contain" })).toThrow("Layer fit did not change.");
  });

  it("sets timeline layer media source immutably", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      layers: [
        { id: "product", type: "image", source: "assets/product-old.png", startMs: 0, durationMs: 1000, fit: "cover" },
        { id: "clip", type: "video", source: "assets/clip-old.mp4", startMs: 0, durationMs: 1000 },
        { id: "music", type: "audio", source: "assets/music-old.wav", startMs: 0, durationMs: 1000 }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    const imageEdit = setTimelineLayerMediaSource(motion, { layerId: "product", source: "assets/product-new.png" });
    const videoEdit = setTimelineLayerMediaSource(motion, { layerId: "clip", source: "assets/clip-new.mp4" });
    const audioEdit = setTimelineLayerMediaSource(motion, { layerId: "music", source: "assets/music-new.wav" });

    expect(motion.layers[0].source).toBe("assets/product-old.png");
    expect(imageEdit).toEqual({
      motion: {
        ...motion,
        layers: [
          { id: "product", type: "image", source: "assets/product-new.png", startMs: 0, durationMs: 1000, fit: "cover" },
          { id: "clip", type: "video", source: "assets/clip-old.mp4", startMs: 0, durationMs: 1000 },
          { id: "music", type: "audio", source: "assets/music-old.wav", startMs: 0, durationMs: 1000 }
        ]
      },
      changedPaths: ["/layers/product/source"],
      action: "updated",
      layerId: "product",
      oldSource: "assets/product-old.png",
      newSource: "assets/product-new.png",
      layer: { id: "product", type: "image", source: "assets/product-new.png", startMs: 0, durationMs: 1000, fit: "cover" }
    });
    expect(videoEdit).toMatchObject({
      changedPaths: ["/layers/clip/source"],
      oldSource: "assets/clip-old.mp4",
      newSource: "assets/clip-new.mp4"
    });
    expect(audioEdit).toMatchObject({
      changedPaths: ["/layers/music/source"],
      oldSource: "assets/music-old.wav",
      newSource: "assets/music-new.wav"
    });
  });

  it("canonicalizes timeline layer media source aliases", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      layers: [
        {
          id: "product",
          type: "image",
          assetRef: "assets/product-asset-ref.png",
          source: "assets/product-old.png",
          src: "assets/product-src.png",
          assetId: "asset_product_old",
          startMs: 0,
          durationMs: 1000,
          fit: "cover"
        }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    const edited = setTimelineLayerMediaSource(motion, { layerId: "product", source: "assets/product-new.png" });

    expect(edited).toMatchObject({
      changedPaths: ["/layers/product/source", "/layers/product/assetRef", "/layers/product/src", "/layers/product/assetId"],
      oldSource: "assets/product-asset-ref.png",
      newSource: "assets/product-new.png"
    });
    expect(edited.layer).toEqual({ id: "product", type: "image", source: "assets/product-new.png", startMs: 0, durationMs: 1000, fit: "cover" });
    expect(edited.motion.layers[0]).toEqual({ id: "product", type: "image", source: "assets/product-new.png", startMs: 0, durationMs: 1000, fit: "cover" });
  });

  it("rejects invalid no-op unsupported and locked timeline layer media source edits", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      tracks: [{ id: "media", type: "video", locked: true, layerIds: ["clip"] }],
      layers: [
        { id: "clip", type: "video", trackId: "media", source: "assets/clip.mp4", startMs: 0, durationMs: 1000 },
        { id: "product", type: "image", source: "assets/product.png", startMs: 0, durationMs: 1000 },
        { id: "title", type: "text", text: "No media", startMs: 0, durationMs: 1000 }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    expect(() => setTimelineLayerMediaSource(motion, { layerId: "", source: "assets/new.png" })).toThrow("Layer id is required.");
    expect(() => setTimelineLayerMediaSource(motion, { layerId: "missing", source: "assets/new.png" })).toThrow("Motion layer not found: missing.");
    expect(() => setTimelineLayerMediaSource(motion, { layerId: "title", source: "assets/new.png" })).toThrow("Layer type does not support media source: text.");
    expect(() => setTimelineLayerMediaSource(motion, { layerId: "product", source: "" })).toThrow("Layer media source is required.");
    expect(() => setTimelineLayerMediaSource(motion, { layerId: "clip", source: "assets/new.mp4" })).toThrow("Cannot edit layer media source on locked track: media.");
    expect(() => setTimelineLayerMediaSource(motion, { layerId: "product", source: "assets/product.png" })).toThrow("Layer media source did not change.");
  });

  it("sets timeline layer display names immutably", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      layers: [
        { id: "title", type: "text", text: "Visible", startMs: 0, durationMs: 1000 },
        { id: "product", type: "image", source: "assets/product.png", name: "Old Product", startMs: 0, durationMs: 1000 }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    const named = setTimelineLayerName(motion, { layerId: "title", name: "Hero Title" });
    const renamed = setTimelineLayerName(motion, { layerId: "product", name: "Product Packshot" });

    expect(motion.layers[0].name).toBeUndefined();
    expect(named).toEqual({
      motion: {
        ...motion,
        layers: [
          { id: "title", type: "text", text: "Visible", startMs: 0, durationMs: 1000, name: "Hero Title" },
          { id: "product", type: "image", source: "assets/product.png", name: "Old Product", startMs: 0, durationMs: 1000 }
        ]
      },
      changedPaths: ["/layers/title/name"],
      action: "renamed",
      layerId: "title",
      oldName: null,
      newName: "Hero Title",
      layer: { id: "title", type: "text", text: "Visible", startMs: 0, durationMs: 1000, name: "Hero Title" }
    });
    expect(renamed).toMatchObject({
      changedPaths: ["/layers/product/name"],
      action: "renamed",
      layerId: "product",
      oldName: "Old Product",
      newName: "Product Packshot",
      layer: { id: "product", type: "image", source: "assets/product.png", name: "Product Packshot", startMs: 0, durationMs: 1000 }
    });
  });

  it("rejects invalid no-op and locked timeline layer name edits", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      tracks: [{ id: "overlay", type: "overlay", locked: true, layerIds: ["title"] }],
      layers: [
        { id: "title", type: "text", trackId: "overlay", text: "Locked", startMs: 0, durationMs: 1000 },
        { id: "badge", type: "shape", shape: "rect", name: "Badge", startMs: 0, durationMs: 1000 },
        { id: "caption", type: "caption", text: "Caption", locked: true, startMs: 0, durationMs: 1000 }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    expect(() => setTimelineLayerName(motion, { layerId: "", name: "Name" })).toThrow("Layer id is required.");
    expect(() => setTimelineLayerName(motion, { layerId: "missing", name: "Name" })).toThrow("Motion layer not found: missing.");
    expect(() => setTimelineLayerName(motion, { layerId: "badge", name: "" })).toThrow("Layer name is required.");
    expect(() => setTimelineLayerName(motion, { layerId: "badge", name: "   " })).toThrow("Layer name is required.");
    expect(() => setTimelineLayerName(motion, { layerId: "badge", name: 123 as unknown as string })).toThrow("Layer name is required.");
    expect(() => setTimelineLayerName(motion, { layerId: "title", name: "Locked Track Title" })).toThrow("Cannot edit layer name on locked track: overlay.");
    expect(() => setTimelineLayerName(motion, { layerId: "caption", name: "Caption Layer" })).toThrow("Cannot edit locked layer: caption.");
    expect(() => setTimelineLayerName(motion, { layerId: "badge", name: "Badge" })).toThrow("Layer name did not change.");
    expect(() => setTimelineLayerName(motion, { layerId: "badge", name: " Badge " })).toThrow("Layer name did not change.");
  });

  it("sets timeline layer visibility immutably", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      layers: [
        { id: "title", type: "text", text: "Visible", startMs: 0, durationMs: 1000 },
        { id: "product", type: "image", source: "assets/product.png", visible: false, startMs: 0, durationMs: 1000 }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    const hidden = setTimelineLayerVisibility(motion, { layerId: "title", visible: false });
    const shown = setTimelineLayerVisibility(motion, { layerId: "product", visible: true });

    expect(motion.layers[0].visible).toBeUndefined();
    expect(hidden).toEqual({
      motion: {
        ...motion,
        layers: [
          { id: "title", type: "text", text: "Visible", startMs: 0, durationMs: 1000, visible: false },
          { id: "product", type: "image", source: "assets/product.png", visible: false, startMs: 0, durationMs: 1000 }
        ]
      },
      changedPaths: ["/layers/title/visible"],
      action: "hidden",
      layerId: "title",
      oldVisible: true,
      newVisible: false,
      layer: { id: "title", type: "text", text: "Visible", startMs: 0, durationMs: 1000, visible: false }
    });
    expect(shown).toMatchObject({
      changedPaths: ["/layers/product/visible"],
      action: "shown",
      layerId: "product",
      oldVisible: false,
      newVisible: true,
      layer: { id: "product", type: "image", source: "assets/product.png", visible: true, startMs: 0, durationMs: 1000 }
    });
  });

  it("rejects invalid no-op and locked timeline layer visibility edits", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      tracks: [{ id: "overlay", type: "overlay", locked: true, layerIds: ["title"] }],
      layers: [
        { id: "title", type: "text", trackId: "overlay", text: "Locked", startMs: 0, durationMs: 1000 },
        { id: "badge", type: "shape", shape: "rect", startMs: 0, durationMs: 1000, visible: false }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    expect(() => setTimelineLayerVisibility(motion, { layerId: "", visible: false })).toThrow("Layer id is required.");
    expect(() => setTimelineLayerVisibility(motion, { layerId: "missing", visible: false })).toThrow("Motion layer not found: missing.");
    expect(() => setTimelineLayerVisibility(motion, { layerId: "badge", visible: "yes" as unknown as boolean })).toThrow("Layer visibility must be a boolean.");
    expect(() => setTimelineLayerVisibility(motion, { layerId: "title", visible: false })).toThrow("Cannot edit layer visibility on locked track: overlay.");
    expect(() => setTimelineLayerVisibility(motion, { layerId: "badge", visible: false })).toThrow("Layer visibility did not change.");
  });

  it("sets timeline layer locks immutably for editor controls", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      layers: [
        { id: "title", type: "text", text: "Editable", startMs: 0, durationMs: 1000 },
        { id: "badge", type: "shape", shape: "rect", locked: true, startMs: 0, durationMs: 1000 }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    const locked = setTimelineLayerLock(motion, { layerId: "title", locked: true });
    const unlocked = setTimelineLayerLock(motion, { layerId: "badge", locked: false });

    expect(motion.layers[0].locked).toBeUndefined();
    expect(locked).toEqual({
      motion: {
        ...motion,
        layers: [
          { id: "title", type: "text", text: "Editable", startMs: 0, durationMs: 1000, locked: true },
          { id: "badge", type: "shape", shape: "rect", locked: true, startMs: 0, durationMs: 1000 }
        ]
      },
      changedPaths: ["/layers/title/locked"],
      action: "locked",
      layerId: "title",
      oldLocked: false,
      newLocked: true,
      layer: { id: "title", type: "text", text: "Editable", startMs: 0, durationMs: 1000, locked: true }
    });
    expect(unlocked).toMatchObject({
      changedPaths: ["/layers/badge/locked"],
      action: "unlocked",
      layerId: "badge",
      oldLocked: true,
      newLocked: false,
      layer: { id: "badge", type: "shape", shape: "rect", locked: false, startMs: 0, durationMs: 1000 }
    });
  });

  it("rejects invalid no-op and locked-track timeline layer lock edits", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      tracks: [{ id: "overlay", type: "overlay", locked: true, layerIds: ["title"] }],
      layers: [
        { id: "title", type: "text", trackId: "overlay", text: "Locked track", startMs: 0, durationMs: 1000 },
        { id: "badge", type: "shape", shape: "rect", locked: true, startMs: 0, durationMs: 1000 }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    expect(() => setTimelineLayerLock(motion, { layerId: "", locked: false })).toThrow("Layer id is required.");
    expect(() => setTimelineLayerLock(motion, { layerId: "missing", locked: false })).toThrow("Motion layer not found: missing.");
    expect(() => setTimelineLayerLock(motion, { layerId: "badge", locked: "yes" as unknown as boolean })).toThrow("Layer locked must be a boolean.");
    expect(() => setTimelineLayerLock(motion, { layerId: "title", locked: true })).toThrow("Cannot edit layer lock on locked track: overlay.");
    expect(() => setTimelineLayerLock(motion, { layerId: "badge", locked: true })).toThrow("Layer lock state did not change.");
  });

  it("rejects timeline edits on locked layers without mutating the document", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      layers: [
        { id: "title", type: "text", text: "Locked", locked: true, startMs: 0, durationMs: 1000 },
        { id: "badge", type: "shape", shape: "rect", locked: true, startMs: 0, durationMs: 1000 }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    expect(() => setTimelineLayerText(motion, { layerId: "title", text: "New" })).toThrow("Cannot edit locked layer: title.");
    expect(() => setTimelineLayerName(motion, { layerId: "title", name: "Locked Title" })).toThrow("Cannot edit locked layer: title.");
    expect(() => setTimelineLayerVisibility(motion, { layerId: "title", visible: false })).toThrow("Cannot edit locked layer: title.");
    expect(() => deleteTimelineLayer(motion, { layerId: "badge" })).toThrow("Cannot delete locked layer: badge.");
    expect(motion.layers[0]).toMatchObject({ id: "title", text: "Locked", locked: true });
    expect(motion.layers[1]).toMatchObject({ id: "badge", locked: true });
  });

  it("cleans stale duplicate timeline refs and recomputes duration", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 900,
      fps: 30,
      width: 1280,
      height: 720,
      scenes: [
        {
          id: "intro",
          startMs: 0,
          durationMs: 600,
          trackIds: ["music", "missing-track", "music"],
          markerIds: ["start", "missing-marker", "start"]
        }
      ],
      tracks: [
        { id: "music", type: "audio", layerIds: ["bed", "missing-layer", "bed"] },
        { id: "overlay", type: "overlay", layerIds: ["title"] }
      ],
      markers: [{ id: "start", atMs: 0, label: "Start" }],
      layers: [
        { id: "bed", type: "audio", trackId: "music", source: "assets/bed.wav", startMs: 0, durationMs: 1200 },
        { id: "title", type: "text", trackId: "overlay", text: "Title", startMs: 0, durationMs: 300 }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    const cleaned = cleanupMotionTimeline(motion);

    expect(motion.tracks?.[0].layerIds).toEqual(["bed", "missing-layer", "bed"]);
    expect(cleaned).toEqual({
      motion: expect.objectContaining({
        durationMs: 1200,
        scenes: [{ id: "intro", startMs: 0, durationMs: 600, trackIds: ["music"], markerIds: ["start"] }],
        tracks: [
          { id: "music", type: "audio", layerIds: ["bed"] },
          { id: "overlay", type: "overlay", layerIds: ["title"] }
        ]
      }),
      changedPaths: ["/tracks/music/layerIds", "/scenes/intro/trackIds", "/scenes/intro/markerIds", "/durationMs"],
      action: "cleaned",
      removedTrackLayerRefs: [
        { trackId: "music", layerId: "missing-layer", reason: "missing" },
        { trackId: "music", layerId: "bed", reason: "duplicate" }
      ],
      removedSceneTrackRefs: [
        { sceneId: "intro", trackId: "missing-track", reason: "missing" },
        { sceneId: "intro", trackId: "music", reason: "duplicate" }
      ],
      removedSceneMarkerRefs: [
        { sceneId: "intro", markerId: "missing-marker", reason: "missing" },
        { sceneId: "intro", markerId: "start", reason: "duplicate" }
      ],
      oldDurationMs: 900,
      newDurationMs: 1200,
      durationChanged: true
    });
  });

  it("rejects no-op timeline cleanup", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 300,
      fps: 30,
      width: 1280,
      height: 720,
      scenes: [{ id: "intro", startMs: 0, durationMs: 300, trackIds: ["overlay"], markerIds: ["start"] }],
      tracks: [{ id: "overlay", type: "overlay", layerIds: ["title"] }],
      markers: [{ id: "start", atMs: 0 }],
      layers: [{ id: "title", type: "text", text: "Title", trackId: "overlay", startMs: 0, durationMs: 300 }],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    expect(() => cleanupMotionTimeline(motion)).toThrow("Timeline cleanup did not change anything.");
  });

  it("assigns layers to tracks and keeps track layer order consistent", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      tracks: [
        { id: "overlay", type: "overlay", name: "Overlay", order: 1, layerIds: ["title", "badge"] },
        { id: "captions", type: "caption", name: "Captions", order: 2, layerIds: ["subtitle"] }
      ],
      layers: [
        { id: "title", type: "text", text: "Title", trackId: "overlay", startMs: 0, durationMs: 1000 },
        { id: "badge", type: "shape", shape: "rect", trackId: "overlay", startMs: 0, durationMs: 1000 },
        { id: "subtitle", type: "caption", text: "Subtitle", trackId: "captions", startMs: 0, durationMs: 1000 }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    const moved = assignLayerTrack(motion, { layerId: "title", trackId: "captions", index: 0 });
    const reordered = assignLayerTrack(moved.motion, { layerId: "subtitle", trackId: "captions", index: 0 });

    expect(motion.layers[0].trackId).toBe("overlay");
    expect(motion.tracks?.[0].layerIds).toEqual(["title", "badge"]);
    expect(moved).toEqual({
      motion: expect.objectContaining({
        layers: [
          { id: "title", type: "text", text: "Title", trackId: "captions", startMs: 0, durationMs: 1000 },
          { id: "badge", type: "shape", shape: "rect", trackId: "overlay", startMs: 0, durationMs: 1000 },
          { id: "subtitle", type: "caption", text: "Subtitle", trackId: "captions", startMs: 0, durationMs: 1000 }
        ],
        tracks: [
          { id: "overlay", type: "overlay", name: "Overlay", order: 1, layerIds: ["badge"] },
          { id: "captions", type: "caption", name: "Captions", order: 2, layerIds: ["title", "subtitle"] }
        ]
      }),
      changedPaths: ["/layers/title/trackId", "/tracks/0/layerIds", "/tracks/1/layerIds"],
      action: "assigned",
      layer: { id: "title", type: "text", text: "Title", trackId: "captions", startMs: 0, durationMs: 1000 },
      oldTrackId: "overlay",
      newTrackId: "captions",
      oldIndex: 0,
      newIndex: 0,
      removedFromTrackIds: ["overlay"]
    });
    expect(reordered).toMatchObject({
      changedPaths: ["/tracks/1/layerIds"],
      action: "reordered",
      oldTrackId: "captions",
      newTrackId: "captions",
      oldIndex: 1,
      newIndex: 0,
      removedFromTrackIds: []
    });
    expect(reordered.motion.tracks?.[1].layerIds).toEqual(["subtitle", "title"]);
  });

  it("rejects same-track assignments without an index instead of moving the layer to the end", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      tracks: [{ id: "overlay", type: "overlay", layerIds: ["title", "badge"] }],
      layers: [
        { id: "title", type: "text", trackId: "overlay", startMs: 0, durationMs: 1000 },
        { id: "badge", type: "shape", trackId: "overlay", startMs: 0, durationMs: 1000 }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    expect(() => assignLayerTrack(motion, { layerId: "title", trackId: "overlay" })).toThrow("Layer track assignment did not change track order.");
    expect(motion.tracks?.[0].layerIds).toEqual(["title", "badge"]);
  });

  it("rejects assignments that would remove stale refs from locked tracks", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      tracks: [
        { id: "overlay", type: "overlay", layerIds: ["title"] },
        { id: "locked-stale", type: "overlay", locked: true, layerIds: ["title"] },
        { id: "captions", type: "caption", layerIds: [] }
      ],
      layers: [
        { id: "title", type: "text", trackId: "overlay", startMs: 0, durationMs: 1000 }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    expect(() => assignLayerTrack(motion, { layerId: "title", trackId: "captions", index: 0 })).toThrow("Source track is locked: locked-stale.");
    expect(motion.tracks?.[1].layerIds).toEqual(["title"]);
  });

  it("rejects invalid layer track assignments", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      tracks: [
        { id: "overlay", type: "overlay", layerIds: ["title"] },
        { id: "locked", type: "overlay", locked: true, layerIds: [] }
      ],
      layers: [
        { id: "title", type: "text", trackId: "overlay", startMs: 0, durationMs: 1000 }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    expect(() => assignLayerTrack(motion, { layerId: "", trackId: "overlay" })).toThrow("Layer id is required.");
    expect(() => assignLayerTrack(motion, { layerId: "missing", trackId: "overlay" })).toThrow("Motion layer not found: missing.");
    expect(() => assignLayerTrack(motion, { layerId: "title", trackId: "" })).toThrow("Track id is required.");
    expect(() => assignLayerTrack(motion, { layerId: "title", trackId: "missing" })).toThrow("Motion track not found: missing.");
    expect(() => assignLayerTrack(motion, { layerId: "title", trackId: "locked" })).toThrow("Target track is locked: locked.");
    expect(() => assignLayerTrack(motion, { layerId: "title", trackId: "overlay", index: -1 })).toThrow("Track index must be a non-negative integer.");
    expect(() => assignLayerTrack(motion, { layerId: "title", trackId: "overlay" })).toThrow("Layer track assignment did not change track order.");
  });

  it("creates timeline tracks and attaches existing untracked layers immutably", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      layers: [
        { id: "title", type: "text", startMs: 0, durationMs: 1000 }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    const created = createTimelineTrack(motion, {
      track: { id: "overlay", type: "overlay", name: "Overlay", order: 1, layerIds: ["title"] },
      index: 0
    });

    expect(motion.tracks).toBeUndefined();
    expect(motion.layers[0].trackId).toBeUndefined();
    expect(created).toEqual({
      motion: {
        ...motion,
        tracks: [{ id: "overlay", type: "overlay", name: "Overlay", order: 1, layerIds: ["title"] }],
        layers: [{ id: "title", type: "text", startMs: 0, durationMs: 1000, trackId: "overlay" }]
      },
      changedPaths: ["/tracks/overlay", "/layers/title/trackId"],
      action: "created",
      trackId: "overlay",
      index: 0,
      track: { id: "overlay", type: "overlay", name: "Overlay", order: 1, layerIds: ["title"] },
      attachedLayerIds: ["title"],
      oldTrackCount: 0,
      newTrackCount: 1
    });
  });

  it("creates empty timeline tracks at a requested stack index", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      tracks: [{ id: "base", type: "video", layerIds: [] }],
      layers: [],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    const created = createTimelineTrack(motion, {
      track: { id: "captions", type: "caption", name: "Captions" },
      index: 0
    });

    expect(created.motion.tracks).toEqual([
      { id: "captions", type: "caption", name: "Captions", layerIds: [] },
      { id: "base", type: "video", layerIds: [] }
    ]);
    expect(created.changedPaths).toEqual(["/tracks/captions"]);
    expect(created.attachedLayerIds).toEqual([]);
    expect(created.oldTrackCount).toBe(1);
    expect(created.newTrackCount).toBe(2);
  });

  it("rejects invalid duplicate and implicit-move timeline track creates", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      tracks: [{ id: "overlay", type: "overlay", layerIds: ["title"] }],
      layers: [
        { id: "title", type: "text", trackId: "overlay", startMs: 0, durationMs: 1000 },
        { id: "floating", type: "shape", startMs: 0, durationMs: 500 }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    expect(() => createTimelineTrack(motion, { track: { id: "", type: "overlay" } })).toThrow("Track id is required.");
    expect(() => createTimelineTrack(motion, { track: { id: "new", type: "" } })).toThrow("Track type is required.");
    expect(() => createTimelineTrack(motion, { track: { id: "overlay", type: "overlay" } })).toThrow("Motion track id already exists: overlay.");
    expect(() => createTimelineTrack(motion, { track: { id: "captions", type: "caption" }, index: 2 })).toThrow("Track create index must be a non-negative integer within the track stack.");
    expect(() => createTimelineTrack(motion, { track: { id: "captions", type: "caption", layerIds: ["floating", "floating"] } })).toThrow("Track layerIds must be unique.");
    expect(() => createTimelineTrack(motion, { track: { id: "captions", type: "caption", layerIds: ["missing"] } })).toThrow("Motion layer not found: missing.");
    expect(() => createTimelineTrack(motion, { track: { id: "captions", type: "caption", layerIds: ["title"] } })).toThrow("Motion layer already belongs to track: overlay.");
  });

  it("reorders timeline tracks immutably for track stack controls", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      tracks: [
        { id: "overlay", type: "overlay", name: "Overlay", order: 1, layerIds: ["title"] },
        { id: "captions", type: "caption", name: "Captions", order: 2, layerIds: ["subtitle"] },
        { id: "music", type: "audio", name: "Music", order: 3, layerIds: [] }
      ],
      layers: [
        { id: "title", type: "text", trackId: "overlay", startMs: 0, durationMs: 1000 },
        { id: "subtitle", type: "caption", trackId: "captions", startMs: 0, durationMs: 1000 }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    const reordered = reorderTimelineTrack(motion, { trackId: "music", index: 0 });

    expect(motion.tracks?.map((track) => track.id)).toEqual(["overlay", "captions", "music"]);
    expect(reordered).toEqual({
      motion: {
        ...motion,
        tracks: [
          { id: "music", type: "audio", name: "Music", order: 3, layerIds: [] },
          { id: "overlay", type: "overlay", name: "Overlay", order: 1, layerIds: ["title"] },
          { id: "captions", type: "caption", name: "Captions", order: 2, layerIds: ["subtitle"] }
        ]
      },
      changedPaths: ["/tracks"],
      action: "reordered",
      trackId: "music",
      oldIndex: 2,
      newIndex: 0,
      oldTrackOrder: ["overlay", "captions", "music"],
      newTrackOrder: ["music", "overlay", "captions"],
      track: { id: "music", type: "audio", name: "Music", order: 3, layerIds: [] }
    });
  });

  it("rejects invalid timeline track reorders", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      tracks: [
        { id: "overlay", type: "overlay", layerIds: [] },
        { id: "captions", type: "caption", layerIds: [] }
      ],
      layers: [],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    expect(() => reorderTimelineTrack(motion, { trackId: "", index: 0 })).toThrow("Track id is required.");
    expect(() => reorderTimelineTrack({ ...motion, tracks: undefined }, { trackId: "overlay", index: 0 })).toThrow("Motion document has no timeline tracks.");
    expect(() => reorderTimelineTrack(motion, { trackId: "missing", index: 0 })).toThrow("Motion track not found: missing.");
    expect(() => reorderTimelineTrack(motion, { trackId: "overlay", index: -1 })).toThrow("Track reorder index must be a non-negative integer within the track stack.");
    expect(() => reorderTimelineTrack(motion, { trackId: "overlay", index: 2 })).toThrow("Track reorder index must be a non-negative integer within the track stack.");
    expect(() => reorderTimelineTrack(motion, { trackId: "overlay", index: 0 })).toThrow("Track reorder did not change track order.");
  });

  it("deletes timeline tracks and detaches layer and scene refs immutably", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      tracks: [
        { id: "overlay", type: "overlay", name: "Overlay", order: 1, layerIds: ["title"] },
        { id: "music", type: "audio", name: "Music", order: 2, layerIds: [] }
      ],
      scenes: [{ id: "intro", startMs: 0, durationMs: 1000, trackIds: ["overlay", "music"] }],
      layers: [
        { id: "title", type: "text", trackId: "overlay", startMs: 0, durationMs: 1000 },
        { id: "badge", type: "shape", startMs: 0, durationMs: 500 }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    const deleted = deleteTimelineTrack(motion, { trackId: "overlay", detachLayers: true });

    expect(motion.tracks?.map((track) => track.id)).toEqual(["overlay", "music"]);
    expect(motion.layers[0].trackId).toBe("overlay");
    expect(deleted).toEqual({
      motion: {
        ...motion,
        tracks: [{ id: "music", type: "audio", name: "Music", order: 2, layerIds: [] }],
        scenes: [{ id: "intro", startMs: 0, durationMs: 1000, trackIds: ["music"] }],
        layers: [
          { id: "title", type: "text", startMs: 0, durationMs: 1000 },
          { id: "badge", type: "shape", startMs: 0, durationMs: 500 }
        ]
      },
      changedPaths: ["/tracks/overlay", "/layers/title/trackId", "/scenes/intro/trackIds"],
      action: "deleted",
      trackId: "overlay",
      removed: { id: "overlay", type: "overlay", name: "Overlay", order: 1, layerIds: ["title"] },
      detachedLayerIds: ["title"],
      removedSceneRefs: ["intro"],
      oldTrackCount: 2,
      newTrackCount: 1
    });
  });

  it("deletes empty timeline tracks without requiring layer detach", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      tracks: [{ id: "music", type: "audio", layerIds: [] }],
      scenes: [{ id: "intro", startMs: 0, durationMs: 1000, trackIds: ["music"] }],
      layers: [],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    const deleted = deleteTimelineTrack(motion, { trackId: "music" });

    expect(deleted.motion.tracks).toBeUndefined();
    expect("tracks" in deleted.motion).toBe(false);
    expect(deleted.motion.scenes?.[0].trackIds).toBeUndefined();
    expect("trackIds" in deleted.motion.scenes![0]).toBe(false);
    expect(deleted.changedPaths).toEqual(["/tracks/music", "/scenes/intro/trackIds"]);
    expect(deleted.detachedLayerIds).toEqual([]);
    expect(deleted.removedSceneRefs).toEqual(["intro"]);
    expect(deleted.oldTrackCount).toBe(1);
    expect(deleted.newTrackCount).toBe(0);
  });

  it("rejects invalid and non-empty timeline track deletes without detach", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      tracks: [{ id: "overlay", type: "overlay", layerIds: ["title"] }],
      layers: [
        { id: "title", type: "text", trackId: "overlay", startMs: 0, durationMs: 1000 }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    expect(() => deleteTimelineTrack(motion, { trackId: "" })).toThrow("Track id is required.");
    expect(() => deleteTimelineTrack({ ...motion, tracks: undefined }, { trackId: "overlay" })).toThrow("Motion document has no timeline tracks.");
    expect(() => deleteTimelineTrack(motion, { trackId: "missing" })).toThrow("Motion track not found: missing.");
    expect(() => deleteTimelineTrack(motion, { trackId: "overlay" })).toThrow("Track has layer refs; set detachLayers to true to delete it.");
  });

  it("renames timeline tracks immutably", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      tracks: [{ id: "overlay", type: "overlay", name: "Overlay", layerIds: ["title"] }],
      layers: [{ id: "title", type: "text", trackId: "overlay", startMs: 0, durationMs: 1000 }],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    const renamed = renameTimelineTrack(motion, { trackId: "overlay", name: "Main Titles" });

    expect(motion.tracks?.[0].name).toBe("Overlay");
    expect(renamed).toEqual({
      motion: {
        ...motion,
        tracks: [{ id: "overlay", type: "overlay", name: "Main Titles", layerIds: ["title"] }]
      },
      changedPaths: ["/tracks/overlay/name"],
      action: "renamed",
      trackId: "overlay",
      oldName: "Overlay",
      newName: "Main Titles",
      track: { id: "overlay", type: "overlay", name: "Main Titles", layerIds: ["title"] }
    });
  });

  it("rejects invalid and unchanged timeline track renames", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      tracks: [{ id: "overlay", type: "overlay", name: "Overlay" }],
      layers: [],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    expect(() => renameTimelineTrack(motion, { trackId: "", name: "Main Titles" })).toThrow("Track id is required.");
    expect(() => renameTimelineTrack(motion, { trackId: "overlay", name: "" })).toThrow("Track name is required.");
    expect(() => renameTimelineTrack(motion, { trackId: "missing", name: "Main Titles" })).toThrow("Motion track not found: missing.");
    expect(() => renameTimelineTrack(motion, { trackId: "overlay", name: "Overlay" })).toThrow("Track name did not change.");
  });

  it("sets timeline track locks immutably for editor controls", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      tracks: [
        { id: "overlay", type: "overlay", name: "Overlay", order: 1, layerIds: ["title"] },
        { id: "captions", type: "caption", name: "Captions", order: 2, layerIds: [] }
      ],
      layers: [
        { id: "title", type: "text", trackId: "overlay", startMs: 0, durationMs: 1000 }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    const locked = setTimelineTrackLock(motion, { trackId: "overlay", locked: true });
    const unlocked = setTimelineTrackLock(locked.motion, { trackId: "overlay", locked: false });

    expect(motion.tracks?.[0].locked).toBeUndefined();
    expect(locked).toEqual({
      motion: expect.objectContaining({
        tracks: [
          { id: "overlay", type: "overlay", name: "Overlay", order: 1, layerIds: ["title"], locked: true },
          { id: "captions", type: "caption", name: "Captions", order: 2, layerIds: [] }
        ]
      }),
      changedPaths: ["/tracks/overlay/locked"],
      action: "locked",
      trackId: "overlay",
      oldLocked: false,
      newLocked: true,
      track: { id: "overlay", type: "overlay", name: "Overlay", order: 1, layerIds: ["title"], locked: true }
    });
    expect(unlocked).toMatchObject({
      changedPaths: ["/tracks/overlay/locked"],
      action: "unlocked",
      trackId: "overlay",
      oldLocked: true,
      newLocked: false,
      track: { id: "overlay", locked: false }
    });
  });

  it("rejects invalid and no-op timeline track lock edits", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      tracks: [{ id: "overlay", type: "overlay", locked: true, layerIds: [] }],
      layers: [],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    expect(() => setTimelineTrackLock(motion, { trackId: "", locked: false })).toThrow("Track id is required.");
    expect(() => setTimelineTrackLock(motion, { trackId: "missing", locked: false })).toThrow("Motion track not found: missing.");
    expect(() => setTimelineTrackLock(motion, { trackId: "overlay", locked: true })).toThrow("Track lock state did not change.");
    expect(() => setTimelineTrackLock(motion, { trackId: "overlay", locked: undefined as unknown as boolean })).toThrow("Track locked must be a boolean.");
  });

  it("sets timeline layer ducking immutably for sidechain audio controls", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 2000,
      fps: 30,
      width: 1280,
      height: 720,
      layers: [
        { id: "music", type: "audio", source: "assets/music.wav", startMs: 0, durationMs: 2000 },
        { id: "voice", type: "audio", source: "assets/voice.wav", startMs: 500, durationMs: 800 }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    const changed = setTimelineLayerDucking(motion, {
      layerId: "music",
      triggerLayerIds: ["voice"],
      duckToVolume: 0.25,
      attackMs: 100,
      releaseMs: 200
    });

    expect(motion.layers[0].ducking).toBeUndefined();
    expect(changed).toEqual({
      motion: expect.objectContaining({
        layers: [
          {
            id: "music",
            type: "audio",
            source: "assets/music.wav",
            startMs: 0,
            durationMs: 2000,
            ducking: { triggerLayerIds: ["voice"], duckToVolume: 0.25, attackMs: 100, releaseMs: 200 }
          },
          { id: "voice", type: "audio", source: "assets/voice.wav", startMs: 500, durationMs: 800 }
        ]
      }),
      changedPaths: ["/layers/music/ducking"],
      action: "updated",
      layerId: "music",
      oldDucking: null,
      newDucking: { triggerLayerIds: ["voice"], duckToVolume: 0.25, attackMs: 100, releaseMs: 200 },
      layer: expect.objectContaining({
        id: "music",
        ducking: { triggerLayerIds: ["voice"], duckToVolume: 0.25, attackMs: 100, releaseMs: 200 }
      })
    });
  });

  it("rejects invalid and no-op timeline layer ducking edits", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 2000,
      fps: 30,
      width: 1280,
      height: 720,
      layers: [
        {
          id: "music",
          type: "audio",
          source: "assets/music.wav",
          startMs: 0,
          durationMs: 2000,
          ducking: { triggerLayerIds: ["voice"], duckToVolume: 0.25, attackMs: 100, releaseMs: 200 }
        },
        { id: "voice", type: "audio", source: "assets/voice.wav", startMs: 500, durationMs: 800 },
        { id: "title", type: "text", text: "Title", startMs: 0, durationMs: 1000 }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    expect(() => setTimelineLayerDucking(motion, { layerId: "", triggerLayerIds: ["voice"] })).toThrow("Layer id is required.");
    expect(() => setTimelineLayerDucking(motion, { layerId: "missing", triggerLayerIds: ["voice"] })).toThrow("Motion layer not found: missing.");
    expect(() => setTimelineLayerDucking(motion, { layerId: "title", triggerLayerIds: ["voice"] })).toThrow("Layer title is not an audio layer.");
    expect(() => setTimelineLayerDucking(motion, { layerId: "music", triggerLayerIds: [] })).toThrow("Ducking triggerLayerIds must be a non-empty array.");
    expect(() => setTimelineLayerDucking(motion, { layerId: "music", triggerLayerIds: ["missing"] })).toThrow("Ducking trigger layer not found: missing.");
    expect(() => setTimelineLayerDucking(motion, { layerId: "music", triggerLayerIds: ["voice"], duckToVolume: -0.1 })).toThrow("Ducking values must be non-negative finite numbers.");
    expect(() => setTimelineLayerDucking(motion, { layerId: "music", triggerLayerIds: ["voice"], attackMs: Number.NaN })).toThrow("Ducking values must be non-negative finite numbers.");
    expect(() => setTimelineLayerDucking(motion, {
      layerId: "music",
      triggerLayerIds: ["voice"],
      duckToVolume: 0.25,
      attackMs: 100,
      releaseMs: 200
    })).toThrow("Layer ducking did not change.");
  });

  it("finds locked tracks for layer edit guards by direct and track-order refs", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      tracks: [
        { id: "overlay", type: "overlay", locked: true, layerIds: [] },
        { id: "stale-ref", type: "overlay", locked: true, layerIds: ["badge"] },
        { id: "open", type: "overlay", layerIds: ["title"] }
      ],
      layers: [
        { id: "title", type: "text", trackId: "overlay", startMs: 0, durationMs: 1000 },
        { id: "badge", type: "shape", trackId: "open", startMs: 0, durationMs: 1000 },
        { id: "free", type: "shape", trackId: "open", startMs: 0, durationMs: 1000 }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    expect(timelineLayerLockedTrackId(motion, motion.layers[0])).toBe("overlay");
    expect(timelineLayerLockedTrackId(motion, motion.layers[1])).toBe("stale-ref");
    expect(timelineLayerLockedTrackId(motion, motion.layers[2])).toBeNull();
  });

  it("finds muted tracks for audio render guards by direct and track-order refs", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      tracks: [
        { id: "music", type: "audio", muted: true, layerIds: [] },
        { id: "stale-ref", type: "audio", muted: true, layerIds: ["sfx"] },
        { id: "open", type: "audio", layerIds: ["voice"] }
      ],
      layers: [
        { id: "voice", type: "audio", trackId: "music", source: "assets/voice.wav", startMs: 0, durationMs: 1000 },
        { id: "sfx", type: "audio", trackId: "open", source: "assets/sfx.wav", startMs: 0, durationMs: 1000 },
        { id: "free", type: "audio", trackId: "open", source: "assets/free.wav", startMs: 0, durationMs: 1000 }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    expect(timelineLayerMutedTrackId(motion, motion.layers[0])).toBe("music");
    expect(timelineLayerMutedTrackId(motion, motion.layers[1])).toBe("stale-ref");
    expect(timelineLayerMutedTrackId(motion, motion.layers[2])).toBeNull();
  });

  it("finds soloed tracks for audio render guards by direct and track-order refs", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      tracks: [
        { id: "music", type: "audio", solo: true, layerIds: [] },
        { id: "stale-ref", type: "audio", solo: true, layerIds: ["sfx"] },
        { id: "open", type: "audio", layerIds: ["voice"] }
      ],
      layers: [
        { id: "voice", type: "audio", trackId: "music", source: "assets/voice.wav", startMs: 0, durationMs: 1000 },
        { id: "sfx", type: "audio", trackId: "open", source: "assets/sfx.wav", startMs: 0, durationMs: 1000 },
        { id: "free", type: "audio", trackId: "open", source: "assets/free.wav", startMs: 0, durationMs: 1000 }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    expect(timelineLayerSoloedTrackId(motion, motion.layers[0])).toBe("music");
    expect(timelineLayerSoloedTrackId(motion, motion.layers[1])).toBe("stale-ref");
    expect(timelineLayerSoloedTrackId(motion, motion.layers[2])).toBeNull();
  });

  it("finds track volume for audio render gain by direct and track-order refs", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      tracks: [
        { id: "music", type: "audio", volume: 0.5, layerIds: [] },
        { id: "stale-ref", type: "audio", volume: 0.25, layerIds: ["sfx"] },
        { id: "open", type: "audio", layerIds: ["voice"] }
      ],
      layers: [
        { id: "voice", type: "audio", trackId: "music", source: "assets/voice.wav", startMs: 0, durationMs: 1000 },
        { id: "sfx", type: "audio", trackId: "open", source: "assets/sfx.wav", startMs: 0, durationMs: 1000 },
        { id: "free", type: "audio", trackId: "open", source: "assets/free.wav", startMs: 0, durationMs: 1000 }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    expect(timelineLayerTrackVolume(motion, motion.layers[0])).toBe(0.5);
    expect(timelineLayerTrackVolume(motion, motion.layers[1])).toBe(0.25);
    expect(timelineLayerTrackVolume(motion, motion.layers[2])).toBeUndefined();
  });

  it("finds track fades for audio render controls by direct and track-order refs", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      tracks: [
        { id: "music", type: "audio", fadeInMs: 100, fadeOutMs: 200, layerIds: [] },
        { id: "stale-ref", type: "audio", fadeInMs: 80, layerIds: ["sfx"] },
        { id: "open", type: "audio", layerIds: ["voice"] }
      ],
      layers: [
        { id: "voice", type: "audio", trackId: "music", source: "assets/voice.wav", startMs: 0, durationMs: 1000 },
        { id: "sfx", type: "audio", trackId: "open", source: "assets/sfx.wav", startMs: 0, durationMs: 1000 },
        { id: "free", type: "audio", trackId: "open", source: "assets/free.wav", startMs: 0, durationMs: 1000 }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    expect(timelineLayerTrackFade(motion, motion.layers[0])).toEqual({ fadeInMs: 100, fadeOutMs: 200 });
    expect(timelineLayerTrackFade(motion, motion.layers[1])).toEqual({ fadeInMs: 80 });
    expect(timelineLayerTrackFade(motion, motion.layers[2])).toEqual({});
  });

  it("finds track pan for audio render controls by direct and track-order refs", () => {
    const timelineLayerTrackPan = (timeline as { timelineLayerTrackPan?: (motion: MotionDocument, layer: MotionLayer) => number | undefined }).timelineLayerTrackPan;
    expect(typeof timelineLayerTrackPan).toBe("function");
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      tracks: [
        { id: "music", type: "audio", pan: -0.5, layerIds: [] },
        { id: "stale-ref", type: "audio", pan: 0.75, layerIds: ["sfx"] },
        { id: "open", type: "audio", layerIds: ["voice"] }
      ],
      layers: [
        { id: "voice", type: "audio", trackId: "music", source: "assets/voice.wav", startMs: 0, durationMs: 1000 },
        { id: "sfx", type: "audio", trackId: "open", source: "assets/sfx.wav", startMs: 0, durationMs: 1000 },
        { id: "free", type: "audio", trackId: "open", source: "assets/free.wav", startMs: 0, durationMs: 1000 }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    expect(timelineLayerTrackPan!(motion, motion.layers[0])).toBe(-0.5);
    expect(timelineLayerTrackPan!(motion, motion.layers[1])).toBe(0.75);
    expect(timelineLayerTrackPan!(motion, motion.layers[2])).toBeUndefined();
  });

  it("upserts layer keyframes deterministically for timeline controls", () => {
    const layer: MotionLayer = {
      id: "title",
      type: "text",
      text: "Anna",
      startMs: 0,
      durationMs: 1000,
      keyframes: {
        opacity: [
          { atMs: 0, value: 0, easing: "linear" },
          { atMs: 1000, value: 1 }
        ]
      }
    };

    const inserted = upsertLayerKeyframe(layer, {
      target: "opacity",
      atMs: 500,
      value: 0.75,
      easing: "ease-out"
    });
    const replaced = upsertLayerKeyframe(inserted.layer, {
      target: "opacity",
      atMs: 0,
      value: 0.2,
      easing: "hold"
    });

    expect(layer.keyframes?.opacity).toEqual([
      { atMs: 0, value: 0, easing: "linear" },
      { atMs: 1000, value: 1 }
    ]);
    expect(inserted).toEqual({
      layer: expect.objectContaining({
        keyframes: {
          opacity: [
            { atMs: 0, value: 0, easing: "linear" },
            { atMs: 500, value: 0.75, easing: "ease-out" },
            { atMs: 1000, value: 1 }
          ]
        }
      }),
      changedPath: "/layers/title/keyframes/opacity/500",
      action: "inserted"
    });
    expect(replaced).toEqual({
      layer: expect.objectContaining({
        keyframes: {
          opacity: [
            { atMs: 0, value: 0.2, easing: "hold" },
            { atMs: 500, value: 0.75, easing: "ease-out" },
            { atMs: 1000, value: 1 }
          ]
        }
      }),
      changedPath: "/layers/title/keyframes/opacity/0",
      action: "replaced"
    });
  });

  it("upserts color keyframes through the same timeline control path", () => {
    const layer: MotionLayer = {
      id: "panel",
      type: "shape",
      shape: "rect",
      fill: "#111827",
      startMs: 0,
      durationMs: 1000
    };

    const inserted = upsertLayerKeyframe(layer, {
      target: "style.fill",
      atMs: 250,
      value: "#00ff00",
      easing: "ease-out"
    });

    expect(inserted).toEqual({
      layer: {
        ...layer,
        keyframes: {
          "style.fill": [{ atMs: 250, value: "#00ff00", easing: "ease-out" }]
        }
      },
      changedPath: "/layers/panel/keyframes/style.fill/250",
      action: "inserted"
    });
  });

  it("deletes layer keyframes and prunes empty keyframe targets", () => {
    const layer: MotionLayer = {
      id: "title",
      type: "text",
      text: "Anna",
      startMs: 0,
      durationMs: 1000,
      keyframes: {
        opacity: [
          { atMs: 0, value: 0, easing: "linear" },
          { atMs: 500, value: 1 }
        ],
        "transform.x": [
          { atMs: 250, value: 42, easing: "ease-out" }
        ]
      }
    };

    const deleted = deleteLayerKeyframe(layer, { target: "opacity", atMs: 0 });
    const pruned = deleteLayerKeyframe(deleted.layer, { target: "transform.x", atMs: 250 });
    const fullyPruned = deleteLayerKeyframe(pruned.layer, { target: "opacity", atMs: 500 });

    expect(layer.keyframes).toEqual({
      opacity: [
        { atMs: 0, value: 0, easing: "linear" },
        { atMs: 500, value: 1 }
      ],
      "transform.x": [
        { atMs: 250, value: 42, easing: "ease-out" }
      ]
    });
    expect(deleted).toEqual({
      layer: expect.objectContaining({
        keyframes: {
          opacity: [{ atMs: 500, value: 1 }],
          "transform.x": [{ atMs: 250, value: 42, easing: "ease-out" }]
        }
      }),
      changedPath: "/layers/title/keyframes/opacity/0",
      action: "deleted",
      removed: { atMs: 0, value: 0, easing: "linear" },
      remainingCount: 1
    });
    expect(pruned.layer.keyframes).toEqual({
      opacity: [{ atMs: 500, value: 1 }]
    });
    expect(pruned).toMatchObject({
      changedPath: "/layers/title/keyframes/transform.x/250",
      action: "deleted",
      removed: { atMs: 250, value: 42, easing: "ease-out" },
      remainingCount: 0
    });
    expect(fullyPruned).toMatchObject({
      changedPath: "/layers/title/keyframes/opacity/500",
      action: "deleted",
      removed: { atMs: 500, value: 1 },
      remainingCount: 0
    });
    expect(fullyPruned.layer.keyframes).toBeUndefined();
    expect("keyframes" in fullyPruned.layer).toBe(false);
  });

  it("moves layer keyframes without changing value or easing", () => {
    const moveLayerKeyframe = (timeline as {
      moveLayerKeyframe?: (layer: MotionLayer, input: { target: string; fromMs: number; toMs: number }) => unknown;
    }).moveLayerKeyframe;
    expect(typeof moveLayerKeyframe).toBe("function");
    const layer: MotionLayer = {
      id: "title",
      type: "text",
      text: "Anna",
      startMs: 0,
      durationMs: 1200,
      keyframes: {
        opacity: [
          { atMs: 0, value: 0, easing: "linear" },
          { atMs: 500, value: 0.5, easing: "ease-out" },
          { atMs: 1000, value: 1 }
        ]
      }
    };

    const moved = moveLayerKeyframe!(layer, { target: "opacity", fromMs: 500, toMs: 750 });

    expect(layer.keyframes?.opacity).toEqual([
      { atMs: 0, value: 0, easing: "linear" },
      { atMs: 500, value: 0.5, easing: "ease-out" },
      { atMs: 1000, value: 1 }
    ]);
    expect(moved).toEqual({
      layer: expect.objectContaining({
        keyframes: {
          opacity: [
            { atMs: 0, value: 0, easing: "linear" },
            { atMs: 750, value: 0.5, easing: "ease-out" },
            { atMs: 1000, value: 1 }
          ]
        }
      }),
      changedPaths: [
        "/layers/title/keyframes/opacity/500",
        "/layers/title/keyframes/opacity/750"
      ],
      action: "moved",
      target: "opacity",
      fromMs: 500,
      toMs: 750,
      previousKeyframe: { atMs: 500, value: 0.5, easing: "ease-out" },
      keyframe: { atMs: 750, value: 0.5, easing: "ease-out" }
    });
  });

  it("applies easing to a selected keyframe range", () => {
    const applyLayerKeyframeEasing = (timeline as {
      applyLayerKeyframeEasing?: (layer: MotionLayer, input: { target: string; easing: string; startMs?: number; endMs?: number }) => unknown;
    }).applyLayerKeyframeEasing;
    expect(typeof applyLayerKeyframeEasing).toBe("function");
    const layer: MotionLayer = {
      id: "title",
      type: "text",
      text: "Anna",
      startMs: 0,
      durationMs: 1200,
      keyframes: {
        opacity: [
          { atMs: 0, value: 0, easing: "linear" },
          { atMs: 500, value: 0.5, easing: "ease-in" },
          { atMs: 1000, value: 1 }
        ],
        "transform.x": [{ atMs: 500, value: 120, easing: "linear" }]
      }
    };

    const applied = applyLayerKeyframeEasing!(layer, {
      target: "opacity",
      easing: "ease-in-out",
      startMs: 0,
      endMs: 600
    });

    expect(layer.keyframes?.opacity?.[0]?.easing).toBe("linear");
    expect(applied).toEqual({
      layer: expect.objectContaining({
        keyframes: {
          opacity: [
            { atMs: 0, value: 0, easing: "ease-in-out" },
            { atMs: 500, value: 0.5, easing: "ease-in-out" },
            { atMs: 1000, value: 1 }
          ],
          "transform.x": [{ atMs: 500, value: 120, easing: "linear" }]
        }
      }),
      changedPaths: [
        "/layers/title/keyframes/opacity/0/easing",
        "/layers/title/keyframes/opacity/500/easing"
      ],
      action: "updated",
      target: "opacity",
      easing: "ease-in-out",
      updatedKeyframes: [
        { atMs: 0, value: 0, oldEasing: "linear", newEasing: "ease-in-out" },
        { atMs: 500, value: 0.5, oldEasing: "ease-in", newEasing: "ease-in-out" }
      ]
    });
  });

  it("applies reusable animation presets as deterministic multi-target keyframes", () => {
    const applyLayerAnimationPreset = (timeline as {
      applyLayerAnimationPreset?: (layer: MotionLayer, input: { preset: string; durationMs?: number; distancePx?: number }) => unknown;
    }).applyLayerAnimationPreset;
    expect(typeof applyLayerAnimationPreset).toBe("function");
    const layer: MotionLayer = {
      id: "lower",
      type: "text",
      text: "Anna",
      startMs: 100,
      durationMs: 1000,
      opacity: 1,
      transform: { x: 120, y: 420, scale: 1 },
      keyframes: {
        "transform.scale": [{ atMs: 100, value: 0.95, easing: "linear" }]
      }
    };

    const applied = applyLayerAnimationPreset!(layer, {
      preset: "lower-third-in",
      durationMs: 400,
      distancePx: 64
    });

    expect(layer.keyframes).toEqual({
      "transform.scale": [{ atMs: 100, value: 0.95, easing: "linear" }]
    });
    expect(applied).toEqual({
      layer: expect.objectContaining({
        keyframes: {
          "transform.scale": [{ atMs: 100, value: 0.95, easing: "linear" }],
          opacity: [
            { atMs: 100, value: 0, easing: "ease-out" },
            { atMs: 500, value: 1 }
          ],
          "transform.y": [
            { atMs: 100, value: 484, easing: "ease-out" },
            { atMs: 500, value: 420 }
          ]
        }
      }),
      changedPaths: [
        "/layers/lower/keyframes/opacity/100",
        "/layers/lower/keyframes/opacity/500",
        "/layers/lower/keyframes/transform.y/100",
        "/layers/lower/keyframes/transform.y/500"
      ],
      action: "applied",
      preset: "lower-third-in",
      timing: { startMs: 100, endMs: 500, durationMs: 400 },
      appliedKeyframes: [
        { target: "opacity", atMs: 100, value: 0, easing: "ease-out" },
        { target: "opacity", atMs: 500, value: 1 },
        { target: "transform.y", atMs: 100, value: 484, easing: "ease-out" },
        { target: "transform.y", atMs: 500, value: 420 }
      ],
      // The preset only inserts here — the layer's one existing keyframe is on transform.scale,
      // which no lower-third-in keyframe touches. See keyframe-mutation-safety.test.ts for the
      // overwrite direction.
      replacedKeyframes: []
    });

    const start = effectiveLayerAtMs((applied as { layer: MotionLayer }).layer, 100);
    const end = effectiveLayerAtMs((applied as { layer: MotionLayer }).layer, 500);
    expect(start.opacity).toBe(0);
    expect(start.transform?.y).toBe(484);
    expect(end.opacity).toBe(1);
    expect(end.transform?.y).toBe(420);
  });

  it("applies reusable animation presets across layers with deterministic stagger timing", () => {
    const applyLayerGroupAnimationPreset = (timeline as {
      applyLayerGroupAnimationPreset?: (
        layers: MotionLayer[],
        input: { layerIds: string[]; preset: string; startMs?: number; durationMs?: number; staggerMs?: number; distancePx?: number }
      ) => unknown;
    }).applyLayerGroupAnimationPreset;
    expect(typeof applyLayerGroupAnimationPreset).toBe("function");
    const layers: MotionLayer[] = [
      {
        id: "title",
        type: "text",
        text: "Title",
        startMs: 0,
        durationMs: 2000,
        opacity: 1,
        transform: { y: 240 }
      },
      {
        id: "subtitle",
        type: "text",
        text: "Subtitle",
        startMs: 0,
        durationMs: 2000,
        opacity: 0.8,
        transform: { y: 320 }
      },
      {
        id: "badge",
        type: "shape",
        startMs: 0,
        durationMs: 2000,
        opacity: 1,
        transform: { y: 120 }
      }
    ];

    const applied = applyLayerGroupAnimationPreset!(layers, {
      layerIds: ["subtitle", "title"],
      preset: "lower-third-in",
      startMs: 100,
      durationMs: 300,
      staggerMs: 120,
      distancePx: 40
    });

    expect(layers[0].keyframes).toBeUndefined();
    expect(applied).toEqual({
      layers: [
        expect.objectContaining({
          id: "title",
          keyframes: {
            opacity: [
              { atMs: 220, value: 0, easing: "ease-out" },
              { atMs: 520, value: 1 }
            ],
            "transform.y": [
              { atMs: 220, value: 280, easing: "ease-out" },
              { atMs: 520, value: 240 }
            ]
          }
        }),
        expect.objectContaining({
          id: "subtitle",
          keyframes: {
            opacity: [
              { atMs: 100, value: 0, easing: "ease-out" },
              { atMs: 400, value: 0.8 }
            ],
            "transform.y": [
              { atMs: 100, value: 360, easing: "ease-out" },
              { atMs: 400, value: 320 }
            ]
          }
        }),
        expect.objectContaining({ id: "badge" })
      ],
      changedPaths: [
        "/layers/subtitle/keyframes/opacity/100",
        "/layers/subtitle/keyframes/opacity/400",
        "/layers/subtitle/keyframes/transform.y/100",
        "/layers/subtitle/keyframes/transform.y/400",
        "/layers/title/keyframes/opacity/220",
        "/layers/title/keyframes/opacity/520",
        "/layers/title/keyframes/transform.y/220",
        "/layers/title/keyframes/transform.y/520"
      ],
      action: "applied",
      preset: "lower-third-in",
      staggerMs: 120,
      applications: [
        expect.objectContaining({
          layerId: "subtitle",
          timing: { startMs: 100, endMs: 400, durationMs: 300 },
          appliedKeyframes: expect.arrayContaining([
            { target: "opacity", atMs: 100, value: 0, easing: "ease-out" },
            { target: "transform.y", atMs: 400, value: 320 }
          ])
        }),
        expect.objectContaining({
          layerId: "title",
          timing: { startMs: 220, endMs: 520, durationMs: 300 },
          appliedKeyframes: expect.arrayContaining([
            { target: "opacity", atMs: 220, value: 0, easing: "ease-out" },
            { target: "transform.y", atMs: 520, value: 240 }
          ])
        })
      ]
    });
    expect((applied as { layers: MotionLayer[] }).layers[2].keyframes).toBeUndefined();
  });

  it("lists animation presets and rejects invalid preset timing", () => {
    const listMotionAnimationPresets = (timeline as {
      listMotionAnimationPresets?: () => Array<{ id: string; targets: string[] }>;
    }).listMotionAnimationPresets;
    const applyLayerAnimationPreset = (timeline as {
      applyLayerAnimationPreset?: (layer: MotionLayer, input: { preset: string; startMs?: number; durationMs?: number; distancePx?: number }) => unknown;
    }).applyLayerAnimationPreset;
    expect(typeof listMotionAnimationPresets).toBe("function");
    expect(typeof applyLayerAnimationPreset).toBe("function");
    const layer: MotionLayer = {
      id: "title",
      type: "text",
      text: "Title",
      startMs: 200,
      durationMs: 300,
      transform: { y: 24 }
    };

    expect(listMotionAnimationPresets!()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "fade-in", targets: ["opacity"] }),
      expect.objectContaining({ id: "lower-third-in", targets: ["opacity", "transform.y"] })
    ]));
    expect(() => applyLayerAnimationPreset!(layer, { preset: "bounce-in", durationMs: 100 })).toThrow("Unsupported animation preset: bounce-in.");
    expect(() => applyLayerAnimationPreset!(layer, { preset: "fade-in", durationMs: 0 })).toThrow("Animation preset durationMs must be a positive finite number.");
    expect(() => applyLayerAnimationPreset!(layer, { preset: "fade-in", startMs: 100, durationMs: 250 })).toThrow("Animation preset timing must fit within the layer duration.");
  });

  it("rejects invalid no-op and colliding keyframe move and easing edits", () => {
    const moveLayerKeyframe = (timeline as {
      moveLayerKeyframe?: (layer: MotionLayer, input: { target: string; fromMs: number; toMs: number }) => unknown;
    }).moveLayerKeyframe;
    const applyLayerKeyframeEasing = (timeline as {
      applyLayerKeyframeEasing?: (layer: MotionLayer, input: { target: string; easing: string; atMs?: number; startMs?: number; endMs?: number }) => unknown;
    }).applyLayerKeyframeEasing;
    expect(typeof moveLayerKeyframe).toBe("function");
    expect(typeof applyLayerKeyframeEasing).toBe("function");
    const layer: MotionLayer = {
      id: "title",
      type: "text",
      text: "Anna",
      startMs: 0,
      durationMs: 1000,
      keyframes: {
        opacity: [
          { atMs: 0, value: 0, easing: "linear" },
          { atMs: 500, value: 1, easing: "linear" }
        ]
      }
    };

    expect(() => moveLayerKeyframe!(layer, { target: "opacity", fromMs: -1, toMs: 100 })).toThrow("fromMs and toMs must be non-negative finite numbers.");
    expect(() => moveLayerKeyframe!(layer, { target: "opacity", fromMs: 0, toMs: 0 })).toThrow("Keyframe move did not change timestamp.");
    expect(() => moveLayerKeyframe!(layer, { target: "opacity", fromMs: 200, toMs: 300 })).toThrow("No keyframe found for opacity at 200ms.");
    expect(() => moveLayerKeyframe!(layer, { target: "opacity", fromMs: 0, toMs: 500 })).toThrow("Keyframe already exists for opacity at 500ms.");
    expect(() => applyLayerKeyframeEasing!(layer, { target: "opacity", easing: "bounce" })).toThrow("Unsupported keyframe easing: bounce");
    expect(() => applyLayerKeyframeEasing!(layer, { target: "opacity", easing: "linear", atMs: 0 })).toThrow("Keyframe easing did not change.");
    expect(() => applyLayerKeyframeEasing!(layer, { target: "opacity", easing: "ease-out", startMs: 700, endMs: 900 })).toThrow("No keyframes found for opacity in requested range.");
  });

  it("shifts a layer keyframe range while preserving values easing and sort order", () => {
    const shiftLayerKeyframes = (timeline as {
      shiftLayerKeyframes?: (layer: MotionLayer, input: { target: string; deltaMs: number; startMs?: number; endMs?: number }) => unknown;
    }).shiftLayerKeyframes;
    expect(typeof shiftLayerKeyframes).toBe("function");
    const layer: MotionLayer = {
      id: "title",
      type: "text",
      text: "Anna",
      startMs: 0,
      durationMs: 1200,
      keyframes: {
        opacity: [
          { atMs: 0, value: 0, easing: "linear" },
          { atMs: 250, value: 0.5, easing: "ease-out" },
          { atMs: 500, value: 1 }
        ],
        "transform.x": [{ atMs: 250, value: 120, easing: "linear" }]
      }
    };

    const shifted = shiftLayerKeyframes!(layer, { target: "opacity", deltaMs: 100, startMs: 0, endMs: 250 });

    expect(layer.keyframes?.opacity?.map((keyframe) => keyframe.atMs)).toEqual([0, 250, 500]);
    expect(shifted).toEqual({
      layer: expect.objectContaining({
        keyframes: {
          opacity: [
            { atMs: 100, value: 0, easing: "linear" },
            { atMs: 350, value: 0.5, easing: "ease-out" },
            { atMs: 500, value: 1 }
          ],
          "transform.x": [{ atMs: 250, value: 120, easing: "linear" }]
        }
      }),
      changedPaths: [
        "/layers/title/keyframes/opacity/0",
        "/layers/title/keyframes/opacity/100",
        "/layers/title/keyframes/opacity/250",
        "/layers/title/keyframes/opacity/350"
      ],
      action: "shifted",
      target: "opacity",
      deltaMs: 100,
      startMs: 0,
      endMs: 250,
      shiftedKeyframes: [
        { target: "opacity", fromMs: 0, toMs: 100, value: 0, easing: "linear" },
        { target: "opacity", fromMs: 250, toMs: 350, value: 0.5, easing: "ease-out" }
      ]
    });
  });

  it("scales a layer keyframe range around an origin while preserving values easing and sort order", () => {
    const scaleLayerKeyframes = (timeline as {
      scaleLayerKeyframes?: (layer: MotionLayer, input: { target: string; scale: number; originMs: number; startMs?: number; endMs?: number }) => unknown;
    }).scaleLayerKeyframes;
    expect(typeof scaleLayerKeyframes).toBe("function");
    const layer: MotionLayer = {
      id: "title",
      type: "text",
      text: "Anna",
      startMs: 0,
      durationMs: 1200,
      keyframes: {
        opacity: [
          { atMs: 100, value: 0 },
          { atMs: 200, value: 0.25, easing: "linear" },
          { atMs: 400, value: 0.75, easing: "ease-out" },
          { atMs: 900, value: 1 }
        ],
        "transform.x": [{ atMs: 400, value: 120, easing: "linear" }]
      }
    };

    const scaled = scaleLayerKeyframes!(layer, { target: "opacity", scale: 2, originMs: 100, startMs: 200, endMs: 400 });

    expect(layer.keyframes?.opacity?.map((keyframe) => keyframe.atMs)).toEqual([100, 200, 400, 900]);
    expect(scaled).toEqual({
      layer: expect.objectContaining({
        keyframes: {
          opacity: [
            { atMs: 100, value: 0 },
            { atMs: 300, value: 0.25, easing: "linear" },
            { atMs: 700, value: 0.75, easing: "ease-out" },
            { atMs: 900, value: 1 }
          ],
          "transform.x": [{ atMs: 400, value: 120, easing: "linear" }]
        }
      }),
      changedPaths: [
        "/layers/title/keyframes/opacity/200",
        "/layers/title/keyframes/opacity/300",
        "/layers/title/keyframes/opacity/400",
        "/layers/title/keyframes/opacity/700"
      ],
      action: "scaled",
      target: "opacity",
      scale: 2,
      originMs: 100,
      startMs: 200,
      endMs: 400,
      scaledKeyframes: [
        { target: "opacity", fromMs: 200, toMs: 300, value: 0.25, easing: "linear" },
        { target: "opacity", fromMs: 400, toMs: 700, value: 0.75, easing: "ease-out" }
      ]
    });
  });

  it("duplicates a layer keyframe range by offset while preserving originals values easing and sort order", () => {
    const duplicateLayerKeyframes = (timeline as {
      duplicateLayerKeyframes?: (layer: MotionLayer, input: { target: string; deltaMs: number; startMs?: number; endMs?: number }) => unknown;
    }).duplicateLayerKeyframes;
    expect(typeof duplicateLayerKeyframes).toBe("function");
    const layer: MotionLayer = {
      id: "title",
      type: "text",
      text: "Anna",
      startMs: 0,
      durationMs: 1200,
      keyframes: {
        opacity: [
          { atMs: 0, value: 0, easing: "linear" },
          { atMs: 200, value: 0.5, easing: "ease-out" },
          { atMs: 500, value: 1 }
        ],
        "transform.x": [{ atMs: 200, value: 120, easing: "linear" }]
      }
    };

    const duplicated = duplicateLayerKeyframes!(layer, { target: "opacity", deltaMs: 400, startMs: 0, endMs: 200 });

    expect(layer.keyframes?.opacity?.map((keyframe) => keyframe.atMs)).toEqual([0, 200, 500]);
    expect(duplicated).toEqual({
      layer: expect.objectContaining({
        keyframes: {
          opacity: [
            { atMs: 0, value: 0, easing: "linear" },
            { atMs: 200, value: 0.5, easing: "ease-out" },
            { atMs: 400, value: 0, easing: "linear" },
            { atMs: 500, value: 1 },
            { atMs: 600, value: 0.5, easing: "ease-out" }
          ],
          "transform.x": [{ atMs: 200, value: 120, easing: "linear" }]
        }
      }),
      changedPaths: [
        "/layers/title/keyframes/opacity/400",
        "/layers/title/keyframes/opacity/600"
      ],
      action: "duplicated",
      target: "opacity",
      deltaMs: 400,
      startMs: 0,
      endMs: 200,
      duplicatedKeyframes: [
        { target: "opacity", fromMs: 0, toMs: 400, value: 0, easing: "linear" },
        { target: "opacity", fromMs: 200, toMs: 600, value: 0.5, easing: "ease-out" }
      ]
    });
  });

  it("deletes a layer keyframe range and prunes empty targets while preserving other animation", () => {
    const deleteLayerKeyframeRange = timeline.deleteLayerKeyframeRange;
    expect(typeof deleteLayerKeyframeRange).toBe("function");
    const layer: MotionLayer = {
      id: "title",
      type: "text",
      text: "Anna",
      startMs: 0,
      durationMs: 1200,
      keyframes: {
        opacity: [
          { atMs: 0, value: 0, easing: "linear" },
          { atMs: 200, value: 0.5, easing: "ease-out" },
          { atMs: 500, value: 1 }
        ],
        "transform.x": [{ atMs: 200, value: 120, easing: "linear" }]
      }
    };

    const deleted = deleteLayerKeyframeRange!(layer, { target: "opacity", startMs: 0, endMs: 200 });

    expect(layer.keyframes?.opacity?.map((keyframe) => keyframe.atMs)).toEqual([0, 200, 500]);
    expect(deleted).toEqual({
      layer: expect.objectContaining({
        keyframes: {
          opacity: [{ atMs: 500, value: 1 }],
          "transform.x": [{ atMs: 200, value: 120, easing: "linear" }]
        }
      }),
      changedPaths: [
        "/layers/title/keyframes/opacity/0",
        "/layers/title/keyframes/opacity/200"
      ],
      action: "deleted",
      target: "opacity",
      startMs: 0,
      endMs: 200,
      removedKeyframes: [
        { target: "opacity", atMs: 0, value: 0, easing: "linear" },
        { target: "opacity", atMs: 200, value: 0.5, easing: "ease-out" }
      ],
      remainingCount: 1
    });

    const pruned = deleteLayerKeyframeRange!(deleted.layer as MotionLayer, { target: "opacity", startMs: 500, endMs: 500 });
    expect(pruned).toEqual({
      layer: expect.objectContaining({
        keyframes: {
          "transform.x": [{ atMs: 200, value: 120, easing: "linear" }]
        }
      }),
      changedPaths: ["/layers/title/keyframes/opacity/500"],
      action: "deleted",
      target: "opacity",
      startMs: 500,
      endMs: 500,
      removedKeyframes: [{ target: "opacity", atMs: 500, value: 1 }],
      remainingCount: 0
    });
    expect((pruned.layer as MotionLayer).keyframes?.opacity).toBeUndefined();
  });

  it("rejects invalid and empty keyframe range deletes", () => {
    const deleteLayerKeyframeRange = timeline.deleteLayerKeyframeRange;
    expect(typeof deleteLayerKeyframeRange).toBe("function");
    const layer: MotionLayer = {
      id: "title",
      type: "text",
      text: "Anna",
      startMs: 0,
      durationMs: 1000,
      keyframes: {
        opacity: [
          { atMs: 0, value: 0 },
          { atMs: 200, value: 0.5 },
          { atMs: 500, value: 1 }
        ]
      }
    };

    expect(() => deleteLayerKeyframeRange!(layer, { target: "opacity", startMs: -1, endMs: 100 })).toThrow("startMs must be a non-negative finite number.");
    expect(() => deleteLayerKeyframeRange!(layer, { target: "opacity", startMs: 500, endMs: 200 })).toThrow("Keyframe range delete startMs must be less than or equal to endMs.");
    expect(() => deleteLayerKeyframeRange!(layer, { target: "opacity", startMs: 700, endMs: 800 })).toThrow("No keyframes found for opacity in requested range.");
    expect(() => deleteLayerKeyframeRange!(layer, { target: "effects.unknown" as MotionKeyframeTarget, startMs: 0, endMs: 200 })).toThrow("Unsupported keyframe target: effects.unknown");
  });

  it("distributes a layer keyframe range evenly while preserving values easing and other targets", () => {
    const distributeLayerKeyframes = (timeline as {
      distributeLayerKeyframes?: (layer: MotionLayer, input: { target: string; startMs?: number; endMs?: number }) => unknown;
    }).distributeLayerKeyframes;
    expect(typeof distributeLayerKeyframes).toBe("function");
    const layer: MotionLayer = {
      id: "title",
      type: "text",
      text: "Anna",
      startMs: 0,
      durationMs: 1200,
      keyframes: {
        opacity: [
          { atMs: 0, value: 0, easing: "linear" },
          { atMs: 120, value: 0.5, easing: "ease-out" },
          { atMs: 500, value: 1 }
        ],
        "transform.x": [{ atMs: 200, value: 120, easing: "linear" }]
      }
    };

    const distributed = distributeLayerKeyframes!(layer, { target: "opacity", startMs: 0, endMs: 500 });

    expect(layer.keyframes?.opacity?.map((keyframe) => keyframe.atMs)).toEqual([0, 120, 500]);
    expect(distributed).toEqual({
      layer: expect.objectContaining({
        keyframes: {
          opacity: [
            { atMs: 0, value: 0, easing: "linear" },
            { atMs: 250, value: 0.5, easing: "ease-out" },
            { atMs: 500, value: 1 }
          ],
          "transform.x": [{ atMs: 200, value: 120, easing: "linear" }]
        }
      }),
      changedPaths: [
        "/layers/title/keyframes/opacity/120",
        "/layers/title/keyframes/opacity/250"
      ],
      action: "distributed",
      target: "opacity",
      startMs: 0,
      endMs: 500,
      spacingMs: 250,
      distributedKeyframes: [
        { target: "opacity", fromMs: 120, toMs: 250, value: 0.5, easing: "ease-out" }
      ]
    });
  });

  it("rejects invalid short and already-even keyframe distributions", () => {
    const distributeLayerKeyframes = (timeline as {
      distributeLayerKeyframes?: (layer: MotionLayer, input: { target: string; startMs?: number; endMs?: number }) => unknown;
    }).distributeLayerKeyframes!;
    const layer: MotionLayer = {
      id: "title",
      type: "text",
      text: "Anna",
      startMs: 0,
      durationMs: 1000,
      keyframes: { opacity: [{ atMs: 0, value: 0 }, { atMs: 200, value: 0.5 }, { atMs: 400, value: 1 }] }
    };
    expect(() => distributeLayerKeyframes(layer, { target: "opacity", startMs: -1, endMs: 400 })).toThrow("startMs must be a non-negative finite number.");
    expect(() => distributeLayerKeyframes(layer, { target: "opacity", startMs: 500, endMs: 200 })).toThrow("Keyframe distribute range startMs must be less than or equal to endMs.");
    expect(() => distributeLayerKeyframes(layer, { target: "opacity", startMs: 0, endMs: 200 })).toThrow("At least three opacity keyframes are required to distribute a range.");
    expect(() => distributeLayerKeyframes(layer, { target: "opacity", startMs: 0, endMs: 400 })).toThrow("Keyframes are already evenly distributed.");
  });

  it("reverses a layer keyframe range while preserving values easing and other targets", () => {
    const reverseLayerKeyframes = (timeline as {
      reverseLayerKeyframes?: (layer: MotionLayer, input: { target: string; startMs?: number; endMs?: number }) => unknown;
    }).reverseLayerKeyframes;
    expect(typeof reverseLayerKeyframes).toBe("function");
    const layer: MotionLayer = {
      id: "title",
      type: "text",
      text: "Anna",
      startMs: 0,
      durationMs: 1200,
      keyframes: {
        opacity: [
          { atMs: 0, value: 0, easing: "linear" },
          { atMs: 200, value: 0.5, easing: "ease-out" },
          { atMs: 500, value: 1 }
        ],
        "transform.x": [{ atMs: 200, value: 120, easing: "linear" }]
      }
    };

    const reversed = reverseLayerKeyframes!(layer, { target: "opacity", startMs: 0, endMs: 500 });

    expect(layer.keyframes?.opacity?.map((keyframe) => keyframe.atMs)).toEqual([0, 200, 500]);
    expect(reversed).toEqual({
      layer: expect.objectContaining({
        keyframes: {
          opacity: [
            { atMs: 0, value: 1 },
            { atMs: 300, value: 0.5, easing: "ease-out" },
            { atMs: 500, value: 0, easing: "linear" }
          ],
          "transform.x": [{ atMs: 200, value: 120, easing: "linear" }]
        }
      }),
      changedPaths: [
        "/layers/title/keyframes/opacity/0",
        "/layers/title/keyframes/opacity/500",
        "/layers/title/keyframes/opacity/200",
        "/layers/title/keyframes/opacity/300"
      ],
      action: "reversed",
      target: "opacity",
      startMs: 0,
      endMs: 500,
      reversedKeyframes: [
        { target: "opacity", fromMs: 0, toMs: 500, value: 0, easing: "linear" },
        { target: "opacity", fromMs: 200, toMs: 300, value: 0.5, easing: "ease-out" },
        { target: "opacity", fromMs: 500, toMs: 0, value: 1 }
      ]
    });
  });

  it("rejects invalid empty colliding and no-op keyframe range reverses", () => {
    const reverseLayerKeyframes = (timeline as {
      reverseLayerKeyframes?: (layer: MotionLayer, input: { target: string; startMs?: number; endMs?: number }) => unknown;
    }).reverseLayerKeyframes;
    expect(typeof reverseLayerKeyframes).toBe("function");
    const layer: MotionLayer = {
      id: "title",
      type: "text",
      text: "Anna",
      startMs: 0,
      durationMs: 1000,
      keyframes: {
        opacity: [
          { atMs: 0, value: 0 },
          { atMs: 200, value: 0.5 },
          { atMs: 500, value: 1 },
          { atMs: 800, value: 0.25 }
        ]
      }
    };

    expect(() => reverseLayerKeyframes!(layer, { target: "opacity", startMs: -1, endMs: 100 })).toThrow("startMs must be a non-negative finite number.");
    expect(() => reverseLayerKeyframes!(layer, { target: "opacity", startMs: 500, endMs: 200 })).toThrow("Keyframe reverse range startMs must be less than or equal to endMs.");
    expect(() => reverseLayerKeyframes!(layer, { target: "opacity", startMs: 900, endMs: 950 })).toThrow("No keyframes found for opacity in requested range.");
    expect(() => reverseLayerKeyframes!(layer, { target: "opacity", startMs: 200, endMs: 200 })).toThrow("Keyframe reverse did not change any timestamps.");
    expect(() => reverseLayerKeyframes!({
      ...layer,
      keyframes: { opacity: [{ atMs: 0, value: 0 }, { atMs: 0, value: 1 }] }
    }, { target: "opacity", startMs: 0, endMs: 100 })).toThrow("Keyframe reverse would collide with opacity at 100ms.");
  });

  it("snaps a layer keyframe range to a frame grid while preserving values easing and other targets", () => {
    const snapLayerKeyframes = (timeline as {
      snapLayerKeyframes?: (layer: MotionLayer, input: { target: string; fps: number; mode?: string; startMs?: number; endMs?: number }) => unknown;
    }).snapLayerKeyframes;
    expect(typeof snapLayerKeyframes).toBe("function");
    const layer: MotionLayer = {
      id: "title",
      type: "text",
      text: "Anna",
      startMs: 0,
      durationMs: 1200,
      keyframes: {
        opacity: [
          { atMs: 47, value: 0, easing: "linear" },
          { atMs: 151, value: 0.5, easing: "ease-out" },
          { atMs: 253, value: 1 },
          { atMs: 600, value: 0.75 }
        ],
        "transform.x": [{ atMs: 151, value: 120, easing: "linear" }]
      }
    };

    const snapped = snapLayerKeyframes!(layer, { target: "opacity", fps: 10, startMs: 0, endMs: 300 });

    expect(layer.keyframes?.opacity?.map((keyframe) => keyframe.atMs)).toEqual([47, 151, 253, 600]);
    expect(snapped).toEqual({
      layer: expect.objectContaining({
        keyframes: {
          opacity: [
            { atMs: 0, value: 0, easing: "linear" },
            { atMs: 200, value: 0.5, easing: "ease-out" },
            { atMs: 300, value: 1 },
            { atMs: 600, value: 0.75 }
          ],
          "transform.x": [{ atMs: 151, value: 120, easing: "linear" }]
        }
      }),
      changedPaths: [
        "/layers/title/keyframes/opacity/47",
        "/layers/title/keyframes/opacity/0",
        "/layers/title/keyframes/opacity/151",
        "/layers/title/keyframes/opacity/200",
        "/layers/title/keyframes/opacity/253",
        "/layers/title/keyframes/opacity/300"
      ],
      action: "snapped",
      target: "opacity",
      fps: 10,
      mode: "nearest",
      startMs: 0,
      endMs: 300,
      snappedKeyframes: [
        { target: "opacity", fromMs: 47, toMs: 0, value: 0, easing: "linear" },
        { target: "opacity", fromMs: 151, toMs: 200, value: 0.5, easing: "ease-out" },
        { target: "opacity", fromMs: 253, toMs: 300, value: 1 }
      ]
    });
  });

  it("rejects invalid empty colliding and no-op keyframe frame snaps", () => {
    const snapLayerKeyframes = (timeline as {
      snapLayerKeyframes?: (layer: MotionLayer, input: { target: string; fps: number; mode?: string; startMs?: number; endMs?: number }) => unknown;
    }).snapLayerKeyframes;
    expect(typeof snapLayerKeyframes).toBe("function");
    const layer: MotionLayer = {
      id: "title",
      type: "text",
      text: "Anna",
      startMs: 0,
      durationMs: 1000,
      keyframes: {
        opacity: [
          { atMs: 0, value: 0 },
          { atMs: 151, value: 0.5 },
          { atMs: 200, value: 0.75 },
          { atMs: 500, value: 1 },
          { atMs: 600, value: 0.25 }
        ]
      }
    };

    expect(() => snapLayerKeyframes!(layer, { target: "opacity", fps: 0 })).toThrow("fps must be a positive finite number.");
    expect(() => snapLayerKeyframes!(layer, { target: "opacity", fps: 10, mode: "random" })).toThrow("Unsupported keyframe snap mode: random");
    expect(() => snapLayerKeyframes!(layer, { target: "opacity", fps: 10, startMs: -1, endMs: 100 })).toThrow("startMs must be a non-negative finite number.");
    expect(() => snapLayerKeyframes!(layer, { target: "opacity", fps: 10, startMs: 500, endMs: 200 })).toThrow("Keyframe snap range startMs must be less than or equal to endMs.");
    expect(() => snapLayerKeyframes!(layer, { target: "opacity", fps: 10, startMs: 900, endMs: 950 })).toThrow("No keyframes found for opacity in requested range.");
    expect(() => snapLayerKeyframes!(layer, { target: "opacity", fps: 10, startMs: 0, endMs: 0 })).toThrow("Keyframe snap did not change any timestamps.");
    expect(() => snapLayerKeyframes!(layer, { target: "opacity", fps: 10, startMs: 140, endMs: 151 })).toThrow("Keyframe snap would collide with opacity at 200ms.");
  });

  it("rejects invalid colliding negative and empty keyframe range duplicates", () => {
    const duplicateLayerKeyframes = (timeline as {
      duplicateLayerKeyframes?: (layer: MotionLayer, input: { target: string; deltaMs: number; startMs?: number; endMs?: number }) => unknown;
    }).duplicateLayerKeyframes;
    expect(typeof duplicateLayerKeyframes).toBe("function");
    const layer: MotionLayer = {
      id: "title",
      type: "text",
      text: "Anna",
      startMs: 0,
      durationMs: 1000,
      keyframes: {
        opacity: [
          { atMs: 0, value: 0 },
          { atMs: 200, value: 0.5 },
          { atMs: 500, value: 1 }
        ]
      }
    };

    expect(() => duplicateLayerKeyframes!(layer, { target: "opacity", deltaMs: 0 })).toThrow("deltaMs must be a finite non-zero number.");
    expect(() => duplicateLayerKeyframes!(layer, { target: "opacity", deltaMs: -100, startMs: 0, endMs: 0 })).toThrow("Keyframe duplicate would place opacity copied from 0ms before 0ms.");
    expect(() => duplicateLayerKeyframes!(layer, { target: "opacity", deltaMs: 200, startMs: 0, endMs: 200 })).toThrow("Keyframe duplicate would collide with opacity at 200ms.");
    expect(() => duplicateLayerKeyframes!(layer, { target: "opacity", deltaMs: 25, startMs: 700, endMs: 800 })).toThrow("No keyframes found for opacity in requested range.");
    expect(() => duplicateLayerKeyframes!(layer, { target: "opacity", deltaMs: 25, startMs: 500, endMs: 200 })).toThrow("Keyframe duplicate range startMs must be less than or equal to endMs.");
  });

  it("rejects invalid no-op colliding and negative keyframe range scales", () => {
    const scaleLayerKeyframes = (timeline as {
      scaleLayerKeyframes?: (layer: MotionLayer, input: { target: string; scale: number; originMs: number; startMs?: number; endMs?: number }) => unknown;
    }).scaleLayerKeyframes;
    expect(typeof scaleLayerKeyframes).toBe("function");
    const layer: MotionLayer = {
      id: "title",
      type: "text",
      text: "Anna",
      startMs: 0,
      durationMs: 1000,
      keyframes: {
        opacity: [
          { atMs: 0, value: 0 },
          { atMs: 100, value: 0.3 },
          { atMs: 200, value: 0.6 },
          { atMs: 300, value: 1 }
        ]
      }
    };

    expect(() => scaleLayerKeyframes!(layer, { target: "opacity", scale: 1, originMs: 0 })).toThrow("scale must be a positive finite number other than 1.");
    expect(() => scaleLayerKeyframes!(layer, { target: "opacity", scale: 2, originMs: -1 })).toThrow("originMs must be a non-negative finite number.");
    expect(() => scaleLayerKeyframes!(layer, { target: "opacity", scale: 2, originMs: 0, startMs: 500, endMs: 400 })).toThrow("Keyframe scale range startMs must be less than or equal to endMs.");
    expect(() => scaleLayerKeyframes!(layer, { target: "opacity", scale: 2, originMs: 0, startMs: 700, endMs: 800 })).toThrow("No keyframes found for opacity in requested range.");
    expect(() => scaleLayerKeyframes!(layer, { target: "opacity", scale: 2, originMs: 500, startMs: 0, endMs: 0 })).toThrow("Keyframe scale would move opacity at 0ms before 0ms.");
    expect(() => scaleLayerKeyframes!(layer, { target: "opacity", scale: 2, originMs: 100, startMs: 200, endMs: 200 })).toThrow("Keyframe scale would collide with opacity at 300ms.");
    expect(() => scaleLayerKeyframes!(layer, { target: "opacity", scale: 2, originMs: 100, startMs: 100, endMs: 100 })).toThrow("Keyframe scale did not change any timestamps.");
  });

  it("rejects invalid no-op colliding and negative keyframe range shifts", () => {
    const shiftLayerKeyframes = (timeline as {
      shiftLayerKeyframes?: (layer: MotionLayer, input: { target: string; deltaMs: number; startMs?: number; endMs?: number }) => unknown;
    }).shiftLayerKeyframes;
    expect(typeof shiftLayerKeyframes).toBe("function");
    const layer: MotionLayer = {
      id: "title",
      type: "text",
      text: "Anna",
      startMs: 0,
      durationMs: 1000,
      keyframes: {
        opacity: [
          { atMs: 0, value: 0 },
          { atMs: 250, value: 0.5 },
          { atMs: 500, value: 1 }
        ]
      }
    };

    expect(() => shiftLayerKeyframes!(layer, { target: "opacity", deltaMs: 0 })).toThrow("deltaMs must be a finite non-zero number.");
    expect(() => shiftLayerKeyframes!(layer, { target: "opacity", deltaMs: -100, startMs: 0, endMs: 0 })).toThrow("Keyframe shift would move opacity at 0ms before 0ms.");
    expect(() => shiftLayerKeyframes!(layer, { target: "opacity", deltaMs: 250, startMs: 0, endMs: 250 })).toThrow("Keyframe shift would collide with opacity at 500ms.");
    expect(() => shiftLayerKeyframes!(layer, { target: "opacity", deltaMs: 25, startMs: 700, endMs: 800 })).toThrow("No keyframes found for opacity in requested range.");
    expect(() => shiftLayerKeyframes!(layer, { target: "opacity", deltaMs: 25, startMs: 500, endMs: 250 })).toThrow("Keyframe shift range startMs must be less than or equal to endMs.");
  });

  it("rejects deletion for unsupported or missing keyframes", () => {
    const layer: MotionLayer = {
      id: "title",
      type: "text",
      text: "Anna",
      startMs: 0,
      durationMs: 1000,
      keyframes: {
        opacity: [{ atMs: 500, value: 1 }]
      }
    };

    expect(() => deleteLayerKeyframe(layer, { target: "opacity", atMs: 999 })).toThrow("No keyframe found");
    expect(() => deleteLayerKeyframe(layer, { target: "opacity", atMs: -1 })).toThrow("Keyframe atMs must be a non-negative finite number.");
  });

  it("trims layer timing and media source ranges immutably", () => {
    const layer: MotionLayer = {
      id: "clip",
      type: "video",
      source: "assets/clip.mp4",
      startMs: 100,
      durationMs: 900,
      trimStartMs: 20,
      trimDurationMs: 800
    };

    const trimmed = trimLayerTiming(layer, {
      startMs: 200,
      durationMs: 650,
      trimStartMs: 80,
      trimDurationMs: 500
    });

    expect(layer).toMatchObject({
      startMs: 100,
      durationMs: 900,
      trimStartMs: 20,
      trimDurationMs: 800
    });
    expect(trimmed).toEqual({
      layer: expect.objectContaining({
        startMs: 200,
        durationMs: 650,
        trimStartMs: 80,
        trimDurationMs: 500
      }),
      changedPaths: [
        "/layers/clip/startMs",
        "/layers/clip/durationMs",
        "/layers/clip/trimStartMs",
        "/layers/clip/trimDurationMs"
      ],
      action: "updated",
      oldTiming: {
        startMs: 100,
        durationMs: 900,
        trimStartMs: 20,
        trimDurationMs: 800
      },
      newTiming: {
        startMs: 200,
        durationMs: 650,
        trimStartMs: 80,
        trimDurationMs: 500
      }
    });
  });

  it("rejects invalid layer timing trims", () => {
    const layer: MotionLayer = {
      id: "clip",
      type: "video",
      source: "assets/clip.mp4",
      startMs: 0,
      durationMs: 1000
    };

    expect(() => trimLayerTiming(layer, {})).toThrow("Layer trim requires at least one timing field.");
    expect(() => trimLayerTiming(layer, { startMs: -1 })).toThrow("startMs must be a non-negative finite number.");
    expect(() => trimLayerTiming(layer, { durationMs: 0 })).toThrow("durationMs must be a positive finite number.");
    expect(() => trimLayerTiming(layer, { trimStartMs: -1 })).toThrow("trimStartMs must be a non-negative finite number.");
    expect(() => trimLayerTiming(layer, { trimDurationMs: 0 })).toThrow("trimDurationMs must be a positive finite number.");
  });

  it("splits media layers at the playhead and preserves source trim, keyframes, transitions, and track order", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 2000,
      fps: 30,
      width: 1280,
      height: 720,
      tracks: [{ id: "video", type: "video", layerIds: ["clip"] }],
      layers: [
        {
          id: "clip",
          type: "video",
          trackId: "video",
          source: "assets/clip.mp4",
          startMs: 100,
          durationMs: 1000,
          trimStartMs: 40,
          trimDurationMs: 1000,
          playbackRate: 1.5,
          transitions: {
            in: { type: "fade", durationMs: 80 },
            out: { type: "slide", durationMs: 120, direction: "left", distance: 32 }
          },
          keyframes: {
            opacity: [
              { atMs: 100, value: 0, easing: "linear" },
              { atMs: 1100, value: 1 }
            ],
            "transform.x": [
              { atMs: 100, value: 10, easing: "linear" },
              { atMs: 1100, value: 210 }
            ],
            "style.shadow.color": [
              { atMs: 100, value: "#00000000", easing: "linear" },
              { atMs: 1100, value: "#000000" }
            ]
          }
        }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    const split = splitLayerAtMs(motion, { layerId: "clip", atMs: 500, newLayerId: "clip_tail" });

    expect(motion.layers).toHaveLength(1);
    expect(split).toMatchObject({
      action: "split",
      layerId: "clip",
      newLayerId: "clip_tail",
      atMs: 500,
      splitOffsetMs: 400,
      sourceOffsetMs: 600,
      changedPaths: ["/layers/clip/durationMs", "/layers/clip/trimDurationMs", "/layers/clip_tail", "/tracks/0/layerIds"]
    });
    expect(split.motion.layers).toEqual([
      expect.objectContaining({
        id: "clip",
        startMs: 100,
        durationMs: 400,
        trimStartMs: 40,
        trimDurationMs: 600,
        transitions: { in: { type: "fade", durationMs: 80 } },
        keyframes: {
          opacity: [
            { atMs: 100, value: 0, easing: "linear" },
            { atMs: 500, value: 0.4, easing: "linear" }
          ],
          "transform.x": [
            { atMs: 100, value: 10, easing: "linear" },
            { atMs: 500, value: 90, easing: "linear" }
          ],
          "style.shadow.color": [
            { atMs: 100, value: "#00000000", easing: "linear" },
            { atMs: 500, value: "rgba(0, 0, 0, 0.4)", easing: "linear" }
          ]
        }
      }),
      expect.objectContaining({
        id: "clip_tail",
        startMs: 500,
        durationMs: 600,
        trimStartMs: 640,
        trimDurationMs: 400,
        transitions: { out: { type: "slide", durationMs: 120, direction: "left", distance: 32 } },
        keyframes: {
          opacity: [
            { atMs: 500, value: 0.4, easing: "linear" },
            { atMs: 1100, value: 1 }
          ],
          "transform.x": [
            { atMs: 500, value: 90, easing: "linear" },
            { atMs: 1100, value: 210 }
          ],
          "style.shadow.color": [
            { atMs: 500, value: "rgba(0, 0, 0, 0.4)", easing: "linear" },
            { atMs: 1100, value: "#000000" }
          ]
        }
      })
    ]);
    expect(split.motion.tracks?.[0].layerIds).toEqual(["clip", "clip_tail"]);
  });

  it("rejects invalid layer split targets and locked tracks", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      tracks: [{ id: "video", type: "video", locked: true, layerIds: ["clip"] }],
      layers: [
        { id: "clip", type: "video", trackId: "video", source: "assets/clip.mp4", startMs: 100, durationMs: 400 },
        { id: "clip_tail", type: "video", startMs: 600, durationMs: 100 }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    expect(() => splitLayerAtMs(motion, { layerId: "", atMs: 200 })).toThrow("Layer id is required.");
    expect(() => splitLayerAtMs(motion, { layerId: "missing", atMs: 200 })).toThrow("Motion layer not found: missing.");
    expect(() => splitLayerAtMs(motion, { layerId: "clip", atMs: 100 })).toThrow("Layer split point must be inside the layer duration.");
    expect(() => splitLayerAtMs(motion, { layerId: "clip", atMs: 500 })).toThrow("Layer split point must be inside the layer duration.");
    expect(() => splitLayerAtMs(motion, { layerId: "clip", atMs: Number.NaN })).toThrow("Layer split atMs must be a non-negative finite number.");
    expect(() => splitLayerAtMs(motion, { layerId: "clip", atMs: 200, newLayerId: "clip_tail" })).toThrow("Motion layer id already exists: clip_tail.");
    expect(() => splitLayerAtMs(motion, { layerId: "clip", atMs: 200, newLayerId: "new_tail" })).toThrow("Source track is locked: video.");
  });

  it("upserts layer transitions immutably for timeline controls", () => {
    const layer: MotionLayer = {
      id: "title",
      type: "text",
      text: "Anna",
      startMs: 0,
      durationMs: 1000,
      transitions: {
        in: { type: "fade", durationMs: 120, easing: "linear" }
      }
    };

    const inserted = upsertLayerTransition(layer, {
      edge: "out",
      type: "slide",
      durationMs: 240,
      easing: "ease-in-out",
      direction: "right",
      distance: 48
    });
    const replaced = upsertLayerTransition(inserted.layer, {
      edge: "in",
      type: "wipe",
      durationMs: 180,
      easing: "ease-out",
      direction: "up"
    });

    expect(layer.transitions).toEqual({
      in: { type: "fade", durationMs: 120, easing: "linear" }
    });
    expect(inserted).toEqual({
      layer: expect.objectContaining({
        transitions: {
          in: { type: "fade", durationMs: 120, easing: "linear" },
          out: {
            type: "slide",
            durationMs: 240,
            easing: "ease-in-out",
            direction: "right",
            distance: 48
          }
        }
      }),
      changedPath: "/layers/title/transitions/out",
      action: "inserted",
      transition: {
        type: "slide",
        durationMs: 240,
        easing: "ease-in-out",
        direction: "right",
        distance: 48
      },
      previousTransition: undefined
    });
    expect(replaced).toEqual({
      layer: expect.objectContaining({
        transitions: {
          in: {
            type: "wipe",
            durationMs: 180,
            easing: "ease-out",
            direction: "up"
          },
          out: {
            type: "slide",
            durationMs: 240,
            easing: "ease-in-out",
            direction: "right",
            distance: 48
          }
        }
      }),
      changedPath: "/layers/title/transitions/in",
      action: "replaced",
      transition: {
        type: "wipe",
        durationMs: 180,
        easing: "ease-out",
        direction: "up"
      },
      previousTransition: { type: "fade", durationMs: 120, easing: "linear" }
    });
  });

  it("rejects invalid layer transition controls", () => {
    const layer: MotionLayer = {
      id: "title",
      type: "text",
      text: "Anna",
      startMs: 0,
      durationMs: 1000
    };

    expect(() => upsertLayerTransition(layer, { edge: "middle" as "in", type: "fade", durationMs: 100 })).toThrow("Transition edge must be in or out.");
    expect(() => upsertLayerTransition(layer, { edge: "in", type: "zoom" as "fade", durationMs: 100 })).toThrow("Unsupported transition type: zoom");
    expect(() => upsertLayerTransition(layer, { edge: "in", type: "fade", durationMs: 0 })).toThrow("Transition durationMs must be a positive finite number.");
    expect(() => upsertLayerTransition(layer, { edge: "in", type: "fade", durationMs: 100, easing: "bounce" as "linear" })).toThrow("Unsupported transition easing: bounce");
    expect(() => upsertLayerTransition(layer, { edge: "in", type: "slide", durationMs: 100, direction: "diagonal" })).toThrow("Unsupported slide direction: diagonal");
    expect(() => upsertLayerTransition(layer, { edge: "in", type: "slide", durationMs: 100, distance: -1 })).toThrow("Transition distance must be a non-negative finite number.");
    expect(() => upsertLayerTransition(layer, { edge: "in", type: "wipe", durationMs: 100, direction: "diagonal" })).toThrow("Unsupported wipe direction: diagonal");
  });

  it("deletes layer transitions and prunes empty transition containers", () => {
    const layer: MotionLayer = {
      id: "title",
      type: "text",
      text: "Anna",
      startMs: 0,
      durationMs: 1000,
      transitions: {
        in: { type: "fade", durationMs: 120, easing: "linear" },
        out: { type: "slide", durationMs: 240, easing: "ease-in", direction: "left", distance: 32 }
      }
    };

    const deleted = deleteLayerTransition(layer, { edge: "in" });
    const pruned = deleteLayerTransition(deleted.layer, { edge: "out" });

    expect(layer.transitions).toEqual({
      in: { type: "fade", durationMs: 120, easing: "linear" },
      out: { type: "slide", durationMs: 240, easing: "ease-in", direction: "left", distance: 32 }
    });
    expect(deleted).toEqual({
      layer: expect.objectContaining({
        transitions: {
          out: { type: "slide", durationMs: 240, easing: "ease-in", direction: "left", distance: 32 }
        }
      }),
      changedPath: "/layers/title/transitions/in",
      action: "deleted",
      removed: { type: "fade", durationMs: 120, easing: "linear" },
      remainingEdges: ["out"]
    });
    expect(pruned).toMatchObject({
      changedPath: "/layers/title/transitions/out",
      action: "deleted",
      removed: { type: "slide", durationMs: 240, easing: "ease-in", direction: "left", distance: 32 },
      remainingEdges: []
    });
    expect(pruned.layer.transitions).toBeUndefined();
    expect("transitions" in pruned.layer).toBe(false);
  });

  it("rejects invalid or missing transition deletion targets", () => {
    const layer: MotionLayer = {
      id: "title",
      type: "text",
      text: "Anna",
      startMs: 0,
      durationMs: 1000,
      transitions: {
        in: { type: "fade", durationMs: 120 }
      }
    };

    expect(() => deleteLayerTransition(layer, { edge: "middle" as "in" })).toThrow("Transition edge must be in or out.");
    expect(() => deleteLayerTransition(layer, { edge: "out" })).toThrow("No transition found for out edge.");
  });

  it("interpolates numeric keyframes with linear easing", () => {
    expect(interpolateNumber([
      { atMs: 0, value: 0, easing: "linear" },
      { atMs: 1000, value: 100 }
    ], 500)).toBe(50);
  });

  it("holds before the first and after the last keyframe", () => {
    const keyframes: MotionKeyframe[] = [
      { atMs: 250, value: 10, easing: "linear" },
      { atMs: 750, value: 30 }
    ];

    expect(interpolateNumber(keyframes, 0)).toBe(10);
    expect(interpolateNumber(keyframes, 1000)).toBe(30);
  });

  it("interpolates deterministically regardless of keyframe input order (P6 pre-sort)", () => {
    // Deliberately out-of-order keyframes must interpolate identically to the sorted equivalent, and
    // repeated calls (cache hits, since the track is sorted once and memoised) must stay correct.
    const unsorted: MotionKeyframe[] = [
      { atMs: 1000, value: 100 },
      { atMs: 0, value: 0, easing: "linear" },
      { atMs: 500, value: 50, easing: "linear" }
    ];
    const sorted: MotionKeyframe[] = [
      { atMs: 0, value: 0, easing: "linear" },
      { atMs: 500, value: 50, easing: "linear" },
      { atMs: 1000, value: 100 }
    ];

    for (const atMs of [-100, 0, 250, 500, 750, 1000, 2000]) {
      expect(interpolateNumber(unsorted, atMs)).toBe(interpolateNumber(sorted, atMs));
    }
    // Absolute values so the test fails if sorting were dropped entirely (would read the wrong segment).
    expect(interpolateNumber(unsorted, 0)).toBe(0);
    expect(interpolateNumber(unsorted, 250)).toBe(25);
    expect(interpolateNumber(unsorted, 750)).toBe(75);
    expect(interpolateNumber(unsorted, 1000)).toBe(100);
    // Second call on the same array reference exercises the memoised sorted result.
    expect(interpolateNumber(unsorted, 250)).toBe(25);
  });

  it("supports named easing functions", () => {
    expect(resolveEasing("linear")(0.5)).toBe(0.5);
    expect(resolveEasing("hold")(0.5)).toBe(0);
    expect(resolveEasing("ease-in")(0.5)).toBeGreaterThan(0);
    expect(resolveEasing("ease-out")(0.5)).toBeGreaterThan(0.5);
    expect(resolveEasing("ease-in-out")(0.5)).toBeCloseTo(0.5, 5);
    expect(resolveEasing("back-out")(0.5)).toBeGreaterThan(1);
    expect(resolveEasing("bounce-out")(0.5)).toBeGreaterThan(0.7);
    expect(resolveEasing("bounce-out")(0.5)).toBeLessThan(0.9);
  });

  it("supports CSS cubic-bezier easing functions", () => {
    expect(resolveEasing("cubic-bezier(0, 0, 1, 1)")(0.5)).toBeCloseTo(0.5, 5);
    expect(resolveEasing("cubic-bezier(0.42, 0, 1, 1)")(0.5)).toBeLessThan(0.4);
    expect(resolveEasing("cubic-bezier(0, 0, 0.58, 1)")(0.5)).toBeGreaterThan(0.6);
  });

  it("supports CSS stepped easing functions", () => {
    expect(timeline.isSupportedEasing("steps(4, end)")).toBe(true);
    expect(timeline.isSupportedEasing("steps(4, start)")).toBe(true);
    expect(timeline.isSupportedEasing("steps(4, jump-start)")).toBe(true);
    expect(timeline.isSupportedEasing("steps(4, jump-end)")).toBe(true);
    expect(timeline.isSupportedEasing("steps(0, end)")).toBe(false);
    expect(timeline.isSupportedEasing("steps(4, middle)")).toBe(false);
    expect(resolveEasing("step-start")(0)).toBe(1);
    expect(resolveEasing("step-end")(0)).toBe(0);
    expect(resolveEasing("steps(4, start)")(0.01)).toBe(0.25);
    expect(resolveEasing("steps(4, end)")(0.24)).toBe(0);
    expect(resolveEasing("steps(4, end)")(0.25)).toBe(0.25);
    expect(resolveEasing("steps(4, jump-start)")(0.5)).toBe(0.75);
    expect(resolveEasing("steps(4, jump-end)")(0.5)).toBe(0.5);
  });

  it("bounds complete functional easing grammar without narrowing valid controls", () => {
    // The X controls stay on the monotonic time axis, while Y deliberately
    // retains CSS-compatible overshoot. `steps(count)` keeps its legacy end
    // default and all accepted spellings remain case-insensitive.
    expect(timeline.isSupportedEasing("CUBIC-BEZIER(0, -2.5, 1, 3.5)")).toBe(true);
    expect(timeline.isSupportedEasing("steps(4)")).toBe(true);
    expect(timeline.isSupportedEasing("STEPS(4, JUMP-START)")).toBe(true);
    expect(resolveEasing("steps(4)")(0.24)).toBe(0);

    // A functional form can use all 256 code units in whitespace, but it may
    // never make the parser inspect a 257th code unit or an unbounded token.
    const exactLimit = `steps(${" ".repeat(248)}1)`;
    const overLimit = `steps(${" ".repeat(249)}1)`;
    expect(exactLimit).toHaveLength(256);
    expect(timeline.isSupportedEasing(exactLimit)).toBe(true);
    expect(timeline.isSupportedEasing(overLimit)).toBe(false);
    expect(timeline.isSupportedEasing("cubic-bezier(0.12345678, 0, 1, 1)")).toBe(false);
    expect(timeline.isSupportedEasing("steps(1000000000, end)")).toBe(false);
    expect(timeline.readEasingValidationError(overLimit)).toBe("unsupported easing");
    const grammar = new RegExp(timeline.MOTION_FUNCTIONAL_EASING_PATTERN);
    for (const terminator of ["\n", "\r", "\u2028", "\u2029"]) {
      const trailing = `steps(4, end)${terminator}`;
      expect(grammar.test(trailing)).toBe(false);
      expect(timeline.isSupportedEasing(trailing)).toBe(false);
    }
  });

  it("interpolates numeric keyframes with cubic-bezier easing", () => {
    expect(interpolateNumber([
      { atMs: 0, value: 0, easing: "cubic-bezier(0.42, 0, 1, 1)" },
      { atMs: 1000, value: 100 }
    ], 500)).toBeLessThan(40);
  });

  it("supports spring easing objects and preset aliases", () => {
    const bouncy = resolveEasing({ type: "spring", stiffness: 180, damping: 12, mass: 1 });
    expect(bouncy(0)).toBe(0);
    expect(bouncy(1)).toBeCloseTo(1, 10);
    // Under-damped spring overshoots the target inside the segment.
    let maxValue = -Infinity;
    for (let i = 0; i <= 1000; i += 1) maxValue = Math.max(maxValue, bouncy(i / 1000));
    expect(maxValue).toBeGreaterThan(1.05);

    // The "spring-*" string aliases resolve to the same closed-form spring.
    const alias = resolveEasing("spring-bouncy");
    const object = resolveEasing({ type: "spring", stiffness: 180, damping: 12, mass: 1 });
    for (let i = 0; i <= 20; i += 1) expect(alias(i / 20)).toBeCloseTo(object(i / 20), 12);

    // Unknown aliases fall through to identity, not to a spring.
    expect(resolveEasing("spring-unknown")(0.5)).toBe(0.5);
  });

  it("validates spring easing objects and aliases through isSupportedEasing", () => {
    expect(timeline.isSupportedEasing({ type: "spring", stiffness: 170, damping: 26, mass: 1 })).toBe(true);
    expect(timeline.isSupportedEasing({ type: "spring", stiffness: 170, damping: 26 })).toBe(true);
    expect(timeline.isSupportedEasing("spring-gentle")).toBe(true);
    expect(timeline.isSupportedEasing("spring-snappy")).toBe(true);
    expect(timeline.isSupportedEasing("spring-bouncy")).toBe(true);
    expect(timeline.isSupportedEasing({ type: "spring", stiffness: 0, damping: 26 })).toBe(false);
    expect(timeline.isSupportedEasing({ type: "spring", damping: 26 } as never)).toBe(false);
    // Honest per-reason validation messages.
    expect(timeline.readEasingValidationError({ type: "spring", stiffness: -1, damping: 26 })).toBe("spring stiffness must be a positive finite number");
    expect(timeline.readEasingValidationError("nope")).toBe("unsupported easing");
  });

  it("lists spring presets alongside named, cubic-bezier, and steps presets", () => {
    const presets = timeline.listMotionEasingPresets();
    const springs = presets.filter((preset) => preset.kind === "spring");
    expect(springs.map((preset) => preset.id)).toEqual(["spring-gentle", "spring-snappy", "spring-bouncy"]);
    expect(springs.every((preset) => preset.easing === preset.id)).toBe(true);
  });

  it("samples an animated property through effectiveLayerAtMs with a spring easing", () => {
    const spring = { type: "spring", stiffness: 180, damping: 12, mass: 1 } as const;
    const layer: MotionLayer = {
      id: "spring-layer",
      type: "shape",
      shape: "rect",
      startMs: 0,
      durationMs: 1000,
      keyframes: {
        opacity: [
          { atMs: 0, value: 0, easing: spring },
          { atMs: 1000, value: 100 }
        ]
      } as MotionLayer["keyframes"]
    };

    // Expected value computed from an independently re-derived closed form (NOT
    // by calling the implementation): standard damped oscillator normalized so
    // value(0)=0, value(1)=1, evaluated at tau = atMs/segmentDuration.
    const expectedSpring = (tau: number): number => {
      const mass = 1;
      const velocity = 0;
      const zeta = Math.max(spring.damping / (2 * Math.sqrt(spring.stiffness * mass)), 0.05);
      const settleLn = Math.log(1000);
      const omega = zeta < 1 ? settleLn / zeta : zeta === 1 ? settleLn : settleLn / (zeta - Math.sqrt(zeta * zeta - 1));
      const raw = (u: number): number => {
        const dampedFreq = omega * Math.sqrt(1 - zeta * zeta);
        const coefA = -1;
        const coefB = (velocity + zeta * omega * coefA) / dampedFreq;
        const displacement = Math.exp(-zeta * omega * u) * (coefA * Math.cos(dampedFreq * u) + coefB * Math.sin(dampedFreq * u));
        return 1 + displacement;
      };
      const end = raw(1);
      const normalizer = Math.abs(end) < 1e-9 ? 1 : end;
      const clamped = tau <= 0 ? 0 : tau >= 1 ? 1 : tau;
      return raw(clamped) / normalizer;
    };

    for (const atMs of [150, 300, 450, 620, 800]) {
      const sampled = effectiveLayerAtMs(layer, atMs).opacity;
      const expected = 0 + (100 - 0) * expectedSpring(atMs / 1000);
      expect(sampled).toBeCloseTo(expected, 9);
    }
    // Endpoints return the exact keyframe values.
    expect(effectiveLayerAtMs(layer, 0).opacity).toBe(0);
    expect(effectiveLayerAtMs(layer, 1000).opacity).toBe(100);
  });

  it("interpolates numeric keyframes with stepped easing", () => {
    expect(interpolateNumber([
      { atMs: 0, value: 0, easing: "steps(4, end)" },
      { atMs: 1000, value: 100 }
    ], 240)).toBe(0);
    expect(interpolateNumber([
      { atMs: 0, value: 0, easing: "steps(4, end)" },
      { atMs: 1000, value: 100 }
    ], 250)).toBe(25);
    expect(interpolateNumber([
      { atMs: 0, value: 0, easing: "step-start" },
      { atMs: 1000, value: 100 }
    ], 1)).toBe(100);
  });


  it("interpolates numeric keyframes with expressive named easings", () => {
    expect(interpolateNumber([
      { atMs: 0, value: 0, easing: "back-out" },
      { atMs: 1000, value: 100 }
    ], 500)).toBeGreaterThan(100);
    expect(interpolateNumber([
      { atMs: 0, value: 0, easing: "bounce-out" },
      { atMs: 1000, value: 100 }
    ], 500)).toBeGreaterThan(70);
  });

  it("returns exact keyframe values before interpolating adjacent segments", () => {
    expect(interpolateNumber([
      { atMs: 0, value: 0, easing: "hold" },
      { atMs: 500, value: 50, easing: "linear" },
      { atMs: 1000, value: 100 }
    ], 500)).toBe(50);
  });

  it("applies transform and opacity keyframes to an active layer", () => {
    const layer: MotionLayer = {
      id: "title",
      type: "text",
      text: "Anna",
      startMs: 0,
      durationMs: 2000,
      transform: { x: 0, y: 100, scale: 1, rotation: 0 },
      style: { color: "#ffffff", fontSize: 64 },
      keyframes: {
        "transform.x": [
          { atMs: 0, value: 0, easing: "linear" },
          { atMs: 1000, value: 200 }
        ],
        opacity: [
          { atMs: 0, value: 0, easing: "linear" },
          { atMs: 1000, value: 1 }
        ]
      }
    };

    expect(effectiveLayerAtMs(layer, 500)).toMatchObject({
      transform: { x: 100, y: 100, scale: 1, rotation: 0 },
      opacity: 0.5
    });
  });

  it("interpolates declared shader uniforms without mutating the source layer", () => {
    const layer: MotionLayer = {
      id: "plasma",
      type: "shader",
      startMs: 0,
      durationMs: 1000,
      shader: {
        schema: "shellx-motion/shader-plugin@1",
        language: "glsl-es-100-expression",
        fragmentAssetId: "shader_plasma",
        seed: 42,
        uniforms: { u_speed: 0.25 },
        fallbackColor: "#111827"
      },
      keyframes: {
        "shader.uniforms.u_speed": [
          { atMs: 0, value: 0.25, easing: "linear" },
          { atMs: 1000, value: 1.25 }
        ]
      }
    };

    expect(effectiveLayerAtMs(layer, 500).shader?.uniforms).toEqual({ u_speed: 0.75 });
    expect(layer.shader?.uniforms).toEqual({ u_speed: 0.25 });
  });

  it("applies transform width and height keyframes to an active layer", () => {
    const layer: MotionLayer = {
      id: "panel",
      type: "shape",
      startMs: 0,
      durationMs: 1000,
      transform: { x: 0, y: 0, width: 20, height: 20 },
      keyframes: {
        "transform.width": [
          { atMs: 0, value: 20, easing: "linear" },
          { atMs: 1000, value: 120 }
        ],
        "transform.height": [
          { atMs: 0, value: 20, easing: "linear" },
          { atMs: 1000, value: 80 }
        ]
      }
    };

    expect(effectiveLayerAtMs(layer, 500).transform).toMatchObject({ width: 70, height: 50 });
  });

  it("applies transform origin keyframes to effective layers", () => {
    const layer: MotionLayer = {
      id: "anchored-box",
      type: "shape",
      startMs: 0,
      durationMs: 1000,
      transform: { x: 80, y: 40, width: 40, height: 20, scale: 2, originX: 20, originY: 10 },
      keyframes: {
        "transform.originX": [
          { atMs: 0, value: 20, easing: "linear" },
          { atMs: 1000, value: 0 }
        ],
        "transform.originY": [
          { atMs: 0, value: 10, easing: "linear" },
          { atMs: 1000, value: 0 }
        ]
      }
    };

    expect(effectiveLayerAtMs(layer, 500).transform).toMatchObject({ originX: 10, originY: 5 });
  });

  it("applies rectangular mask inset keyframes to effective layers", () => {
    const layer: MotionLayer = {
      id: "masked-box",
      type: "shape",
      shape: "rect",
      startMs: 0,
      durationMs: 1000,
      transform: { x: 0, y: 0, width: 120, height: 80 },
      mask: { type: "rect", inset: { top: 0, right: 80, bottom: 0, left: 0 } },
      keyframes: {
        "mask.inset.top": [
          { atMs: 0, value: 0, easing: "linear" },
          { atMs: 1000, value: 20 }
        ],
        "mask.inset.right": [
          { atMs: 0, value: 80, easing: "linear" },
          { atMs: 1000, value: 0 }
        ],
        "mask.inset.bottom": [
          { atMs: 0, value: 0, easing: "linear" },
          { atMs: 1000, value: 10 }
        ],
        "mask.inset.left": [
          { atMs: 0, value: 0, easing: "linear" },
          { atMs: 1000, value: 40 }
        ]
      } as MotionLayer["keyframes"]
    };

    expect(effectiveLayerAtMs(layer, 500).mask).toEqual({
      type: "rect",
      inset: { top: 10, right: 40, bottom: 5, left: 20 }
    });
  });

  it("applies image crop keyframes to effective layers", () => {
    const layer: MotionLayer = {
      id: "cropped-image",
      type: "image",
      assetRef: "assets/product.png",
      startMs: 0,
      durationMs: 1000,
      crop: { x: 0, y: 10, width: 300, height: 200 },
      keyframes: {
        "crop.x": [
          { atMs: 0, value: 0, easing: "linear" },
          { atMs: 1000, value: 80 }
        ],
        "crop.y": [
          { atMs: 0, value: 10, easing: "linear" },
          { atMs: 1000, value: 30 }
        ],
        "crop.width": [
          { atMs: 0, value: 300, easing: "linear" },
          { atMs: 1000, value: 200 }
        ],
        "crop.height": [
          { atMs: 0, value: 200, easing: "linear" },
          { atMs: 1000, value: 100 }
        ]
      } as MotionLayer["keyframes"]
    };

    expect(effectiveLayerAtMs(layer, 500).crop).toEqual({
      x: 40,
      y: 20,
      width: 250,
      height: 150
    });
  });

  it("applies video crop keyframes to effective layers", () => {
    const layer: MotionLayer = {
      id: "cropped-clip",
      type: "video",
      source: "assets/clip.mp4",
      startMs: 0,
      durationMs: 1000,
      crop: { x: 0, y: 10, width: 300, height: 200 },
      keyframes: {
        "crop.x": [
          { atMs: 0, value: 0, easing: "linear" },
          { atMs: 1000, value: 80 }
        ],
        "crop.width": [
          { atMs: 0, value: 300, easing: "linear" },
          { atMs: 1000, value: 200 }
        ]
      } as MotionLayer["keyframes"]
    };

    expect(effectiveLayerAtMs(layer, 500).crop).toEqual({
      x: 40,
      y: 10,
      width: 250,
      height: 200
    });
  });

  it("applies numeric style keyframes to effective layers", () => {
    const layer: MotionLayer = {
      id: "style-box",
      type: "text",
      text: "Scale",
      startMs: 0,
      durationMs: 1000,
      style: { fontSize: 24, fontWeight: 400, letterSpacing: 0, lineHeight: 1.1, width: 80, height: 40, radius: 0, borderRadius: 0, padding: 0, paddingX: 0, paddingY: 0, paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0 },
      keyframes: {
        "style.fontSize": [
          { atMs: 0, value: 24, easing: "linear" },
          { atMs: 1000, value: 48 }
        ],
        "style.fontWeight": [
          { atMs: 0, value: 400, easing: "linear" },
          { atMs: 1000, value: 900 }
        ],
        "style.letterSpacing": [
          { atMs: 0, value: 0, easing: "linear" },
          { atMs: 1000, value: 24 }
        ],
        "style.lineHeight": [
          { atMs: 0, value: 1.1, easing: "linear" },
          { atMs: 1000, value: 1.7 }
        ],
        "style.width": [
          { atMs: 0, value: 80, easing: "linear" },
          { atMs: 1000, value: 160 }
        ],
        "style.height": [
          { atMs: 0, value: 40, easing: "linear" },
          { atMs: 1000, value: 80 }
        ],
        "style.radius": [
          { atMs: 0, value: 0, easing: "linear" },
          { atMs: 1000, value: 24 }
        ],
        "style.borderRadius": [
          { atMs: 0, value: 0, easing: "linear" },
          { atMs: 1000, value: 32 }
        ],
        "style.padding": [
          { atMs: 0, value: 0, easing: "linear" },
          { atMs: 1000, value: 20 }
        ],
        "style.paddingX": [
          { atMs: 0, value: 0, easing: "linear" },
          { atMs: 1000, value: 22 }
        ],
        "style.paddingY": [
          { atMs: 0, value: 0, easing: "linear" },
          { atMs: 1000, value: 24 }
        ],
        "style.paddingTop": [
          { atMs: 0, value: 0, easing: "linear" },
          { atMs: 1000, value: 26 }
        ],
        "style.paddingRight": [
          { atMs: 0, value: 0, easing: "linear" },
          { atMs: 1000, value: 28 }
        ],
        "style.paddingBottom": [
          { atMs: 0, value: 0, easing: "linear" },
          { atMs: 1000, value: 30 }
        ],
        "style.paddingLeft": [
          { atMs: 0, value: 0, easing: "linear" },
          { atMs: 1000, value: 32 }
        ]
      }
    };

    expect(effectiveLayerAtMs(layer, 500).style).toMatchObject({
      fontSize: 36,
      fontWeight: 650,
      letterSpacing: 12,
      lineHeight: 1.4,
      width: 120,
      height: 60,
      radius: 12,
      borderRadius: 16,
      padding: 10,
      paddingX: 11,
      paddingY: 12,
      paddingTop: 13,
      paddingRight: 14,
      paddingBottom: 15,
      paddingLeft: 16
    });
  });

  it("applies color keyframes to effective layers", () => {
    const layer: MotionLayer = {
      id: "color-panel",
      type: "shape",
      shape: "rect",
      startMs: 0,
      durationMs: 1000,
      fill: "#000000",
      style: { fill: "#111827", color: "#ff0000", stroke: "#000000", borderColor: "#ff0000", backgroundColor: "#000000", background: "#000000", strokeWidth: 2, borderWidth: 2 },
      keyframes: {
        fill: [
          { atMs: 0, value: "#000000", easing: "linear" },
          { atMs: 1000, value: "#ffffff" }
        ],
        "style.fill": [
          { atMs: 0, value: "#000000", easing: "linear" },
          { atMs: 1000, value: "#ffffff" }
        ],
        "style.color": [
          { atMs: 0, value: "#ff0000", easing: "linear" },
          { atMs: 1000, value: "#00ff00" }
        ],
        "style.stroke": [
          { atMs: 0, value: "#000000", easing: "linear" },
          { atMs: 1000, value: "#ffffff" }
        ],
        "style.borderColor": [
          { atMs: 0, value: "#ff0000", easing: "linear" },
          { atMs: 1000, value: "#00ff00" }
        ],
        "style.backgroundColor": [
          { atMs: 0, value: "#000000", easing: "linear" },
          { atMs: 1000, value: "#ffffff" }
        ],
        "style.background": [
          { atMs: 0, value: "#000000", easing: "linear" },
          { atMs: 1000, value: "#ffffff" }
        ],
        "style.strokeWidth": [
          { atMs: 0, value: 2, easing: "linear" },
          { atMs: 1000, value: 10 }
        ],
        "style.borderWidth": [
          { atMs: 0, value: 2, easing: "linear" },
          { atMs: 1000, value: 10 }
        ]
      }
    };

    expect(effectiveLayerAtMs(layer, 500)).toMatchObject({
      fill: "#808080",
      style: {
        fill: "#808080",
        color: "#808000",
        stroke: "#808080",
        borderColor: "#808000",
        backgroundColor: "#808080",
        background: "#808080",
        strokeWidth: 6,
        borderWidth: 6
      }
    });
  });

  it("applies audio volume keyframes to an active layer", () => {
    const layer: MotionLayer = {
      id: "music",
      type: "audio",
      source: "assets/music.wav",
      startMs: 0,
      durationMs: 1000,
      volume: 1,
      keyframes: {
        volume: [
          { atMs: 0, value: 0, easing: "linear" },
          { atMs: 500, value: 0.8 },
          { atMs: 1000, value: 0.2, easing: "hold" }
        ]
      }
    };

    expect(effectiveLayerAtMs(layer, 250)).toMatchObject({ volume: 0.4 });
  });

  it("applies audio pan keyframes to an active layer", () => {
    const layer: MotionLayer = {
      id: "music",
      type: "audio",
      source: "assets/music.wav",
      startMs: 0,
      durationMs: 1000,
      pan: -1,
      keyframes: {
        pan: [
          { atMs: 0, value: -1, easing: "linear" },
          { atMs: 500, value: 1 },
          { atMs: 1000, value: 0 }
        ]
      }
    };

    expect(effectiveLayerAtMs(layer, 250)).toMatchObject({ pan: 0 });
  });

  it("applies blend mode keyframes as discrete compositor state", () => {
    const layer: MotionLayer = {
      id: "blend-panel",
      type: "shape",
      shape: "rect",
      startMs: 0,
      durationMs: 1000,
      blendMode: "normal",
      keyframes: {
        blendMode: [
          { atMs: 0, value: "normal", easing: "hold" },
          { atMs: 500, value: "multiply" }
        ]
      }
    };

    expect(effectiveLayerAtMs(layer, 250)).toMatchObject({ blendMode: "normal" });
    expect(effectiveLayerAtMs(layer, 750)).toMatchObject({ blendMode: "multiply" });
  });

  it("applies effect keyframes to an active layer", () => {
    const layer: MotionLayer = {
      id: "panel",
      type: "shape",
      startMs: 0,
      durationMs: 1000,
      effects: { brightness: 1, contrast: 1, saturate: 1 },
      keyframes: {
        "effects.blur": [
          { atMs: 0, value: 0, easing: "linear" },
          { atMs: 1000, value: 10 }
        ],
        "effects.brightness": [
          { atMs: 0, value: 1, easing: "linear" },
          { atMs: 1000, value: 0.5 }
        ],
        "effects.contrast": [
          { atMs: 0, value: 1, easing: "linear" },
          { atMs: 1000, value: 1.4 }
        ],
        "effects.saturate": [
          { atMs: 0, value: 1, easing: "linear" },
          { atMs: 1000, value: 0.6 }
        ],
        "effects.grayscale": [
          { atMs: 0, value: 0, easing: "linear" },
          { atMs: 1000, value: 1 }
        ]
      }
    };

    expect(effectiveLayerAtMs(layer, 500)).toMatchObject({
      effects: { blur: 5, brightness: 0.75, contrast: 1.2, saturate: 0.8, grayscale: 0.5 }
    });
  });

  it("applies playback-rate keyframes to media layers", () => {
    const layer: MotionLayer = {
      id: "clip",
      type: "video",
      assetId: "asset_clip",
      startMs: 0,
      durationMs: 1000,
      playbackRate: 1,
      keyframes: {
        playbackRate: [
          { atMs: 0, value: 1, easing: "linear" },
          { atMs: 1000, value: 2 }
        ]
      }
    };

    expect(effectiveLayerAtMs(layer, 500)).toMatchObject({ playbackRate: 1.5 });
  });

  it("applies fade transitions as effective opacity multipliers", () => {
    const layer: MotionLayer = {
      id: "title",
      type: "text",
      text: "Anna",
      startMs: 1000,
      durationMs: 2000,
      opacity: 0.8,
      transform: { opacity: 1 },
      transitions: {
        in: { type: "fade", durationMs: 500, easing: "linear" },
        out: { type: "fade", durationMs: 500, easing: "linear" }
      }
    };

    expect(effectiveLayerAtMs(layer, 1000)).toMatchObject({ opacity: 0 });
    expect(effectiveLayerAtMs(layer, 1000).transform).toMatchObject({ opacity: 0 });
    expect(effectiveLayerAtMs(layer, 1250)).toMatchObject({ opacity: 0.4 });
    expect(effectiveLayerAtMs(layer, 2000)).toMatchObject({ opacity: 0.8 });
    expect(effectiveLayerAtMs(layer, 2750)).toMatchObject({ opacity: 0.4 });
    expect(effectiveLayerAtMs(layer, 3000)).toMatchObject({ opacity: 0 });
    expect(effectiveLayerAtMs(layer, 3250)).toMatchObject({ opacity: 0 });
  });

  it("applies cubic-bezier easing to transitions", () => {
    const layer: MotionLayer = {
      id: "title",
      type: "text",
      text: "Anna",
      startMs: 1000,
      durationMs: 2000,
      opacity: 1,
      transitions: {
        in: { type: "fade", durationMs: 500, easing: "cubic-bezier(0.42, 0, 1, 1)" }
      }
    };

    expect(effectiveLayerAtMs(layer, 1250).opacity).toBeLessThan(0.4);
    expect(effectiveLayerAtMs(layer, 1250).opacity).toBeGreaterThan(0.2);
  });

  it("applies cubic-bezier easing to fade-out progress", () => {
    const layer: MotionLayer = {
      id: "title",
      type: "text",
      text: "Anna",
      startMs: 1000,
      durationMs: 2000,
      opacity: 1,
      transitions: {
        out: { type: "fade", durationMs: 500, easing: "cubic-bezier(0.42, 0, 1, 1)" }
      }
    };

    expect(effectiveLayerAtMs(layer, 2750).opacity).toBeGreaterThan(0.6);
    expect(effectiveLayerAtMs(layer, 2750).opacity).toBeLessThan(0.8);
  });

  it("applies slide transitions as effective transform offsets", () => {
    const layer: MotionLayer = {
      id: "title",
      type: "text",
      text: "Anna",
      startMs: 1000,
      durationMs: 2000,
      transform: { x: 300, y: 120 },
      transitions: {
        in: { type: "slide", direction: "left", distance: 200, durationMs: 500, easing: "linear" },
        out: { type: "slide", direction: "right", distance: 100, durationMs: 500, easing: "linear" }
      }
    };

    expect(effectiveLayerAtMs(layer, 1000).transform).toMatchObject({ x: 100, y: 120 });
    expect(effectiveLayerAtMs(layer, 1250).transform).toMatchObject({ x: 200, y: 120 });
    expect(effectiveLayerAtMs(layer, 2000).transform).toMatchObject({ x: 300, y: 120 });
    expect(effectiveLayerAtMs(layer, 2750).transform).toMatchObject({ x: 350, y: 120 });
  });
});
