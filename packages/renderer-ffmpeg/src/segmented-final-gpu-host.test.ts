import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OutputDirectoryReservation, type MotionPackage } from "@shellx-motion/core";
import { prepareAdmittedSegmentedGpuHost } from "./segmented-final-gpu-host.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.allSettled(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe("strict GPU segmented host refusal", () => {
  it("stages an explicit hidden-group includeAudio source for the segmented GPU host without a visual video schedule", async () => {
    const root = await mkdtemp(join(process.cwd(), ".scratch-motion-segmented-hidden-video-audio-"));
    roots.push(root);
    const assets = join(root, "assets");
    const browser = join(root, "test-chromium");
    await mkdir(assets, { mode: 0o700 });
    await writeFile(join(assets, "clip.mp4"), "bounded-video-fixture", { mode: 0o600 });
    await writeFile(browser, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await chmod(browser, 0o700);
    const previousBrowser = process.env.SHELLX_MOTION_BROWSER;
    process.env.SHELLX_MOTION_BROWSER = browser;
    let closed = 0;
    const commands: Array<{ executable: string; args: string[] }> = [];
    try {
      vi.spyOn(OutputDirectoryReservation, "acquire").mockImplementation(async (path) => {
        await mkdir(path, { mode: 0o700 });
        return { path, async assertCurrent() {} } as OutputDirectoryReservation;
      });
      const prepared = await prepareAdmittedSegmentedGpuHost({
        pkg: hiddenGroupAudioPackage(root),
        packageContentSha256: "a".repeat(64),
        timeline: { motionSha256: "b".repeat(64), frameCount: 1, durationMs: 1_000, fps: 1, width: 16, height: 16 },
        job: {
          jobId: "segmented-hidden-video-audio",
          scratchRoot: root,
          signal: new AbortController().signal,
          watchProcess() {},
          reportProcessContainment() {},
          reportSandbox() {}
        },
        maxProcessTreeRssBytes: 512 * 1024 * 1024,
        runner: async (command) => {
          commands.push(command);
          if (command.args.includes("-show_streams") && command.args.includes("-show_format")) {
            return {
              exitCode: 0,
              stdout: JSON.stringify({ streams: [{ codec_type: "video", width: 16, height: 16, duration: "1" }], format: { duration: "1" } }),
              stderr: ""
            };
          }
          const output = command.args.at(-1)!;
          if (!output.endsWith(".wav")) throw new Error("hidden grouped audio must not decode visual RGBA frames");
          await writeFile(output, "RIFF-hidden-group-pcm", { mode: 0o600 });
          return { exitCode: 0, stdout: "", stderr: "" };
        },
        media: { audio: { path: join(assets, "clip.mp4"), layerId: "clip", durationMs: 1_000 }, inputRoots: [root] },
        policy: {
          openRuntime: async (_images, _fonts, options) => ({
            ok: true,
            session: {
              browserProcess: {
                pid: 4_242,
                launcher: "precontained-direct-chromium",
                containment: {
                  rootPid: 4_242,
                  mode: "unix-process-group",
                  status: "enforced",
                  killTree: true,
                  memoryLimit: "rss-monitor",
                  maxProcessTreeRssBytes: options.finalBrowser.maxProcessTreeRssBytes
                }
              },
              browserVersion: "test-chromium/hidden-group-audio",
              runtimeEvidence: {
                schema: "shellx-motion/gpu-runtime-evidence@1",
                backend: "webgpu-browser",
                browserSource: "override",
                webgpuFeatureStatus: "enabled",
                adapterFingerprint: "c".repeat(64),
                adapter: { cdpVendorId: 1, cdpDeviceId: 2, cdpVendor: "test", cdpDevice: "test", vendor: "test", device: "test", architecture: null, description: null },
                limits: { maxTextureDimension2D: 4096, maxBufferSize: 1_000_000, maxStorageBufferBindingSize: 1_000_000 }
              },
              async uploadImages() { return { ok: true as const, uploaded: 0 }; },
              async render() { throw new Error("the pre-store host verdict must not render a visual frame"); },
              async close() { closed += 1; }
            }
          }),
          testVideoStaging: {
            media: [{ assetRef: "assets/clip.mp4", width: 16, height: 16 }]
          }
        }
      });

      expect(prepared.producer.identity.videoStaging).toMatchObject({ ledgerSha256: expect.stringMatching(/^[a-f0-9]{64}$/), pcmSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
      expect(prepared.audio.audio).toMatchObject({ layerId: "clip", receiptPath: join(assets, "clip.mp4"), path: expect.stringMatching(/\.wav$/) });
      expect(commands.filter((command) => command.args.at(-1)?.endsWith(".wav"))).toHaveLength(1);
      expect(commands.some((command) => command.args.at(-1)?.endsWith(".rgba"))).toBe(false);
      expect(closed).toBe(1);

      await prepared.release();
      expect((await readdir(root)).some((name) => name.startsWith("gpu-video-"))).toBe(false);
    } finally {
      if (previousBrowser === undefined) delete process.env.SHELLX_MOTION_BROWSER;
      else process.env.SHELLX_MOTION_BROWSER = previousBrowser;
    }
  });
});

function hiddenGroupAudioPackage(root: string): MotionPackage {
  return {
    root,
    manifest: {
      schema: "shellx-motion/package-manifest@1",
      id: "segmented-hidden-group-audio",
      name: "Segmented hidden group audio",
      motion: "motion.json",
      assets: ["assets/clip.mp4"],
      sourceApp: "test",
      compatibility: { lanes: ["gpu"], hosts: ["motion"] }
    },
    motion: {
      schema: "shellx-motion/motion@1",
      id: "segmented-hidden-group-audio-motion",
      name: "Segmented hidden group audio",
      durationMs: 1_000,
      fps: 1,
      width: 16,
      height: 16,
      layers: [
        { id: "hidden-scene", type: "group", visible: false, startMs: 0, durationMs: 1_000, childLayerIds: ["clip"] },
        { id: "clip", type: "video", assetId: "clip_asset", includeAudio: true, startMs: 0, durationMs: 1_000, transform: { width: 16, height: 16 } }
      ],
      assets: [{ id: "clip_asset", source: { path: "assets/clip.mp4", mimeType: "video/mp4" } }],
      provenance: { sourceApp: "test", createdBy: "test" }
    }
  };
}
