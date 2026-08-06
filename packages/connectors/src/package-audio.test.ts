import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MotionPackage } from "@shellx-motion/core";
import { resolvePackageAudioInputs } from "./package-audio";

const tempDirs: string[] = [];

describe("package audio inputs", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("resolves audio layer assetId references through the package asset table", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-package-audio-"));
    tempDirs.push(root);
    await mkdir(join(root, "assets"), { recursive: true });
    await writeFile(join(root, "assets", "tone.wav"), "fake wav bytes", "utf8");

    const pkg: MotionPackage = {
      root,
      manifest: {
        schema: "shellx-motion/package-manifest@1",
        id: "pkg_audio_asset_id",
        name: "Audio Asset Id",
        motion: "motion.json",
        assets: ["assets/tone.wav"],
        sourceApp: "shellx-motion",
        compatibility: { lanes: ["ffmpeg"], hosts: ["motion"] }
      },
      motion: {
        schema: "shellx-motion/motion@1",
        id: "motion_audio_asset_id",
        name: "Audio Asset Id",
        durationMs: 1000,
        fps: 30,
        width: 640,
        height: 360,
        layers: [
          {
            id: "music",
            type: "audio",
            assetId: "tone_asset",
            startMs: 0,
            durationMs: 1000
          }
        ],
        assets: [
          {
            id: "tone_asset",
            source: { path: "assets/tone.wav", mimeType: "audio/wav" }
          }
        ],
        provenance: { sourceApp: "shellx-motion", createdBy: "test" }
      }
    };

    expect(resolvePackageAudioInputs(pkg)).toEqual([
      {
        path: join(root, "assets", "tone.wav"),
        layerId: "music",
        durationMs: 1000
      }
    ]);
  });

  it("passes audio layer playback rates through to FFmpeg inputs", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-package-audio-rate-"));
    tempDirs.push(root);
    await mkdir(join(root, "assets"), { recursive: true });
    await writeFile(join(root, "assets", "voice.wav"), "fake voice bytes", "utf8");

    const pkg: MotionPackage = {
      root,
      manifest: {
        schema: "shellx-motion/package-manifest@1",
        id: "pkg_audio_playback_rate",
        name: "Audio Playback Rate",
        motion: "motion.json",
        assets: ["assets/voice.wav"],
        sourceApp: "shellx-motion",
        compatibility: { lanes: ["ffmpeg"], hosts: ["motion"] }
      },
      motion: {
        schema: "shellx-motion/motion@1",
        id: "motion_audio_playback_rate",
        name: "Audio Playback Rate",
        durationMs: 1400,
        fps: 30,
        width: 640,
        height: 360,
        layers: [
          {
            id: "voice",
            type: "audio",
            source: "assets/voice.wav",
            startMs: 100,
            durationMs: 1200,
            playbackRate: 1.25
          }
        ],
        assets: [],
        provenance: { sourceApp: "shellx-motion", createdBy: "test" }
      }
    };

    expect(resolvePackageAudioInputs(pkg)).toEqual([
      {
        path: join(root, "assets", "voice.wav"),
        layerId: "voice",
        startMs: 100,
        durationMs: 1200,
        playbackRate: 1.25
      }
    ]);
  });

  it("lowers audio ducking triggers into FFmpeg volume keyframes", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-package-audio-ducking-"));
    tempDirs.push(root);
    await mkdir(join(root, "assets"), { recursive: true });
    await writeFile(join(root, "assets", "music.wav"), "fake music bytes", "utf8");
    await writeFile(join(root, "assets", "voice.wav"), "fake voice bytes", "utf8");

    const pkg: MotionPackage = {
      root,
      manifest: {
        schema: "shellx-motion/package-manifest@1",
        id: "pkg_audio_ducking",
        name: "Audio Ducking",
        motion: "motion.json",
        assets: ["assets/music.wav", "assets/voice.wav"],
        sourceApp: "shellx-motion",
        compatibility: { lanes: ["ffmpeg"], hosts: ["motion"] }
      },
      motion: {
        schema: "shellx-motion/motion@1",
        id: "motion_audio_ducking",
        name: "Audio Ducking",
        durationMs: 2400,
        fps: 30,
        width: 640,
        height: 360,
        layers: [
          {
            id: "music",
            type: "audio",
            source: "assets/music.wav",
            startMs: 0,
            durationMs: 2400,
            ducking: {
              triggerLayerIds: ["voice"],
              duckToVolume: 0.25,
              attackMs: 100,
              releaseMs: 200
            }
          } as any,
          {
            id: "voice",
            type: "audio",
            source: "assets/voice.wav",
            startMs: 600,
            durationMs: 800
          }
        ],
        assets: [],
        provenance: { sourceApp: "shellx-motion", createdBy: "test" }
      }
    };

    expect(resolvePackageAudioInputs(pkg)).toEqual([
      {
        path: join(root, "assets", "music.wav"),
        layerId: "music",
        durationMs: 2400,
        ducking: {
          triggerLayerIds: ["voice"],
          duckToVolume: 0.25,
          attackMs: 100,
          releaseMs: 200
        },
        volumeKeyframes: [
          { atMs: 500, value: 1, easing: "ease-out" },
          { atMs: 600, value: 0.25 },
          { atMs: 1400, value: 0.25, easing: "ease-in" },
          { atMs: 1600, value: 1 }
        ]
      },
      {
        path: join(root, "assets", "voice.wav"),
        layerId: "voice",
        startMs: 600,
        durationMs: 800
      }
    ]);
  });

  it("keeps sidechain ducking as filter metadata without precomputing volume keyframes", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-package-audio-sidechain-"));
    tempDirs.push(root);
    await mkdir(join(root, "assets"), { recursive: true });
    await writeFile(join(root, "assets", "music.wav"), "fake music bytes", "utf8");
    await writeFile(join(root, "assets", "voice.wav"), "fake voice bytes", "utf8");

    const pkg: MotionPackage = {
      root,
      manifest: {
        schema: "shellx-motion/package-manifest@1",
        id: "pkg_audio_sidechain",
        name: "Audio Sidechain",
        motion: "motion.json",
        assets: ["assets/music.wav", "assets/voice.wav"],
        sourceApp: "shellx-motion",
        compatibility: { lanes: ["ffmpeg"], hosts: ["motion"] }
      },
      motion: {
        schema: "shellx-motion/motion@1",
        id: "motion_audio_sidechain",
        name: "Audio Sidechain",
        durationMs: 2400,
        fps: 30,
        width: 640,
        height: 360,
        layers: [
          {
            id: "music",
            type: "audio",
            source: "assets/music.wav",
            startMs: 0,
            durationMs: 2400,
            ducking: {
              mode: "sidechain",
              triggerLayerIds: ["voice"],
              threshold: 0.04,
              ratio: 10,
              attackMs: 15,
              releaseMs: 220
            }
          } as any,
          {
            id: "voice",
            type: "audio",
            source: "assets/voice.wav",
            startMs: 600,
            durationMs: 800
          }
        ],
        assets: [],
        provenance: { sourceApp: "shellx-motion", createdBy: "test" }
      }
    };

    // Sidechain mode must NOT precompute volume keyframes (no volumeKeyframes key);
    // the ducking config (incl. mode + compressor knobs) rides through to the renderer.
    expect(resolvePackageAudioInputs(pkg)).toEqual([
      {
        path: join(root, "assets", "music.wav"),
        layerId: "music",
        durationMs: 2400,
        ducking: {
          mode: "sidechain",
          triggerLayerIds: ["voice"],
          threshold: 0.04,
          ratio: 10,
          attackMs: 15,
          releaseMs: 220
        }
      },
      {
        path: join(root, "assets", "voice.wav"),
        layerId: "voice",
        startMs: 600,
        durationMs: 800
      }
    ]);
  });

  it("lowers audio pan keyframes into FFmpeg pan automation inputs", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-package-audio-pan-keyframes-"));
    tempDirs.push(root);
    await mkdir(join(root, "assets"), { recursive: true });
    await writeFile(join(root, "assets", "music.wav"), "fake music bytes", "utf8");

    const panKeyframes = [
      { atMs: 0, value: -1, easing: "linear" as const },
      { atMs: 1000, value: 1 }
    ];
    const pkg: MotionPackage = {
      root,
      manifest: {
        schema: "shellx-motion/package-manifest@1",
        id: "pkg_audio_pan_keyframes",
        name: "Audio Pan Keyframes",
        motion: "motion.json",
        assets: ["assets/music.wav"],
        sourceApp: "shellx-motion",
        compatibility: { lanes: ["ffmpeg"], hosts: ["motion"] }
      },
      motion: {
        schema: "shellx-motion/motion@1",
        id: "motion_audio_pan_keyframes",
        name: "Audio Pan Keyframes",
        durationMs: 1200,
        fps: 30,
        width: 640,
        height: 360,
        layers: [
          {
            id: "music",
            type: "audio",
            source: "assets/music.wav",
            startMs: 0,
            durationMs: 1200,
            pan: -0.25,
            keyframes: {
              pan: panKeyframes
            }
          }
        ],
        assets: [],
        provenance: { sourceApp: "shellx-motion", createdBy: "test" }
      }
    };

    expect(resolvePackageAudioInputs(pkg)).toEqual([
      {
        path: join(root, "assets", "music.wav"),
        layerId: "music",
        durationMs: 1200,
        panKeyframes
      }
    ]);
  });
});
