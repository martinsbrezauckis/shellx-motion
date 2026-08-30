import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { MotionPackage } from "@shellx-motion/core";
import {
  linearSrgbSdrFinalCliDryRun,
  planLinearSrgbSdrFinalCliRender,
  streamingFinalCliRenderInput,
  type StreamingFinalCliContext,
} from "./linear-srgb-sdr-final-cli.js";

describe("CLI strict linear-sRGB SDR final projection", () => {
  it("projects one exact dry-run command without tool or output work", () => {
    const context = cliContext();
    const plan = planLinearSrgbSdrFinalCliRender(context, { workflow: undefined, injectedFrameRenderer: false });
    expect(plan).toMatchObject({ kind: "strict", command: { args: expect.arrayContaining(["libx264", "yuv420p", context.outputPath]) } });
    const dryRun = linearSrgbSdrFinalCliDryRun(plan, { executable: "legacy-must-not-win", args: [], shell: false });
    expect(dryRun).toMatchObject({ ffmpeg: { args: expect.arrayContaining(["libx264", context.outputPath]) }, colorPipeline: { intent: "linear-srgb-sdr@1", preflight: "not_run" } });
  });

  it("removes generic runner and process seams from strict execution input while preserving legacy projection", () => {
    const context = cliContext();
    const runner = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    const processFactory = async () => { throw new Error("must not run"); };
    const strict = streamingFinalCliRenderInput(context, { runner, processFactory, forceSoftwareEncode: true, ffmpegVersion: "forged" }, true);
    expect(strict.toolPolicy).toBeUndefined();

    const legacy = streamingFinalCliRenderInput({ ...context, pkg: legacyPackage() }, { runner, processFactory, forceSoftwareEncode: true, ffmpegVersion: "test" }, false);
    expect(legacy.toolPolicy).toMatchObject({ runner, processFactory, forceSoftwareEncode: true, ffmpegVersion: "test" });
  });

  it("refuses incompatible strict CLI controls in the pure branch", () => {
    const context = cliContext();
    expect(planLinearSrgbSdrFinalCliRender({ ...context, keepFrames: true }, { workflow: undefined, injectedFrameRenderer: false })).toMatchObject({ kind: "refused" });
    expect(planLinearSrgbSdrFinalCliRender(context, { workflow: {} as never, injectedFrameRenderer: false })).toMatchObject({ kind: "refused" });
    expect(planLinearSrgbSdrFinalCliRender(context, { workflow: undefined, injectedFrameRenderer: true })).toMatchObject({ kind: "refused" });
  });
});

function cliContext(): StreamingFinalCliContext {
  return {
    pkg: strictPackage(), frameLane: "gpu", outputPath: join(tmpdir(), "strict-cli.mp4"), preset: "mp4-h264",
    audio: undefined, audioTracks: undefined, audioMaster: undefined, inputRoots: ["/package"], outputRoots: [tmpdir()],
    quality: undefined, qualityManifest: undefined, keepFrames: false, force: false,
    transport: { delivery: "streamed", reason: "stream_default" }, signal: undefined,
  };
}

function strictPackage(): MotionPackage {
  const motion = {
    schema: "shellx-motion/motion@1" as const, id: "strict-cli", name: "Strict CLI", durationMs: 1_000, fps: 2, width: 2, height: 2, background: "#101820",
    colorPipeline: { schema: "shellx-motion/color-pipeline@1" as const, intent: "linear-srgb-sdr@1" as const }, assets: [], provenance: { sourceApp: "test", createdBy: "strict-cli-test" },
    layers: [{ id: "rect", type: "shape" as const, shape: "rect" as const, startMs: 0, durationMs: 1_000, fill: "#ff0040", opacity: 0.5, transform: { x: 0, y: 0, width: 1, height: 1 } }],
  };
  return { root: "/package", manifest: { schema: "shellx-motion/package-manifest@1", id: motion.id, name: motion.name, motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["gpu", "ffmpeg"], hosts: ["local"] } }, motion };
}

function legacyPackage(): MotionPackage {
  const pkg = strictPackage();
  return { ...pkg, motion: { ...pkg.motion, colorPipeline: undefined } };
}
