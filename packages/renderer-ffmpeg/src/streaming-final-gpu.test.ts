import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutputDirectoryReservation, type MotionPackage } from "@shellx-motion/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FfmpegCommand, FfmpegProcessResult, FfmpegRunner } from "./index.js";
import { prepareAdmittedGpuDelivery, preflightGpuDelivery } from "./streaming-final-gpu.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.allSettled(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe("admitted GPU video delivery", () => {
  it("creates the exact staging child below admitted scratch, stages before encoder ownership, and removes it only after release", async () => {
    const root = await fixtureRoot("child");
    const pkg = videoPackage(root);
    const staticPlan = preflightGpuDelivery({ pkg, frameLane: "gpu", outputPath: join(root, "out.mp4") });
    expect(staticPlan.ok).toBe(true); if (!staticPlan.ok) return;
    const scratchRoot = join(root, "admitted-job");
    await mkdir(scratchRoot, { mode: 0o700 });
    const acquired: string[] = [];
    vi.spyOn(OutputDirectoryReservation, "acquire").mockImplementation(async (path) => {
      acquired.push(path);
      await mkdir(path, { mode: 0o700 });
      return { path, async assertCurrent() {} } as OutputDirectoryReservation;
    });
    const commands: FfmpegCommand[] = [];
    const prepared = await prepareAdmittedGpuDelivery(
      { pkg, frameLane: "gpu", outputPath: join(root, "out.mp4"), toolPolicy: { gpu: { testVideoStaging: { runner: stagingRunner(commands) } } } },
      staticPlan.staticPlan,
      jobContext(scratchRoot)
    );

    expect(prepared.ok).toBe(true); if (!prepared.ok) return;
    expect(acquired).toHaveLength(1);
    expect(prepared.delivery.stagingRoot).toBe(acquired[0]);
    expect(prepared.delivery.stagingRoot?.startsWith(`${scratchRoot}/gpu-video-`)).toBe(true);
    expect(commands.map((command) => command.executable)).toEqual(["ffprobe", "ffmpeg"]);
    await expect(lstat(prepared.delivery.stagingRoot!)).resolves.toMatchObject({ isDirectory: expect.any(Function) });

    await prepared.delivery.release();
    await expect(lstat(acquired[0]!)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(scratchRoot)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  });

  it("refuses an aggregate video budget before decoder launch and removes its owned child", async () => {
    const root = await fixtureRoot("budget");
    const pkg = videoPackage(root);
    const staticPlan = preflightGpuDelivery({ pkg, frameLane: "gpu", outputPath: join(root, "out.mp4") });
    expect(staticPlan.ok).toBe(true); if (!staticPlan.ok) return;
    const scratchRoot = join(root, "admitted-job");
    await mkdir(scratchRoot, { mode: 0o700 });
    const acquired: string[] = [];
    vi.spyOn(OutputDirectoryReservation, "acquire").mockImplementation(async (path) => {
      acquired.push(path);
      await mkdir(path, { mode: 0o700 });
      return { path, async assertCurrent() {} } as OutputDirectoryReservation;
    });
    const commands: FfmpegCommand[] = [];
    const bytes = (await lstat(join(root, "assets", "clip.mp4"))).size;
    const prepared = await prepareAdmittedGpuDelivery(
      {
        pkg,
        frameLane: "gpu",
        outputPath: join(root, "out.mp4"),
        toolPolicy: { gpu: { testVideoStaging: { runner: stagingRunner(commands), maxBytes: bytes } } }
      },
      staticPlan.staticPlan,
      jobContext(scratchRoot)
    );

    expect(prepared).toMatchObject({ ok: false, failure: { code: "gpu_video_resource_refused", message: expect.stringContaining("aggregate operation budget") } });
    expect(commands.map((command) => command.executable)).toEqual(["ffprobe"]);
    await expect(lstat(acquired[0]!)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(scratchRoot)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  });

  it("removes the exact admitted child when staging is cancelled before decode", async () => {
    const root = await fixtureRoot("cancel");
    const pkg = videoPackage(root);
    const staticPlan = preflightGpuDelivery({ pkg, frameLane: "gpu", outputPath: join(root, "out.mp4") });
    expect(staticPlan.ok).toBe(true); if (!staticPlan.ok) return;
    const scratchRoot = join(root, "admitted-job");
    await mkdir(scratchRoot, { mode: 0o700 });
    const acquired: string[] = [];
    vi.spyOn(OutputDirectoryReservation, "acquire").mockImplementation(async (path) => {
      acquired.push(path);
      await mkdir(path, { mode: 0o700 });
      return { path, async assertCurrent() {} } as OutputDirectoryReservation;
    });
    const controller = new AbortController();
    let decodes = 0;
    const runner: FfmpegRunner = async (command) => {
      if (command.executable === "ffprobe") {
        controller.abort(new Error("cancel admitted GPU staging"));
        return probe();
      }
      decodes += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const prepared = await prepareAdmittedGpuDelivery(
      { pkg, frameLane: "gpu", outputPath: join(root, "out.mp4"), toolPolicy: { gpu: { testVideoStaging: { runner } } } },
      staticPlan.staticPlan,
      jobContext(scratchRoot, controller.signal)
    );

    expect(prepared).toMatchObject({ ok: false, failure: { code: "gpu_video_resource_refused", message: "cancel admitted GPU staging" } });
    expect(decodes).toBe(0);
    await expect(lstat(acquired[0]!)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(scratchRoot)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  });
});

function jobContext(scratchRoot: string, signal = new AbortController().signal) {
  return {
    job: {
      admission: "pre-acquired" as const,
      jobId: "gpu-admitted-test",
      scratchRoot,
      maxProcessTreeRssBytes: 512 * 1024 * 1024,
      signal,
      watchProcess() {},
      reportSandbox() {}
    },
    runner: stagingRunner([])
  };
}

function stagingRunner(commands: FfmpegCommand[]): FfmpegRunner {
  return async (command) => {
    commands.push(command);
    if (command.executable === "ffprobe") return probe();
    const output = command.args.at(-1)!;
    await writeFile(output, Buffer.from([0, 0, 0, 255, 255, 255, 255, 255, 10, 80, 180, 255, 250, 30, 40, 255]), { mode: 0o600 });
    return { exitCode: 0, stdout: "", stderr: "" };
  };
}

function probe(): FfmpegProcessResult {
  return {
    exitCode: 0,
    stdout: JSON.stringify({ streams: [{ codec_type: "video", width: 2, height: 2, duration: "1" }], format: { duration: "1" } }),
    stderr: ""
  };
}

async function fixtureRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `shellx-motion-gpu-admitted-${label}-`));
  roots.push(root);
  await mkdir(join(root, "assets"), { mode: 0o700 });
  await writeFile(join(root, "assets", "clip.mp4"), "immutable-video", { mode: 0o600 });
  return root;
}

function videoPackage(root: string): MotionPackage {
  return {
    root,
    manifest: {
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_gpu_admitted_video",
      name: "GPU admitted video",
      motion: "motion.json",
      assets: ["assets/clip.mp4"],
      sourceApp: "test",
      compatibility: { lanes: ["gpu"], hosts: ["motion"] }
    },
    motion: {
      schema: "shellx-motion/motion@1",
      id: "motion_gpu_admitted_video",
      name: "GPU admitted video",
      durationMs: 1_000,
      fps: 1,
      width: 2,
      height: 2,
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" },
      layers: [{
        id: "clip",
        type: "video",
        assetRef: "assets/clip.mp4",
        startMs: 0,
        durationMs: 1_000,
        transform: { x: 0, y: 0, width: 2, height: 2 }
      }]
    }
  };
}
