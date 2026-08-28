import { createHash } from "node:crypto";
import type { MotionDocument } from "@shellx-motion/core";
import {
  compileCheckpointStoryboardRetainedTracePreviewFramePlan,
  compileCheckpointStoryboardRetainedTracePreviewStaticPlan,
  readCheckpointStoryboardRetainedTracePreviewUpload,
} from "@shellx-motion/core/internal/checkpoint-storyboard-retained-trace-preview";
import { compileCheckpointStoryboardRetainedTraceProfilePlan } from "@shellx-motion/core/internal/checkpoint-storyboard-retained-trace-profile";
import { createCheckpointStoryboard, createTransitionRecipe } from "@shellx-motion/core/internal/checkpoint-storyboard-relation-profile";
import { describe, expect, it } from "vitest";
import { createCheckpointStoryboardRetainedTraceRenderSession } from "./gpu-frame-renderer";

const WIDTH = 96;
const HEIGHT = 64;
const TRACE_X = 16;
const TRACE_Y = 12;
const TRACE_STEP = 32;
const TRACE_WIDTH = 6;
const TRACE_GRAYSCALE = 0.5;
const TRACE_ALPHA = 0.5;
const B7_OPERATION_TIMEOUT_MS = 30_000;
const B7_FIXTURE_TIMEOUT_MS = 240_000;
const B7_SCHEDULE = [0, 4_000, 8_000] as const;
const B7_PROFILE_CAPS = { maxSamples: 64, maxVertices: 64, maxWorkUnits: 16_384, maxBytes: 128 * 1024 } as const;
const B7_PROFILE_REQUEST_SCHEMA = "shellx-motion/private-checkpoint-storyboard-retained-trace-profile-request@1" as const;
const B7_QUALIFIED_LINUX_GPU_NODE_MAJOR = 24;

type B7QualifiedLinuxGpuRunnerFacts = {
  readonly explicitOptIn: boolean;
  readonly platform: NodeJS.Platform;
  readonly architecture: string;
  readonly nodeMajor: number;
};

function readB7QualifiedLinuxGpuRunnerFacts(): B7QualifiedLinuxGpuRunnerFacts {
  const [nodeMajorText] = process.versions.node.split(".", 1);
  return {
    explicitOptIn: process.env.MOTION_GPU_HARDWARE_FIXTURE === "1",
    platform: process.platform,
    architecture: process.arch,
    nodeMajor: Number.parseInt(nodeMajorText ?? "", 10),
  };
}

const B7_QUALIFIED_LINUX_GPU_RUNNER_FACTS = readB7QualifiedLinuxGpuRunnerFacts();

// This fixture owns a real Chromium/WebGPU process. Managed WSL may run the source suite, but
// never qualifies these pixels; the explicit opt-in and exact Linux x64 Node 24
// runner attestation are all required.
const describeQualifiedLinuxGpuB7Hardware = B7_QUALIFIED_LINUX_GPU_RUNNER_FACTS.explicitOptIn
  && B7_QUALIFIED_LINUX_GPU_RUNNER_FACTS.platform === "linux"
  && B7_QUALIFIED_LINUX_GPU_RUNNER_FACTS.architecture === "x64"
  && B7_QUALIFIED_LINUX_GPU_RUNNER_FACTS.nodeMajor === B7_QUALIFIED_LINUX_GPU_NODE_MAJOR
  ? describe
  : describe.skip;

describeQualifiedLinuxGpuB7Hardware("qualified Linux GPU host B7 retained-trace WebGPU raster", () => {
  it("attests the explicitly enabled Linux x64 Node 24 runner", () => {
    expect(B7_QUALIFIED_LINUX_GPU_RUNNER_FACTS).toEqual({
      explicitOptIn: true,
      platform: "linux",
      architecture: "x64",
      nodeMajor: B7_QUALIFIED_LINUX_GPU_NODE_MAJOR,
    });
  });

  it("renders exact 0/interior/D Core samples with transparent, correctly oriented translucent trace pixels and terminal cleanup", async () => {
    const { motion, retainedTracePlan } = b7Fixture();
    const staticResult = compileCheckpointStoryboardRetainedTracePreviewStaticPlan(motion, retainedTracePlan);
    expect(staticResult.ok, staticResult.ok ? undefined : staticResult.failure.message).toBe(true);
    if (!staticResult.ok) return;
    expect(staticResult.plan.rasterization).toMatchObject({
      mapping: "motion-top-left-pixel-xy-to-ndc@1",
      tessellation: "square-cap-or-endpoint-width-segment-quad@1",
      primitive: "triangle-list",
    });

    const opened = await createCheckpointStoryboardRetainedTraceRenderSession();
    expect(opened.ok, opened.ok ? undefined : opened.failure.message).toBe(true);
    if (!opened.ok) return;

    const samples: Array<{ atUs: number; frame: { readonly rgba: Uint8Array; readonly width: number; readonly height: number }; cleanup: { readonly sampleBufferDestroyed: true; readonly rasterControlBufferDestroyed: true; readonly targetDestroyed: true; readonly readbackBufferDestroyed: true } }> = [];
    try {
      for (const atUs of B7_SCHEDULE) {
        const frameResult = compileCheckpointStoryboardRetainedTracePreviewFramePlan(motion, staticResult.plan, atUs);
        expect(frameResult.ok, frameResult.ok ? undefined : frameResult.failure.message).toBe(true);
        if (!frameResult.ok) return;
        const sampleCount = atUs / 4_000 + 1;
        expect(frameResult.plan).toMatchObject({
          atUs,
          rasterization: { sampleCount, rasterVertexCount: sampleCount === 1 ? 6 : (sampleCount - 1) * 6 },
        });
        const upload = readCheckpointStoryboardRetainedTracePreviewUpload(staticResult.plan, frameResult.plan);
        expect(upload.drawers).toHaveLength(1);
        const drawer = upload.drawers[0];
        if (!drawer) throw new Error("The exact B7 Core upload did not issue its one retained-trace drawer.");

        const drawn = await opened.session.renderCheckpointStoryboardRetainedTrace({
          width: WIDTH,
          height: HEIGHT,
          sampleCount,
          rasterVertexInvocations: frameResult.plan.rasterization.drawVertexInvocations,
          vertexBytes: drawer.vertexBytes,
        }, { timeoutMs: B7_OPERATION_TIMEOUT_MS });
        expect(drawn.ok, drawn.ok ? undefined : drawn.failure.message).toBe(true);
        if (!drawn.ok) return;
        expect(drawn.frame).toMatchObject({
          width: WIDTH,
          height: HEIGHT,
          evidence: { backend: "webgpu-browser", adapterFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) },
        });
        expect(drawn.frame.rgba.byteLength).toBe(WIDTH * HEIGHT * 4);
        expect(drawn.cleanup).toEqual({
          sampleBufferDestroyed: true,
          rasterControlBufferDestroyed: true,
          targetDestroyed: true,
          readbackBufferDestroyed: true,
        });
        // The direct session path returns only in-memory RGBA. It has no staging/output option.
        expect(drawn.frame).not.toHaveProperty("path");
        samples.push({ atUs, frame: drawn.frame, cleanup: drawn.cleanup });
      }
    } finally {
      await opened.session.close();
    }

    expect(samples.map((sample) => sample.atUs)).toEqual(B7_SCHEDULE);
    expect(samples.every((sample) => sample.cleanup.sampleBufferDestroyed && sample.cleanup.rasterControlBufferDestroyed && sample.cleanup.targetDestroyed && sample.cleanup.readbackBufferDestroyed)).toBe(true);

    const frameHashes = samples.map((sample) => createHash("sha256").update(sample.frame.rgba).digest("hex"));
    expect(new Set(frameHashes).size).toBe(B7_SCHEDULE.length);
    const visibleCounts = samples.map((sample) => nonTransparentPixels(sample.frame));
    expect(visibleCounts.every((count) => count > 0)).toBe(true);
    expect(visibleCounts[0]).toBeLessThan(visibleCounts[1]!);
    expect(visibleCounts[1]).toBeLessThan(visibleCounts[2]!);

    const first = samples[0]!.frame;
    const interior = samples[1]!.frame;
    expect(pixel(first, 0, 0)).toEqual([0, 0, 0, 0]);
    expect(pixel(interior, WIDTH - 1, HEIGHT - 1)).toEqual([0, 0, 0, 0]);
    expect(transparentPixels(first)).toBeGreaterThan(0);

    // Motion coordinates are top-left pixels: the first cap is at y=12, not its bottom-left mirror.
    const centre = pixel(first, TRACE_X, TRACE_Y);
    expect(centre[3]).toBeGreaterThan(0);
    expect(alphaAt(first, TRACE_X, HEIGHT - 1 - TRACE_Y)).toBe(0);
    expect(nonTransparentRowsAtX(interior, TRACE_X + TRACE_STEP / 2)).toBeGreaterThan(1);

    // The fixed page writes premultiplied RGBA, then the shared frame-finalization boundary
    // converts that owned readback to the renderer's documented straight-alpha RGBA contract.
    // The solid cap therefore retains the independently issued grayscale and opacity values.
    expect(centre[3]).toBeLessThan(255);
    expect(centre[0]).toBe(centre[1]);
    expect(centre[1]).toBe(centre[2]);
    expect(centre[0] / 255).toBeCloseTo(TRACE_GRAYSCALE, 1);
    expect(centre[3] / 255).toBeCloseTo(TRACE_ALPHA, 1);
    expect(samples.flatMap((sample) => nonTransparent(sample.frame)).every((value) => value.r <= value.a && value.g <= value.a && value.b <= value.a)).toBe(true);

    expect(opened.session.resourceMetrics).toBeTypeOf("function");
    if (!opened.session.resourceMetrics) throw new Error("The B7 hardware session did not expose terminal resource metrics.");
    const terminalResources = await opened.session.resourceMetrics();
    expect(terminalResources).toMatchObject({
      schema: "shellx-motion/gpu-page-session-resources@1",
      framesRendered: 0,
      frameTextureSlots: 0,
      frameTextureBytes: 0,
      dynamicBufferSlots: 0,
      dynamicBufferBytes: 0,
      immutableImageTextures: 0,
      retainedTextSurfaces: 0,
    });
  }, B7_FIXTURE_TIMEOUT_MS);

  it("keeps the exact Node 24 qualified Linux GPU-host runner budget above the three bounded raster operations", () => {
    expect(process.versions.node.startsWith("24.")).toBe(true);
    expect(B7_FIXTURE_TIMEOUT_MS).toBeGreaterThan(B7_OPERATION_TIMEOUT_MS * B7_SCHEDULE.length);
  });
});

function b7Fixture(): { motion: MotionDocument; retainedTracePlan: unknown } {
  const motion: MotionDocument = {
    schema: "shellx-motion/motion@1",
    id: "b7-hardware-motion",
    name: "Private B7 hardware raster fixture",
    durationMs: 8,
    fps: 30,
    width: WIDTH,
    height: HEIGHT,
    assets: [],
    provenance: { sourceApp: "test", createdBy: "test" },
    layers: [{
      id: "trace-anchor",
      type: "shape",
      shape: "rect",
      fill: "#808080",
      startMs: 0,
      durationMs: 8,
      opacity: TRACE_ALPHA,
      transform: { x: 0, y: 0, width: 1, height: 1 },
    }],
  };
  const trace = {
    schema: "shellx-motion/private-parametric-trace@1",
    clip: { durationUs: 8_000, sampleIntervalUs: 4_000 },
    drawers: [{
      id: "line",
      driver: {
        kind: "parametric-graph",
        graph: {
          nodes: [
            { id: "time", kind: "time-us" },
            { id: "step", kind: "constant", value: TRACE_STEP / 4_000 },
            { id: "distance", kind: "multiply", left: "time", right: "step" },
            { id: "origin", kind: "constant", value: TRACE_X },
            { id: "x", kind: "add", left: "origin", right: "distance" },
            { id: "y", kind: "constant", value: TRACE_Y },
            { id: "z", kind: "constant", value: 0 },
          ],
          output: { x: "x", y: "y", z: "z" },
        },
      },
      retention: { kind: "full-clip", maxSamples: B7_SCHEDULE.length },
      output: {
        mode: "line",
        width: { source: "constant", from: TRACE_WIDTH, to: TRACE_WIDTH },
        colour: { source: "constant", from: TRACE_GRAYSCALE, to: TRACE_GRAYSCALE },
        opacity: { source: "constant", from: TRACE_ALPHA, to: TRACE_ALPHA },
        speedLimit: 100,
      },
    }],
    caps: {
      perDrawer: { ...B7_PROFILE_CAPS },
      aggregate: { ...B7_PROFILE_CAPS },
    },
  };
  const recipe = createTransitionRecipe({
    recipeId: "retained-line",
    seed: 2,
    exactBaseRequirements: [],
    intent: { kind: "parametric-trace", outputObjectId: "trace-anchor", trace },
  });
  const storyboard = createCheckpointStoryboard({
    seed: 1,
    capabilityRequirements: ["renderer.gpu"],
    objectCatalog: [{ objectId: "trace-anchor", rootShapeKind: "rect", propertyMask: ["opacity"] }],
    checkpoints: [
      { id: "start", atUs: 0, objects: [{ objectId: "trace-anchor", state: "present", properties: [{ property: "opacity", value: TRACE_ALPHA }] }] },
      { id: "finish", atUs: 8_000, objects: [{ objectId: "trace-anchor", state: "present", properties: [{ property: "opacity", value: TRACE_ALPHA }] }] },
    ],
    edges: [{ id: "start-finish", fromCheckpointId: "start", toCheckpointId: "finish", lifecycle: [{ kind: "preserve", objectId: "trace-anchor" }], recipeIds: ["retained-line"] }],
    recipes: [recipe],
  });
  return {
    motion,
    retainedTracePlan: compileCheckpointStoryboardRetainedTraceProfilePlan({
      schema: B7_PROFILE_REQUEST_SCHEMA,
      storyboard,
      base: {
        packageId: "b7-hardware-package",
        manifest: {
          schema: "shellx-motion/package-manifest@1",
          id: "b7-hardware-package",
          name: "Private B7 hardware raster fixture",
          motion: "motion.json",
          assets: [],
          sourceApp: "test",
          compatibility: { lanes: ["gpu"], hosts: [] },
        },
        motion,
        persistedMotionSha256: "a".repeat(64),
      },
      objectLayerBindings: [{ objectId: "trace-anchor", layerId: "trace-anchor" }],
    }),
  };
}

function pixel(frame: { readonly rgba: Uint8Array; readonly width: number; readonly height: number }, x: number, y: number): [number, number, number, number] {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= frame.width || y >= frame.height) throw new Error("B7 hardware fixture requested a pixel outside its frame.");
  const offset = (y * frame.width + x) * 4;
  return [frame.rgba[offset]!, frame.rgba[offset + 1]!, frame.rgba[offset + 2]!, frame.rgba[offset + 3]!];
}

function alphaAt(frame: { readonly rgba: Uint8Array; readonly width: number; readonly height: number }, x: number, y: number): number {
  return pixel(frame, x, y)[3];
}

function nonTransparentPixels(frame: { readonly rgba: Uint8Array; readonly width: number; readonly height: number }): number {
  return nonTransparent(frame).length;
}

function transparentPixels(frame: { readonly rgba: Uint8Array; readonly width: number; readonly height: number }): number {
  return frame.width * frame.height - nonTransparentPixels(frame);
}

function nonTransparentRowsAtX(frame: { readonly rgba: Uint8Array; readonly width: number; readonly height: number }, x: number): number {
  return Array.from({ length: frame.height }, (_, y) => alphaAt(frame, x, y) > 0).filter(Boolean).length;
}

function nonTransparent(frame: { readonly rgba: Uint8Array; readonly width: number; readonly height: number }): Array<{ r: number; g: number; b: number; a: number }> {
  const values: Array<{ r: number; g: number; b: number; a: number }> = [];
  for (let offset = 0; offset < frame.rgba.byteLength; offset += 4) {
    const a = frame.rgba[offset + 3]!;
    if (a > 0) values.push({ r: frame.rgba[offset]!, g: frame.rgba[offset + 1]!, b: frame.rgba[offset + 2]!, a });
  }
  return values;
}
