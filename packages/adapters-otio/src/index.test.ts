import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadMotionPackage } from "@shellx-motion/core";
import { exportMotionPackageToOtio, importOtioTimelineToMotionPackage } from "./index";

const tempDirs: string[] = [];

describe("OTIO adapter", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("exports a Motion package to an OTIO timeline with track timing and receipt evidence", async () => {
    const packageRoot = await writeMotionPackage();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-otio-export-"));
    tempDirs.push(packageRoot, outDir);
    const outPath = join(outDir, "timeline.otio");

    const result = await exportMotionPackageToOtio({
      packageRoot,
      outPath,
      createdAt: "2026-07-04T09:30:00.000Z"
    });

    const timeline = JSON.parse(await readFile(result.otioPath, "utf8")) as Record<string, any>;
    const receipt = JSON.parse(await readFile(result.receiptPath, "utf8")) as Record<string, any>;
    const videoTrack = timeline.tracks.children.find((track: any) => track.kind === "Video");
    const audioTrack = timeline.tracks.children.find((track: any) => track.kind === "Audio");

    expect(result).toMatchObject({
      ok: true,
      packageId: "pkg_otio_export",
      otioPath: outPath,
      trackCount: 2,
      clipCount: 3,
      gapCount: 1,
      warningCount: 0
    });
    expect(timeline).toMatchObject({
      OTIO_SCHEMA: "Timeline.1",
      name: "OTIO Export",
      metadata: {
        shellx_motion: {
          schema: "shellx-motion/otio-export@1",
          packageId: "pkg_otio_export",
          motionId: "motion_otio_export",
          width: 1920,
          height: 1080,
          fps: 24
        }
      }
    });
    expect(videoTrack).toBeTruthy();
    expect(audioTrack).toBeTruthy();
    expect(videoTrack.children[0]).toMatchObject({
      OTIO_SCHEMA: "Gap.1",
      source_range: {
        duration: { value: 12, rate: 24 }
      }
    });
    expect(videoTrack.children[1]).toMatchObject({
      OTIO_SCHEMA: "Clip.2",
      name: "Hero",
      media_reference: {
        OTIO_SCHEMA: "ExternalReference.1",
        target_url: "assets/hero.png"
      },
      source_range: {
        start_time: { value: 0, rate: 24 },
        duration: { value: 36, rate: 24 }
      },
      metadata: {
        shellx_motion: {
          layerId: "hero",
          layerType: "image",
          startMs: 500,
          durationMs: 1500,
          transform: { x: 40, y: 60, width: 720, height: 420 }
        }
      }
    });
    expect(videoTrack.children[2]).toMatchObject({
      OTIO_SCHEMA: "Clip.2",
      name: "Title",
      media_reference: {
        OTIO_SCHEMA: "GeneratorReference.1",
        generator_kind: "shellx-motion-text"
      },
      metadata: {
        shellx_motion: {
          layerId: "title",
          layerType: "text",
          text: "Launch window"
        }
      }
    });
    expect(audioTrack.children[0]).toMatchObject({
      OTIO_SCHEMA: "Clip.2",
      name: "Music Bed",
      media_reference: {
        OTIO_SCHEMA: "ExternalReference.1",
        target_url: "assets/bed.wav"
      },
      source_range: {
        start_time: { value: 6, rate: 24 },
        duration: { value: 48, rate: 24 }
      },
      metadata: {
        shellx_motion: {
          layerId: "music",
          layerType: "audio",
          volume: 0.7
        }
      }
    });
    expect(receipt).toMatchObject({
      schema: "shellx-motion/receipt@1",
      operation: "otio.export",
      status: "passed",
      packageId: "pkg_otio_export",
      createdAt: "2026-07-04T09:30:00.000Z",
      lane: "otio",
      output: {
        otioPath: outPath,
        trackCount: 2,
        clipCount: 3,
        gapCount: 1,
        warningCount: 0
      },
      artifacts: [
        { role: "otio_timeline", path: outPath, status: "available", mediaType: "application/vnd.opentimelineio+json", primary: true },
        { role: "otio_export_receipt", path: result.receiptPath, status: "available", mediaType: "application/json" }
      ],
      warnings: []
    });
  });

  it("imports an OTIO timeline into a Motion package with lossiness warnings for unsupported items", async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), "shellx-motion-otio-import-source-"));
    const packageDir = await mkdtemp(join(tmpdir(), "shellx-motion-otio-import-package-"));
    tempDirs.push(sourceDir, packageDir);
    const otioPath = join(sourceDir, "incoming.otio");
    await writeFile(otioPath, `${JSON.stringify(otioFixture(), null, 2)}\n`, "utf8");

    const result = await importOtioTimelineToMotionPackage({
      otioPath,
      packageDir,
      createdAt: "2026-07-04T09:40:00.000Z"
    });

    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8")) as Record<string, any>;
    const motion = JSON.parse(await readFile(result.motionPath, "utf8")) as Record<string, any>;
    const receipt = JSON.parse(await readFile(result.receiptPath, "utf8")) as Record<string, any>;
    await loadMotionPackage(packageDir);

    expect(result).toMatchObject({
      ok: true,
      packageDir,
      packageId: "pkg_otio_incoming_timeline",
      layerCount: 2,
      warningCount: 1
    });
    expect(manifest).toMatchObject({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_otio_incoming_timeline",
      name: "Incoming Timeline",
      motion: "motion.json",
      assets: ["media/shot01.mp4", "audio/dialog.wav"],
      sourceApp: "opentimelineio",
      compatibility: {
        lanes: ["otio", "browser", "ffmpeg"],
        hosts: ["shellx-motion", "shellx-cut"]
      },
      workflow: "otio-import"
    });
    expect(motion).toMatchObject({
      schema: "shellx-motion/motion@1",
      id: "motion_otio_incoming_timeline",
      name: "Incoming Timeline",
      durationMs: 3000,
      fps: 24,
      width: 1280,
      height: 720,
      provenance: {
        sourceApp: "opentimelineio",
        createdBy: "otio-adapter",
        workflow: "otio-import",
        sourceSchema: "Timeline.1"
      },
      tracks: [
        { id: "track_video_1", type: "video", name: "Video 1", order: 0, layerIds: ["clip_01"] },
        { id: "track_audio_1", type: "audio", name: "Audio 1", order: 1, layerIds: ["dialog"] }
      ],
      layers: [
        {
          id: "clip_01",
          name: "Clip 01",
          type: "video",
          trackId: "track_video_1",
          startMs: 500,
          durationMs: 2000,
          source: "media/shot01.mp4",
          trimStartMs: 250,
          transform: { x: 32, y: 40, width: 640, height: 360 }
        },
        {
          id: "dialog",
          name: "Dialog",
          type: "audio",
          trackId: "track_audio_1",
          startMs: 0,
          durationMs: 3000,
          source: "audio/dialog.wav",
          volume: 0.8
        }
      ]
    });
    expect(receipt).toMatchObject({
      schema: "shellx-motion/receipt@1",
      operation: "otio.import",
      status: "warning",
      packageId: "pkg_otio_incoming_timeline",
      lane: "otio",
      output: {
        otioPath,
        motionPath: result.motionPath,
        trackCount: 2,
        layerCount: 2,
        warningCount: 1,
        lossiness: {
          unsupported: [
            {
              path: "tracks.children[0].children[2]",
              feature: "Transition.1",
              reason: "OTIO item type is not mapped to MotionIR yet."
            }
          ]
        }
      },
      artifacts: [
        { role: "motion_package", path: packageDir, status: "available", mediaType: "application/vnd.shellx.motion.package", primary: true },
        { role: "otio_import_receipt", path: result.receiptPath, status: "available", mediaType: "application/json" }
      ]
    });
  });
  it("exports byte-identical OTIO regardless of the host locale", async () => {
    // Regression for a reproduced defect: track order and the intra-track clip tie-break sorted
    // with `String.prototype.localeCompare`, and both are written into the OTIO JSON that
    // `otioSha256` hashes and the receipt id embeds. Live probe on one machine, same package:
    // 155cf43c… under en_US.UTF-8, ca39d05f… under sv_SE.UTF-8, 2fa3a9e1… under tr_TR.UTF-8.
    // Track ids are unconstrained (non-ASCII reaches sv-SE's disagreement) and layer ids are ASCII
    // by schema (tr-TR collates "I" against "i" differently from every other locale), so the
    // fixture below carries one of each.
    const packageRoot = await writeLocaleProbePackage();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-otio-locale-"));
    tempDirs.push(packageRoot, outDir);
    const run = () => exportMotionPackageToOtio({
      packageRoot,
      outPath: join(outDir, `timeline-${Math.random().toString(36).slice(2)}.otio`),
      createdAt: "2026-08-02T00:00:00.000Z"
    });

    const baseline = await run();
    const globals = globalThis as Record<string, unknown>;
    const savedIntl = globals.Intl;
    const savedCompare = String.prototype.localeCompare;
    const boom = () => { throw new Error("locale-sensitive path reached from the OTIO export"); };
    let trapped: Awaited<ReturnType<typeof run>>;
    try {
      globals.Intl = new Proxy({}, { get: boom, has: boom, apply: boom });
      String.prototype.localeCompare = boom as typeof String.prototype.localeCompare;
      trapped = await run();
    } finally {
      globals.Intl = savedIntl;
      String.prototype.localeCompare = savedCompare;
    }
    expect(trapped.otioSha256).toBe(baseline.otioSha256);
    expect(trapped.receipt.id).toBe(baseline.receipt.id);
    expect(trapped.trackCount).toBe(2);
  });

  it("orders tracks and clips by code unit, not by collation", async () => {
    // The observable half of the same fix. Under en-US collation "\u00e4-track" sorts before
    // "z-track" and "i1" before "I2"; code-unit order is the opposite in both cases, and it is the
    // order the exported bytes must always have.
    const packageRoot = await writeLocaleProbePackage();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-otio-order-"));
    tempDirs.push(packageRoot, outDir);
    const outPath = join(outDir, "timeline.otio");
    await exportMotionPackageToOtio({ packageRoot, outPath, createdAt: "2026-08-02T00:00:00.000Z" });
    const timeline = JSON.parse(await readFile(outPath, "utf8"));
    expect(timeline.tracks.children.map((track: { metadata: { shellx_motion: { trackId: string } } }) =>
      track.metadata.shellx_motion.trackId)).toEqual(["z-track", "\u00e4-track"]);
    expect(timeline.tracks.children[0].children.map((clip: { metadata: { shellx_motion: { layerId: string } } }) =>
      clip.metadata.shellx_motion.layerId)).toEqual(["I2", "i1"]);
  });

});

async function writeMotionPackage(): Promise<string> {
  const packageRoot = await mkdtemp(join(tmpdir(), "shellx-motion-otio-package-"));
  await mkdir(join(packageRoot, "assets"), { recursive: true });
  await writeFile(join(packageRoot, "assets", "hero.png"), "fake-image", "utf8");
  await writeFile(join(packageRoot, "assets", "bed.wav"), "fake-audio", "utf8");
  await writeFile(join(packageRoot, "manifest.json"), `${JSON.stringify({
    schema: "shellx-motion/package-manifest@1",
    id: "pkg_otio_export",
    name: "OTIO Export",
    motion: "motion.json",
    assets: ["assets/hero.png", "assets/bed.wav"],
    sourceApp: "shellx-motion",
    compatibility: {
      lanes: ["browser", "ffmpeg"],
      hosts: ["shellx-motion", "shellx-cut"]
    }
  }, null, 2)}\n`, "utf8");
  await writeFile(join(packageRoot, "motion.json"), `${JSON.stringify({
    schema: "shellx-motion/motion@1",
    id: "motion_otio_export",
    name: "OTIO Export",
    durationMs: 2500,
    fps: 24,
    width: 1920,
    height: 1080,
    background: "#111827",
    tracks: [
      { id: "video_main", type: "video", name: "Video Main", order: 0, layerIds: ["hero", "title"] },
      { id: "audio_main", type: "audio", name: "Audio Main", order: 1, layerIds: ["music"] }
    ],
    layers: [
      {
        id: "hero",
        name: "Hero",
        type: "image",
        trackId: "video_main",
        source: "assets/hero.png",
        startMs: 500,
        durationMs: 1500,
        transform: { x: 40, y: 60, width: 720, height: 420 }
      },
      {
        id: "title",
        name: "Title",
        type: "text",
        trackId: "video_main",
        text: "Launch window",
        startMs: 2000,
        durationMs: 500,
        transform: { x: 96, y: 84 },
        style: { color: "#ffffff", fontSize: 72 }
      },
      {
        id: "music",
        name: "Music Bed",
        type: "audio",
        trackId: "audio_main",
        source: "assets/bed.wav",
        startMs: 0,
        durationMs: 2000,
        trimStartMs: 250,
        volume: 0.7
      }
    ],
    assets: [],
    provenance: {
      sourceApp: "shellx-motion",
      createdBy: "adapter-test"
    }
  }, null, 2)}\n`, "utf8");
  await loadMotionPackage(packageRoot);
  return packageRoot;
}

function otioFixture(): Record<string, unknown> {
  return {
    OTIO_SCHEMA: "Timeline.1",
    name: "Incoming Timeline",
    metadata: {
      shellx_motion: {
        width: 1280,
        height: 720,
        fps: 24
      }
    },
    tracks: {
      OTIO_SCHEMA: "Stack.1",
      children: [
        {
          OTIO_SCHEMA: "Track.1",
          name: "Video 1",
          kind: "Video",
          children: [
            {
              OTIO_SCHEMA: "Gap.1",
              source_range: {
                OTIO_SCHEMA: "TimeRange.1",
                start_time: { OTIO_SCHEMA: "RationalTime.1", value: 0, rate: 24 },
                duration: { OTIO_SCHEMA: "RationalTime.1", value: 12, rate: 24 }
              }
            },
            {
              OTIO_SCHEMA: "Clip.2",
              name: "Clip 01",
              media_reference: {
                OTIO_SCHEMA: "ExternalReference.1",
                target_url: "media/shot01.mp4"
              },
              source_range: {
                OTIO_SCHEMA: "TimeRange.1",
                start_time: { OTIO_SCHEMA: "RationalTime.1", value: 6, rate: 24 },
                duration: { OTIO_SCHEMA: "RationalTime.1", value: 48, rate: 24 }
              },
              metadata: {
                shellx_motion: {
                  layerId: "clip_01",
                  layerType: "video",
                  transform: { x: 32, y: 40, width: 640, height: 360 }
                }
              }
            },
            {
              OTIO_SCHEMA: "Transition.1",
              name: "Cross Dissolve"
            }
          ]
        },
        {
          OTIO_SCHEMA: "Track.1",
          name: "Audio 1",
          kind: "Audio",
          children: [
            {
              OTIO_SCHEMA: "Clip.2",
              name: "Dialog",
              media_reference: {
                OTIO_SCHEMA: "ExternalReference.1",
                target_url: "audio/dialog.wav"
              },
              source_range: {
                OTIO_SCHEMA: "TimeRange.1",
                start_time: { OTIO_SCHEMA: "RationalTime.1", value: 0, rate: 24 },
                duration: { OTIO_SCHEMA: "RationalTime.1", value: 72, rate: 24 }
              },
              metadata: {
                shellx_motion: {
                  layerId: "dialog",
                  layerType: "audio",
                  volume: 0.8
                }
              }
            }
          ]
        }
      ]
    }
  };
}

/**
 * Package whose track and layer ids are exactly the strings locales disagree about: "\u00e4-track"
 * versus "z-track" (en-US and sv-SE order these differently) and "I2" versus "i1" (tr-TR orders
 * these differently from every other locale). Both pairs tie on their numeric sort key, so the
 * string tie-break decides the exported byte order.
 */
async function writeLocaleProbePackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-otio-locale-pkg-"));
  await writeFile(join(root, "manifest.json"), `${JSON.stringify({
    schema: "shellx-motion/package-manifest@1",
    id: "pkg_locale_probe",
    name: "Locale Probe",
    motion: "motion.json",
    assets: [],
    sourceApp: "shellx-motion",
    compatibility: { lanes: ["native"], hosts: ["motion"] }
  }, null, 2)}\n`, "utf8");
  const layer = (id: string, trackId: string, x: number) => ({
    id, type: "text", text: id, startMs: 0, durationMs: 2_000, trackId,
    transform: { x, y: x, scale: 1, rotation: 0 },
    style: { fontFamily: "Inter", fontSize: 40, color: "#ffffff" }
  });
  await writeFile(join(root, "motion.json"), `${JSON.stringify({
    schema: "shellx-motion/motion@1",
    id: "motion_locale_probe",
    name: "Locale Probe",
    durationMs: 4_000,
    fps: 30,
    width: 1920,
    height: 1080,
    background: "#101820",
    tracks: [
      { id: "z-track", type: "video", name: "Z", order: 0 },
      { id: "\u00e4-track", type: "video", name: "A umlaut", order: 0 }
    ],
    layers: [layer("I2", "z-track", 10), layer("i1", "z-track", 20), layer("u3", "\u00e4-track", 30)],
    assets: [],
    provenance: { sourceApp: "shellx-motion", createdBy: "locale-probe" }
  }, null, 2)}\n`, "utf8");
  return root;
}
