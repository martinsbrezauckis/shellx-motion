import { describe, expect, it } from "vitest";
import { bindGpuVideoAudioSnapshots, preliminaryGpuAudio } from "./streaming-final-gpu-audio.js";

describe("GPU video final audio binding", () => {
  it("substitutes one immutable full-source PCM while retaining each layer's own timing and filters", () => {
    const source = "/package/assets/clip.mp4";
    const pcm = "/admitted/gpu-video/clip.wav";
    const bound = bindGpuVideoAudioSnapshots({
      audioTracks: [
        { path: source, layerId: "clip-a", startMs: 0, durationMs: 1_000, trimStartMs: 250, trimDurationMs: 500, playbackRate: 1.5, fadeInMs: 20 },
        { path: source, layerId: "clip-b", startMs: 500, durationMs: 750, trimStartMs: 0, trimDurationMs: 600, playbackRate: 0.5, fadeOutMs: 30 }
      ]
    } as Parameters<typeof bindGpuVideoAudioSnapshots>[0], new Map([[source, { sourcePath: source, path: pcm, sha256: "a".repeat(64), root: "/admitted/gpu-video" }]]));

    expect(bound.audioTracks).toEqual([
      { path: pcm, receiptPath: source, snapshotSha256: "a".repeat(64), layerId: "clip-a", startMs: 0, durationMs: 1_000, trimStartMs: 250, trimDurationMs: 500, playbackRate: 1.5, fadeInMs: 20 },
      { path: pcm, receiptPath: source, snapshotSha256: "a".repeat(64), layerId: "clip-b", startMs: 500, durationMs: 750, trimStartMs: 0, trimDurationMs: 600, playbackRate: 0.5, fadeOutMs: 30 }
    ]);
  });

  it("refuses staged PCM that was never bound to an encoder audio input", () => {
    const source = "/package/assets/clip.mp4";
    expect(() => bindGpuVideoAudioSnapshots({} as Parameters<typeof bindGpuVideoAudioSnapshots>[0], new Map([
      [source, { sourcePath: source, path: "/admitted/gpu-video/clip.wav", sha256: "a".repeat(64), root: "/admitted/gpu-video" }]
    ]))).toThrow("did not bind every admitted includeAudio source");
  });

  it("defers package-video audio before the public command planner sees the MP4", () => {
    const source = "/package/assets/clip.mp4";
    const pkg = {
      root: "/package",
      motion: { layers: [{ id: "clip", type: "video", includeAudio: true, assetRef: "assets/clip.mp4" }] }
    } as Parameters<typeof preliminaryGpuAudio>[0]["pkg"];
    expect(preliminaryGpuAudio({ pkg, audio: { path: source, layerId: "clip", durationMs: 1_000 } })).toEqual({});
  });
});
