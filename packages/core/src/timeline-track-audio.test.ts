/**
 * Timeline track audio-control tests for ShellX Motion core.
 *
 * Role: the audio-editor slice of the timeline test suite — mute, solo, volume, fade, and pan track
 * controls. Split verbatim out of `timeline.test.ts` so the timeline test file stays under the module-size
 * gate. Each test is self-contained (builds its own inline MotionDocument); no shared fixtures moved.
 *
 * Dependencies: the track audio setters from `./timeline` and the `MotionDocument` type from `./types`.
 *
 * Primary callers: run by vitest as part of the `@shellx-motion/core` suite.
 */
import { describe, expect, it } from "vitest";
import * as timeline from "./timeline";
import { setTimelineTrackFade, setTimelineTrackMute, setTimelineTrackSolo, setTimelineTrackVolume } from "./timeline";
import type { MotionDocument } from "./types";

describe("Motion timeline track audio controls", () => {
  it("sets timeline track mutes immutably for audio editor controls", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      tracks: [
        { id: "music", type: "audio", name: "Music", order: 1, layerIds: ["bed"] },
        { id: "voice", type: "audio", name: "Voice", order: 2, layerIds: [] }
      ],
      layers: [
        { id: "bed", type: "audio", trackId: "music", source: "assets/music.wav", startMs: 0, durationMs: 1000 }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    const muted = setTimelineTrackMute(motion, { trackId: "music", muted: true });
    const unmuted = setTimelineTrackMute(muted.motion, { trackId: "music", muted: false });

    expect(motion.tracks?.[0].muted).toBeUndefined();
    expect(muted).toEqual({
      motion: expect.objectContaining({
        tracks: [
          { id: "music", type: "audio", name: "Music", order: 1, layerIds: ["bed"], muted: true },
          { id: "voice", type: "audio", name: "Voice", order: 2, layerIds: [] }
        ]
      }),
      changedPaths: ["/tracks/music/muted"],
      action: "muted",
      trackId: "music",
      oldMuted: false,
      newMuted: true,
      track: { id: "music", type: "audio", name: "Music", order: 1, layerIds: ["bed"], muted: true }
    });
    expect(unmuted).toMatchObject({
      changedPaths: ["/tracks/music/muted"],
      action: "unmuted",
      trackId: "music",
      oldMuted: true,
      newMuted: false,
      track: { id: "music", muted: false }
    });
  });

  it("rejects invalid and no-op timeline track mute edits", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      tracks: [{ id: "music", type: "audio", muted: true, layerIds: [] }],
      layers: [],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    expect(() => setTimelineTrackMute(motion, { trackId: "", muted: false })).toThrow("Track id is required.");
    expect(() => setTimelineTrackMute(motion, { trackId: "missing", muted: false })).toThrow("Motion track not found: missing.");
    expect(() => setTimelineTrackMute(motion, { trackId: "music", muted: true })).toThrow("Track mute state did not change.");
    expect(() => setTimelineTrackMute(motion, { trackId: "music", muted: undefined as unknown as boolean })).toThrow("Track muted must be a boolean.");
  });

  it("sets timeline track solo immutably for audio editor controls", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      tracks: [
        { id: "music", type: "audio", name: "Music", order: 1, layerIds: ["bed"] },
        { id: "voice", type: "audio", name: "Voice", order: 2, layerIds: [] }
      ],
      layers: [
        { id: "bed", type: "audio", trackId: "music", source: "assets/music.wav", startMs: 0, durationMs: 1000 }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    const soloed = setTimelineTrackSolo(motion, { trackId: "music", solo: true });
    const unsoloed = setTimelineTrackSolo(soloed.motion, { trackId: "music", solo: false });

    expect(motion.tracks?.[0].solo).toBeUndefined();
    expect(soloed).toEqual({
      motion: expect.objectContaining({
        tracks: [
          { id: "music", type: "audio", name: "Music", order: 1, layerIds: ["bed"], solo: true },
          { id: "voice", type: "audio", name: "Voice", order: 2, layerIds: [] }
        ]
      }),
      changedPaths: ["/tracks/music/solo"],
      action: "soloed",
      trackId: "music",
      oldSolo: false,
      newSolo: true,
      track: { id: "music", type: "audio", name: "Music", order: 1, layerIds: ["bed"], solo: true }
    });
    expect(unsoloed).toMatchObject({
      changedPaths: ["/tracks/music/solo"],
      action: "unsoloed",
      trackId: "music",
      oldSolo: true,
      newSolo: false,
      track: { id: "music", solo: false }
    });
  });

  it("rejects invalid and no-op timeline track solo edits", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      tracks: [{ id: "music", type: "audio", solo: true, layerIds: [] }],
      layers: [],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    expect(() => setTimelineTrackSolo(motion, { trackId: "", solo: false })).toThrow("Track id is required.");
    expect(() => setTimelineTrackSolo(motion, { trackId: "missing", solo: false })).toThrow("Motion track not found: missing.");
    expect(() => setTimelineTrackSolo(motion, { trackId: "music", solo: true })).toThrow("Track solo state did not change.");
    expect(() => setTimelineTrackSolo(motion, { trackId: "music", solo: undefined as unknown as boolean })).toThrow("Track solo must be a boolean.");
  });

  it("sets timeline track volume immutably for audio editor controls", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      tracks: [
        { id: "music", type: "audio", name: "Music", order: 1, layerIds: ["bed"] },
        { id: "voice", type: "audio", name: "Voice", order: 2, layerIds: [] }
      ],
      layers: [
        { id: "bed", type: "audio", trackId: "music", source: "assets/music.wav", startMs: 0, durationMs: 1000 }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    const changed = setTimelineTrackVolume(motion, { trackId: "music", volume: 0.65 });
    const changedAgain = setTimelineTrackVolume(changed.motion, { trackId: "music", volume: 1.2 });

    expect(motion.tracks?.[0].volume).toBeUndefined();
    expect(changed).toEqual({
      motion: expect.objectContaining({
        tracks: [
          { id: "music", type: "audio", name: "Music", order: 1, layerIds: ["bed"], volume: 0.65 },
          { id: "voice", type: "audio", name: "Voice", order: 2, layerIds: [] }
        ]
      }),
      changedPaths: ["/tracks/music/volume"],
      action: "updated",
      trackId: "music",
      oldVolume: 1,
      newVolume: 0.65,
      track: { id: "music", type: "audio", name: "Music", order: 1, layerIds: ["bed"], volume: 0.65 }
    });
    expect(changedAgain).toMatchObject({
      changedPaths: ["/tracks/music/volume"],
      action: "updated",
      trackId: "music",
      oldVolume: 0.65,
      newVolume: 1.2,
      track: { id: "music", volume: 1.2 }
    });
  });

  it("rejects invalid and no-op timeline track volume edits", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      tracks: [{ id: "music", type: "audio", volume: 0.5, layerIds: [] }],
      layers: [],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    expect(() => setTimelineTrackVolume(motion, { trackId: "", volume: 0.7 })).toThrow("Track id is required.");
    expect(() => setTimelineTrackVolume(motion, { trackId: "missing", volume: 0.7 })).toThrow("Motion track not found: missing.");
    expect(() => setTimelineTrackVolume(motion, { trackId: "music", volume: 0.5 })).toThrow("Track volume did not change.");
    expect(() => setTimelineTrackVolume(motion, { trackId: "music", volume: -0.1 })).toThrow("Track volume must be a non-negative finite number.");
    expect(() => setTimelineTrackVolume(motion, { trackId: "music", volume: Number.NaN })).toThrow("Track volume must be a non-negative finite number.");
  });

  it("sets timeline track fades immutably for audio editor controls", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      tracks: [
        { id: "music", type: "audio", name: "Music", order: 1, layerIds: ["bed"] },
        { id: "voice", type: "audio", name: "Voice", order: 2, layerIds: [] }
      ],
      layers: [
        { id: "bed", type: "audio", trackId: "music", source: "assets/music.wav", startMs: 0, durationMs: 1000 }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    const changed = setTimelineTrackFade(motion, { trackId: "music", fadeInMs: 120, fadeOutMs: 240 });
    const changedAgain = setTimelineTrackFade(changed.motion, { trackId: "music", fadeOutMs: 360 });

    expect(motion.tracks?.[0].fadeInMs).toBeUndefined();
    expect(changed).toEqual({
      motion: expect.objectContaining({
        tracks: [
          { id: "music", type: "audio", name: "Music", order: 1, layerIds: ["bed"], fadeInMs: 120, fadeOutMs: 240 },
          { id: "voice", type: "audio", name: "Voice", order: 2, layerIds: [] }
        ]
      }),
      changedPaths: ["/tracks/music/fadeInMs", "/tracks/music/fadeOutMs"],
      action: "updated",
      trackId: "music",
      oldFade: { fadeInMs: 0, fadeOutMs: 0 },
      newFade: { fadeInMs: 120, fadeOutMs: 240 },
      track: { id: "music", type: "audio", name: "Music", order: 1, layerIds: ["bed"], fadeInMs: 120, fadeOutMs: 240 }
    });
    expect(changedAgain).toMatchObject({
      changedPaths: ["/tracks/music/fadeOutMs"],
      action: "updated",
      trackId: "music",
      oldFade: { fadeInMs: 120, fadeOutMs: 240 },
      newFade: { fadeInMs: 120, fadeOutMs: 360 },
      track: { id: "music", fadeInMs: 120, fadeOutMs: 360 }
    });
  });

  it("rejects invalid and no-op timeline track fade edits", () => {
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      tracks: [{ id: "music", type: "audio", fadeInMs: 100, fadeOutMs: 200, layerIds: [] }],
      layers: [],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    expect(() => setTimelineTrackFade(motion, { trackId: "", fadeInMs: 120 })).toThrow("Track id is required.");
    expect(() => setTimelineTrackFade(motion, { trackId: "missing", fadeInMs: 120 })).toThrow("Motion track not found: missing.");
    expect(() => setTimelineTrackFade(motion, { trackId: "music" })).toThrow("At least one track fade value is required.");
    expect(() => setTimelineTrackFade(motion, { trackId: "music", fadeInMs: 100 })).toThrow("Track fade did not change.");
    expect(() => setTimelineTrackFade(motion, { trackId: "music", fadeInMs: -1 })).toThrow("Track fade values must be non-negative finite numbers.");
    expect(() => setTimelineTrackFade(motion, { trackId: "music", fadeOutMs: Number.NaN })).toThrow("Track fade values must be non-negative finite numbers.");
  });

  it("sets timeline track pan immutably for audio editor controls", () => {
    const setTimelineTrackPan = (timeline as { setTimelineTrackPan?: (motion: MotionDocument, input: { trackId: string; pan: number }) => unknown }).setTimelineTrackPan;
    expect(typeof setTimelineTrackPan).toBe("function");
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      tracks: [
        { id: "music", type: "audio", name: "Music", order: 1, layerIds: ["bed"] },
        { id: "voice", type: "audio", name: "Voice", order: 2, layerIds: [] }
      ],
      layers: [
        { id: "bed", type: "audio", trackId: "music", source: "assets/music.wav", startMs: 0, durationMs: 1000 }
      ],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    const changed = setTimelineTrackPan!(motion, { trackId: "music", pan: -0.35 });
    const changedAgain = setTimelineTrackPan!((changed as { motion: MotionDocument }).motion, { trackId: "music", pan: 0.5 });

    expect(motion.tracks?.[0].pan).toBeUndefined();
    expect(changed).toEqual({
      motion: expect.objectContaining({
        tracks: [
          { id: "music", type: "audio", name: "Music", order: 1, layerIds: ["bed"], pan: -0.35 },
          { id: "voice", type: "audio", name: "Voice", order: 2, layerIds: [] }
        ]
      }),
      changedPaths: ["/tracks/music/pan"],
      action: "updated",
      trackId: "music",
      oldPan: 0,
      newPan: -0.35,
      track: { id: "music", type: "audio", name: "Music", order: 1, layerIds: ["bed"], pan: -0.35 }
    });
    expect(changedAgain).toMatchObject({
      changedPaths: ["/tracks/music/pan"],
      action: "updated",
      trackId: "music",
      oldPan: -0.35,
      newPan: 0.5,
      track: { id: "music", pan: 0.5 }
    });
  });

  it("rejects invalid and no-op timeline track pan edits", () => {
    const setTimelineTrackPan = (timeline as { setTimelineTrackPan?: (motion: MotionDocument, input: { trackId: string; pan: number }) => unknown }).setTimelineTrackPan;
    expect(typeof setTimelineTrackPan).toBe("function");
    const motion: MotionDocument = {
      schema: "shellx-motion/motion@1",
      id: "motion",
      name: "Motion",
      durationMs: 1000,
      fps: 30,
      width: 1280,
      height: 720,
      tracks: [{ id: "music", type: "audio", pan: -0.5, layerIds: [] }],
      layers: [],
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    };

    expect(() => setTimelineTrackPan!(motion, { trackId: "", pan: 0.7 })).toThrow("Track id is required.");
    expect(() => setTimelineTrackPan!(motion, { trackId: "missing", pan: 0.7 })).toThrow("Motion track not found: missing.");
    expect(() => setTimelineTrackPan!(motion, { trackId: "music", pan: -0.5 })).toThrow("Track pan did not change.");
    expect(() => setTimelineTrackPan!(motion, { trackId: "music", pan: -1.1 })).toThrow("Track pan must be a finite number between -1 and 1.");
    expect(() => setTimelineTrackPan!(motion, { trackId: "music", pan: Number.NaN })).toThrow("Track pan must be a finite number between -1 and 1.");
  });

});
