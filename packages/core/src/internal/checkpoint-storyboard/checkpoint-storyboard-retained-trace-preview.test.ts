import { describe, expect, it } from "vitest";
import { createCheckpointStoryboard } from "../../internal/checkpoint-storyboard/checkpoint-storyboard-records";
import { createTransitionRecipe } from "../../internal/checkpoint-storyboard/checkpoint-storyboard-recipes";
import { GPU_PARAMETRIC_TRACE_VERTEX_STRIDE_BYTES } from "../../gpu-parametric-trace-preview";
import {
  compileCheckpointStoryboardRetainedTracePreviewFramePlan,
  compileCheckpointStoryboardRetainedTracePreviewStaticPlan,
  readCheckpointStoryboardRetainedTracePreviewUpload,
} from "./checkpoint-storyboard-retained-trace-preview";
import {
  CHECKPOINT_STORYBOARD_RETAINED_TRACE_PROFILE_CAPS,
  CHECKPOINT_STORYBOARD_RETAINED_TRACE_PROFILE_REQUEST_SCHEMA,
} from "./checkpoint-storyboard-retained-trace-profile-types";
import { compileCheckpointStoryboardRetainedTraceProfilePlan } from "./checkpoint-storyboard-retained-trace-profile";
import type { MotionDocument } from "../../types";

const HASH = "a".repeat(64);

describe("shipping-private C6C-B7 retained-trace preview authority", () => {
  it("issues fixed 20-byte samples with exact pixel-to-NDC raster evidence and bounded triangle-list work", () => {
    const { motion, plan } = fixture();
    const staticResult = compileCheckpointStoryboardRetainedTracePreviewStaticPlan(motion, plan);
    expect(staticResult).toMatchObject({ ok: true }); if (!staticResult.ok) return;
    expect(Object.isFrozen(staticResult.plan)).toBe(true);
    expect(staticResult.plan.rasterization).toMatchObject({
      mapping: "motion-top-left-pixel-xy-to-ndc@1",
      sampleZ: "ignore-packed-sample-z@1",
      source: "fixed-20-byte-raw-u32-storage@1",
      tessellation: "square-cap-or-endpoint-width-segment-quad@1",
      primitive: "triangle-list",
      sampleStrideBytes: GPU_PARAMETRIC_TRACE_VERTEX_STRIDE_BYTES,
      maxSamples: 64,
      maxRasterVertexInvocations: 378,
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });

    const frameResult = compileCheckpointStoryboardRetainedTracePreviewFramePlan(motion, staticResult.plan, 4_000);
    expect(frameResult).toMatchObject({ ok: true }); if (!frameResult.ok) return;
    expect(frameResult.plan).toMatchObject({
      atUs: 4_000,
      drawers: [{ mode: "line", topology: { primitive: "line-strip", bufferBinding: { slot: 0, strideBytes: GPU_PARAMETRIC_TRACE_VERTEX_STRIDE_BYTES } } }],
      rasterization: {
        staticRasterizationFingerprint: staticResult.plan.rasterization.fingerprint,
        sampleCount: 5,
        sampleUploadBytes: 100,
        rasterVertexCount: 24,
        drawVertexInvocations: 24,
        maxRasterVertexInvocations: 378,
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });

    const upload = readCheckpointStoryboardRetainedTracePreviewUpload(staticResult.plan, frameResult.plan);
    expect(upload.drawers).toHaveLength(1);
    expect(upload.drawers[0]!.vertexBytes.byteLength).toBe(5 * GPU_PARAMETRIC_TRACE_VERTEX_STRIDE_BYTES);
    const cap = compileCheckpointStoryboardRetainedTracePreviewFramePlan(motion, staticResult.plan, 0);
    expect(cap).toMatchObject({ ok: true, plan: { rasterization: { sampleCount: 1, rasterVertexCount: 6, drawVertexInvocations: 6 } } });
    expect(compileCheckpointStoryboardRetainedTracePreviewFramePlan(motion, staticResult.plan, 2_500)).toMatchObject({ ok: false, failure: { code: "gpu_invalid_time" } });
    expect(compileCheckpointStoryboardRetainedTracePreviewFramePlan(motion, staticResult.plan, 2_000.5)).toMatchObject({ ok: false, failure: { code: "gpu_invalid_time" } });
  });

  it("refuses cloned, forged, stale, and cross-wrapper authority before exposing upload bytes", () => {
    const { motion, plan } = fixture();
    const staticResult = compileCheckpointStoryboardRetainedTracePreviewStaticPlan(motion, plan);
    expect(staticResult).toMatchObject({ ok: true }); if (!staticResult.ok) return;
    const frameResult = compileCheckpointStoryboardRetainedTracePreviewFramePlan(motion, staticResult.plan, 2_000);
    expect(frameResult).toMatchObject({ ok: true }); if (!frameResult.ok) return;

    expect(compileCheckpointStoryboardRetainedTracePreviewFramePlan(motion, structuredClone(staticResult.plan), 2_000)).toMatchObject({ ok: false, failure: { code: "gpu_resource_refused" } });
    expect(() => readCheckpointStoryboardRetainedTracePreviewUpload(staticResult.plan, structuredClone(frameResult.plan))).toThrow("exact Core-issued");
    const revisedMotion = structuredClone(motion); revisedMotion.name = "revised";
    expect(compileCheckpointStoryboardRetainedTracePreviewFramePlan(revisedMotion, staticResult.plan, 2_000)).toMatchObject({ ok: false, failure: { code: "gpu_resource_refused", message: expect.stringContaining("stale") } });

    const second = compileCheckpointStoryboardRetainedTracePreviewStaticPlan(motion, structuredClone(plan));
    expect(second).toMatchObject({ ok: true }); if (second.ok) expect(() => readCheckpointStoryboardRetainedTracePreviewUpload(second.plan, frameResult.plan)).toThrow("matching exact");
    const forged = structuredClone(plan) as any; forged.lowererProfile.outputMode = "ribbon";
    expect(compileCheckpointStoryboardRetainedTracePreviewStaticPlan(motion, forged)).toMatchObject({ ok: false, failure: { code: "gpu_unsupported_feature" } });
  });

  it("admits exact modular-turns evidence from the bounded axis evaluator", () => {
    const { motion, plan } = fixture("modular-turns");
    expect(plan.projection.trace.evidence.trigonometry).toBe("exact-modular-turns@1");
    expect(compileCheckpointStoryboardRetainedTracePreviewStaticPlan(motion, plan)).toMatchObject({ ok: true });
  });
});

function fixture(trigonometry: "none" | "modular-turns" = "none") {
  const graph = trigonometry === "modular-turns"
    ? { nodes: [{ id: "time", kind: "time-us" }, { id: "x", kind: "lissajous-axis-q1024", time: "time", durationUs: 4_000, frequency: 1, phaseTurnsQ1024: 0, center: 0, amplitude: 2 }, { id: "y", kind: "lissajous-axis-q1024", time: "time", durationUs: 4_000, frequency: 1, phaseTurnsQ1024: 0, center: 0, amplitude: 1 }, { id: "zero", kind: "constant", value: 0 }], output: { x: "x", y: "y", z: "zero" } }
    : { nodes: [{ id: "time", kind: "time-us" }, { id: "scale", kind: "constant", value: 0.001 }, { id: "x", kind: "multiply", left: "time", right: "scale" }, { id: "zero", kind: "constant", value: 0 }], output: { x: "x", y: "zero", z: "zero" } };
  const trace: any = {
    schema: "shellx-motion/private-parametric-trace@1",
    clip: { durationUs: 4_000, sampleIntervalUs: 1_000 },
    drawers: [{
      id: "line",
      driver: { kind: "parametric-graph", graph },
      retention: { kind: "full-clip", maxSamples: 5 },
      output: { mode: "line", width: { source: "constant", from: 2, to: 2 }, colour: { source: "constant", from: 0.5, to: 0.5 }, opacity: { source: "constant", from: 0.75, to: 0.75 }, speedLimit: 100 },
    }],
    caps: { perDrawer: { ...CHECKPOINT_STORYBOARD_RETAINED_TRACE_PROFILE_CAPS }, aggregate: { ...CHECKPOINT_STORYBOARD_RETAINED_TRACE_PROFILE_CAPS } },
  };
  const recipe = createTransitionRecipe({ recipeId: "retained-line", seed: 2, exactBaseRequirements: [], intent: { kind: "parametric-trace", outputObjectId: "trace-anchor", trace } });
  const storyboard = createCheckpointStoryboard({
    seed: 1,
    capabilityRequirements: ["renderer.gpu"],
    objectCatalog: [{ objectId: "trace-anchor", rootShapeKind: "rect", propertyMask: ["opacity"] }],
    checkpoints: [
      { id: "start", atUs: 0, objects: [{ objectId: "trace-anchor", state: "present", properties: [{ property: "opacity", value: 0.75 }] }] },
      { id: "finish", atUs: 4_000, objects: [{ objectId: "trace-anchor", state: "present", properties: [{ property: "opacity", value: 0.75 }] }] },
    ],
    edges: [{ id: "start-finish", fromCheckpointId: "start", toCheckpointId: "finish", lifecycle: [{ kind: "preserve", objectId: "trace-anchor" }], recipeIds: ["retained-line"] }],
    recipes: [recipe],
  });
  const motion: MotionDocument = {
    schema: "shellx-motion/motion@1", id: "motion-1", name: "Private B7 preview fixture", durationMs: 4, fps: 30, width: 1280, height: 720, assets: [], provenance: { sourceApp: "test", createdBy: "test" },
    layers: [{ id: "trace-anchor", type: "shape", shape: "rect", fill: "#4e8cff", startMs: 0, durationMs: 4, opacity: 0.75, transform: { x: 0, y: 0, width: 100, height: 100 } }],
  };
  const plan = compileCheckpointStoryboardRetainedTraceProfilePlan({
    schema: CHECKPOINT_STORYBOARD_RETAINED_TRACE_PROFILE_REQUEST_SCHEMA,
    storyboard,
    base: {
      packageId: "package-1",
      manifest: { schema: "shellx-motion/package-manifest@1", id: "package-1", name: "Private B7 preview fixture", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["gpu"], hosts: [] } },
      motion,
      persistedMotionSha256: HASH,
    },
    objectLayerBindings: [{ objectId: "trace-anchor", layerId: "trace-anchor" }],
  });
  return { motion, plan };
}
