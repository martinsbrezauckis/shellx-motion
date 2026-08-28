import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TrackingAnalysisSettings } from "@shellx-motion/core";
import { analyzeTrackingMedia, type TrackingMediaCommandRunner } from "./index";

const roots: string[] = [];

describe("contained tracking media analysis", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("probes, decodes, and solves package-local media through shell-free analysis commands", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "shellx-motion-analysis-tracking-")));
    roots.push(root);
    const sourcePath = join(root, "fixture.mp4");
    await writeFile(sourcePath, Buffer.from("fixture-media-identity"));
    const contexts: string[] = [];
    const commands: Array<{ executable: string; args: string[]; shell: false }> = [];
    const decoded = Buffer.concat([
      syntheticFrame(32, 24, 10, 10),
      syntheticFrame(32, 24, 13, 12),
      syntheticFrame(32, 24, 16, 14),
    ]);
    const runCommand: TrackingMediaCommandRunner = async (command, context) => {
      contexts.push(context.operation);
      commands.push(command);
      if (context.operation === "analysis.media.probe") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ streams: [{ width: 32, height: 24 }], format: { duration: "0.2" } }),
          stderr: "",
        };
      }
      await writeFile(command.args.at(-1)!, decoded);
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await analyzeTrackingMedia({
      id: "package_point_track",
      assetId: "video_plate",
      sourcePath,
      inputRoot: root,
      mode: "point",
      model: "translation",
      reference: { atMs: 0, bounds: { x: 6, y: 6, width: 8, height: 8 }, points: [{ x: 10, y: 10 }] },
      settings: settings(),
      scratchRoot: root,
      packageId: "pkg_tracking",
      createdAt: "2026-07-13T23:00:00.000Z",
      runCommand,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(contexts).toEqual(["analysis.media.probe", "analysis.media.decode"]);
    expect(commands.every((command) => command.shell === false)).toBe(true);
    const subprocessInputs = commands.map((command) => command.args[command.args.indexOf("-i") + 1]);
    expect(subprocessInputs[0]).toBe(subprocessInputs[1]);
    expect(subprocessInputs[0]).not.toBe(sourcePath);
    expect(commands.every((command) => command.args.includes("-protocol_whitelist") && command.args.includes("-format_whitelist"))).toBe(true);
    expect(commands.every((command) => command.args.includes("-enable_drefs") && command.args.includes("-use_absolute_path"))).toBe(true);
    expect(commands[1].args).toEqual(expect.arrayContaining([
      "-nostdin", "-vf", "fps=1000/100", "-frames:v", "3", "-pix_fmt", "gray", "-f", "rawvideo",
    ]));
    expect(result.analysis.samples.map((sample) => sample.matrix)).toEqual([
      [1, 0, 0, 0, 1, 0, 0, 0, 1],
      [1, 0, 3, 0, 1, 2, 0, 0, 1],
      [1, 0, 6, 0, 1, 4, 0, 0, 1],
    ]);
    expect(result).toMatchObject({
      source: { assetId: "video_plate", width: 32, height: 24, durationMs: 200 },
      lifecycle: { state: "succeeded", lastGood: { id: "package_point_track" } },
      receipt: { operation: "analysis.tracking.request", status: "passed", lane: "analysis" },
    });
    expect(await fileExists(commands[1].args.at(-1)!)).toBe(false);
    expect(await fileExists(subprocessInputs[0]!)).toBe(false);
  });

  it("uses one immutable snapshot when the caller replaces the original media after probe", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "shellx-motion-analysis-tracking-swap-")));
    roots.push(root);
    const sourcePath = join(root, "swap.mp4");
    const admitted = Buffer.from("admitted-media-bytes");
    await writeFile(sourcePath, admitted);
    const subprocessInputs: string[] = [];
    const decoded = Buffer.concat([
      syntheticFrame(32, 24, 10, 10),
      syntheticFrame(32, 24, 13, 12),
      syntheticFrame(32, 24, 16, 14),
    ]);
    const result = await analyzeTrackingMedia({
      id: "swapped_track",
      assetId: "video_plate",
      sourcePath,
      inputRoot: root,
      mode: "point",
      model: "translation",
      reference: { atMs: 0, bounds: { x: 6, y: 6, width: 8, height: 8 }, points: [{ x: 10, y: 10 }] },
      settings: settings(),
      scratchRoot: root,
      packageId: "pkg_tracking",
      runCommand: async (command, context) => {
        const subprocessInput = command.args[command.args.indexOf("-i") + 1]!;
        subprocessInputs.push(subprocessInput);
        await expect(readFile(subprocessInput)).resolves.toEqual(admitted);
        if (context.operation === "analysis.media.probe") {
          await writeFile(sourcePath, Buffer.from("replacement-media-bytes"));
          return { exitCode: 0, stdout: JSON.stringify({ streams: [{ width: 32, height: 24 }], format: { duration: "0.2" } }), stderr: "" };
        }
        await writeFile(command.args.at(-1)!, decoded);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    expect(result).toMatchObject({
      ok: true,
      source: { sha256: createHash("sha256").update(admitted).digest("hex"), byteLength: admitted.byteLength },
    });
    expect(new Set(subprocessInputs).size).toBe(1);
    expect(await fileExists(subprocessInputs[0]!)).toBe(false);
  });

  it("refuses playlist and unknown tracking formats before a subprocess can open them", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "shellx-motion-analysis-tracking-playlist-")));
    roots.push(root);
    const sourcePath = join(root, "attack.m3u8");
    await writeFile(sourcePath, "#EXTM3U\nfile:///etc/passwd\n");
    let runnerCalls = 0;
    const result = await analyzeTrackingMedia({
      id: "playlist_track",
      assetId: "video_plate",
      sourcePath,
      inputRoot: root,
      mode: "point",
      model: "translation",
      reference: { atMs: 0, bounds: { x: 6, y: 6, width: 8, height: 8 }, points: [{ x: 10, y: 10 }] },
      settings: settings(),
      scratchRoot: root,
      packageId: "pkg_tracking",
      runCommand: async () => {
        runnerCalls += 1;
        return { exitCode: 1, stdout: "", stderr: "must not run" };
      },
    });

    expect(result).toMatchObject({ ok: false, error: { code: "tracking_probe_failed", message: expect.stringContaining("MP4, MOV, Matroska, or WebM") } });
    expect(runnerCalls).toBe(0);
  });

  it("fails closed when decoded bytes do not match probed dimensions", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "shellx-motion-analysis-tracking-short-")));
    roots.push(root);
    const sourcePath = join(root, "short.mp4");
    await writeFile(sourcePath, Buffer.from("short-media"));
    const runCommand: TrackingMediaCommandRunner = async (command, context) => {
      if (context.operation === "analysis.media.probe") {
        return { exitCode: 0, stdout: JSON.stringify({ streams: [{ width: 32, height: 24 }], format: { duration: "0.2" } }), stderr: "" };
      }
      await writeFile(command.args.at(-1)!, Buffer.alloc(10));
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const result = await analyzeTrackingMedia({
      id: "short_decode",
      assetId: "video_plate",
      sourcePath,
      inputRoot: root,
      mode: "point",
      model: "translation",
      reference: { atMs: 0, bounds: { x: 6, y: 6, width: 8, height: 8 }, points: [{ x: 10, y: 10 }] },
      settings: settings(),
      scratchRoot: root,
      packageId: "pkg_tracking",
      runCommand,
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "tracking_decode_failed", message: expect.stringContaining("expected 2304") },
      lifecycle: { state: "failed" },
      receipt: { status: "failed", operation: "analysis.tracking.request" },
    });
    expect(result.lifecycle).not.toHaveProperty("lastGood");
  });

  it("returns cancellation state without pretending a partial result succeeded", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "shellx-motion-analysis-tracking-cancel-")));
    roots.push(root);
    const sourcePath = join(root, "cancel.mp4");
    await writeFile(sourcePath, Buffer.from("cancel-media"));
    const controller = new AbortController();
    controller.abort(new Error("cancelled by test"));
    const result = await analyzeTrackingMedia({
      id: "cancelled_track",
      assetId: "video_plate",
      sourcePath,
      inputRoot: root,
      mode: "point",
      model: "translation",
      reference: { atMs: 0, bounds: { x: 6, y: 6, width: 8, height: 8 }, points: [{ x: 10, y: 10 }] },
      settings: settings(),
      scratchRoot: root,
      packageId: "pkg_tracking",
      signal: controller.signal,
      runCommand: async (_command, context) => { throw context.signal?.reason; },
    });

    expect(result).toMatchObject({ ok: false, error: { code: "tracking_cancelled" }, resources: [] });
    expect(result).not.toHaveProperty("analysis");
  });

  it("preserves lastGood while a contained retry fails", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "shellx-motion-analysis-tracking-retry-")));
    roots.push(root);
    const sourcePath = join(root, "retry.mp4");
    await writeFile(sourcePath, Buffer.from("retry-media"));
    const decoded = Buffer.concat([
      syntheticFrame(32, 24, 10, 10),
      syntheticFrame(32, 24, 13, 12),
      syntheticFrame(32, 24, 16, 14),
    ]);
    const successfulRunner: TrackingMediaCommandRunner = async (command, context) => {
      if (context.operation === "analysis.media.probe") {
        return { exitCode: 0, stdout: JSON.stringify({ streams: [{ width: 32, height: 24 }], format: { duration: "0.2" } }), stderr: "" };
      }
      await writeFile(command.args.at(-1)!, decoded);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const first = await analyzeTrackingMedia({
      id: "retry_track",
      assetId: "video_plate",
      sourcePath,
      inputRoot: root,
      mode: "point",
      model: "translation",
      reference: { atMs: 0, bounds: { x: 6, y: 6, width: 8, height: 8 }, points: [{ x: 10, y: 10 }] },
      settings: settings(),
      scratchRoot: root,
      packageId: "pkg_tracking",
      runCommand: successfulRunner,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const retry = await analyzeTrackingMedia({
      id: "retry_track",
      assetId: "video_plate",
      sourcePath,
      inputRoot: root,
      mode: "point",
      model: "translation",
      reference: { atMs: 0, bounds: { x: 6, y: 6, width: 8, height: 8 }, points: [{ x: 10, y: 10 }] },
      settings: settings(),
      scratchRoot: root,
      packageId: "pkg_tracking",
      existingLifecycle: first.lifecycle,
      runCommand: async (command, context) => {
        if (context.operation === "analysis.media.probe") return successfulRunner(command, context);
        return { exitCode: 9, stdout: "", stderr: "decoder retry failed" };
      },
    });

    expect(retry).toMatchObject({
      ok: false,
      error: { code: "tracking_decode_failed" },
      lifecycle: {
        state: "failed",
        attempt: 2,
        lastGood: { id: "retry_track", samples: [{ atMs: 0 }, { atMs: 100 }, { atMs: 200 }] },
      },
      receipt: { status: "failed" },
    });
  });
});

function settings(): TrackingAnalysisSettings {
  return {
    startMs: 0,
    endMs: 200,
    stepMs: 100,
    direction: "forward",
    searchRadiusPx: 8,
    pyramidLevels: 2,
    maxIterations: 20,
    confidenceFloor: 0.7,
    deterministicSeed: 1,
  };
}

function syntheticFrame(width: number, height: number, x: number, y: number): Buffer {
  const frame = Buffer.alloc(width * height);
  frame[y * width + x] = 255;
  frame[y * width + x - 1] = 80;
  frame[y * width + x + 1] = 140;
  frame[(y - 1) * width + x] = 210;
  frame[(y + 1) * width + x] = 100;
  return frame;
}

async function fileExists(path: string): Promise<boolean> {
  try { await readFile(path); return true; } catch { return false; }
}
