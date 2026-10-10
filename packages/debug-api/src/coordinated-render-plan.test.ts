import { canonicalJsonSha256, type StableRenderPackage } from "@shellx-motion/core";
import { describe, expect, it } from "vitest";
import { createCoordinatedRenderPlan } from "./coordinated-render-plan.js";
import { canonicalAttestedReuseHostPath } from "./domains/attested-render-reuse-root.js";
import type { FinalRenderRequest } from "./domains/render-final.js";
import { MOTION_ENGINE_VERSION } from "./version.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const HASH_E = "e".repeat(64);
const HOST = { injectedBrowserRenderer: false, gpuFinalExecutionAvailable: true } as const;

describe("coordinated render plan", () => {
  it("is deterministic, explicit about coordinator defaults, frozen, and path-free", () => {
    const first = createCoordinatedRenderPlan(request(), stablePackage(), HOST);
    const second = createCoordinatedRenderPlan(request({ segmented: undefined }), stablePackage(), HOST);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      schema: "shellx-motion/render-plan@1",
      operation: "render.final",
      quality: { mode: "none" },
      output: { preset: "mp4-h264", mediaRole: "final-video" },
      requested: {
        lane: "ffmpeg", frameLane: "browser", delivery: "streamed", segmented: null, fallback: "none",
      },
      runtime: { engine: `shellx-motion@${MOTION_ENGINE_VERSION}` },
      compatibility: { version: 1, state: "current" },
    });
    expect(first.output.intentSha256).toBe(canonicalJsonSha256({
      schema: "shellx-motion/final-output-intent@1",
      kind: "file",
      target: canonicalAttestedReuseHostPath("/host/renders/final.mp4"),
      receiptTarget: null,
    }));
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.package)).toBe(true);
    expect(Object.isFrozen(first.requested)).toBe(true);
    expect(Object.isFrozen(first.runtime)).toBe(true);
    expect(JSON.stringify(first)).not.toContain("/host/renders");
    expect(JSON.stringify(first)).not.toContain("/host/packages");
    expect(JSON.stringify(createCoordinatedRenderPlan(
      request({ receiptsRoot: "/host/receipts" }),
      stablePackage(),
      HOST,
    ))).not.toContain("/host/receipts");
  });

  it("binds each selected package, output, route, preset, and admission identity", () => {
    const base = createCoordinatedRenderPlan(request(), stablePackage(), HOST);
    const output = createCoordinatedRenderPlan(request({ outputPath: "/host/renders/other.mp4" }), stablePackage(), HOST);
    const receipts = createCoordinatedRenderPlan(request({ receiptsRoot: "/host/receipts" }), stablePackage(), HOST);
    const preset = createCoordinatedRenderPlan(request({ preset: "mp4-hevc" }), stablePackage(), HOST);
    const native = createCoordinatedRenderPlan(request({ frameLane: "native" }), stablePackage(), HOST);
    const segmented = createCoordinatedRenderPlan(request({ segmented: { segmentFrames: 48 } }), stablePackage(), HOST);
    const resumed = createCoordinatedRenderPlan(request({ segmented: { segmentFrames: 48, resume: true } }), stablePackage(), HOST);
    const packageId = createCoordinatedRenderPlan(request(), stablePackage({ packageId: "package-next" }), HOST);
    const manifest = createCoordinatedRenderPlan(request(), stablePackage({ manifestSha256: HASH_B }), HOST);
    const motionId = createCoordinatedRenderPlan(request(), stablePackage({ motionId: "motion-next" }), HOST);
    const motion = createCoordinatedRenderPlan(request(), stablePackage({ motionSha256: HASH_B }), HOST);
    const gltfLineage = createCoordinatedRenderPlan(request(), stablePackage({
      adapterId: "adapter.gltf",
      sourceSha256: HASH_C,
      normalizedSourceSha256: HASH_D,
      loweringReceiptSha256: HASH_E,
    }), HOST);

    expect(output.output.intentSha256).not.toBe(base.output.intentSha256);
    expect(receipts.output.intentSha256).not.toBe(base.output.intentSha256);
    expect(preset.runtime.presetFingerprint).not.toBe(base.runtime.presetFingerprint);
    expect(native.runtime.capabilityFingerprint).not.toBe(base.runtime.capabilityFingerprint);
    expect(segmented.runtime.routeFingerprint).not.toBe(base.runtime.routeFingerprint);
    expect(resumed.fingerprint).not.toBe(segmented.fingerprint);
    for (const plan of [output, receipts, preset, native, segmented, resumed, packageId, manifest, motionId, motion, gltfLineage]) {
      expect(plan.fingerprint).not.toBe(base.fingerprint);
    }
  });

  it("binds the normalized effective receipt root, with an explicit request root taking precedence", () => {
    const defaultRoot = createCoordinatedRenderPlan(
      request(), stablePackage(), { ...HOST, effectiveReceiptsRoot: "/host/receipts/default" },
    );
    const normalizedDefaultRoot = createCoordinatedRenderPlan(
      request(), stablePackage(), { ...HOST, effectiveReceiptsRoot: "/host/receipts/./default" },
    );
    const changedDefaultRoot = createCoordinatedRenderPlan(
      request(), stablePackage(), { ...HOST, effectiveReceiptsRoot: "/host/receipts/other" },
    );
    const override = createCoordinatedRenderPlan(
      request({ receiptsRoot: "/host/receipts/override" }),
      stablePackage(),
      { ...HOST, effectiveReceiptsRoot: "/host/receipts/default" },
    );
    const overrideWithOtherDefault = createCoordinatedRenderPlan(
      request({ receiptsRoot: "/host/receipts/override" }),
      stablePackage(),
      { ...HOST, effectiveReceiptsRoot: "/host/receipts/other" },
    );

    expect(defaultRoot.output.intentSha256).toBe(canonicalJsonSha256({
      schema: "shellx-motion/final-output-intent@1",
      kind: "file",
      target: canonicalAttestedReuseHostPath("/host/renders/final.mp4"),
      receiptTarget: canonicalAttestedReuseHostPath("/host/receipts/default"),
    }));
    expect(normalizedDefaultRoot).toEqual(defaultRoot);
    expect(changedDefaultRoot.output.intentSha256).not.toBe(defaultRoot.output.intentSha256);
    expect(override).toEqual(overrideWithOtherDefault);
    expect(override.output.intentSha256).not.toBe(defaultRoot.output.intentSha256);
    expect(JSON.stringify(defaultRoot)).not.toContain("/host/receipts/default");
  });

  it("normalizes segmented resume to false and fails closed outside the admitted coordinator route", () => {
    const implicitFalse = createCoordinatedRenderPlan(request({ segmented: { segmentFrames: 48 } }), stablePackage(), HOST);
    const explicitFalse = createCoordinatedRenderPlan(request({ segmented: { segmentFrames: 48, resume: false } }), stablePackage(), HOST);

    expect(implicitFalse).toEqual(explicitFalse);
    expect(implicitFalse.requested.segmented).toEqual({ segmentFrames: 48, resume: false });
    expect(() => createCoordinatedRenderPlan(request({ preset: "png-frame" }), stablePackage(), HOST)).toThrow("final-video FFmpeg preset");
    expect(() => createCoordinatedRenderPlan(request(), stablePackage(), { ...HOST, injectedBrowserRenderer: true }))
      .toThrow("streamed final-video frame transport");
    expect(createCoordinatedRenderPlan(
      request({ frameLane: "native" }), stablePackage(), { ...HOST, injectedBrowserRenderer: true },
    )).toEqual(createCoordinatedRenderPlan(request({ frameLane: "native" }), stablePackage(), HOST));
    expect(createCoordinatedRenderPlan(
      request({ frameLane: "gpu" }), stablePackage(), { ...HOST, injectedBrowserRenderer: true },
    )).toEqual(createCoordinatedRenderPlan(request({ frameLane: "gpu" }), stablePackage(), HOST));
    expect(() => createCoordinatedRenderPlan(request({ frameLane: "gpu" }), stablePackage(), { ...HOST, gpuFinalExecutionAvailable: false }))
      .toThrow("GPU-final admission gate");
    expect(() => createCoordinatedRenderPlan(request({ frameLane: "gpu", preset: "gif" }), stablePackage(), HOST))
      .toThrow("GIF delivery is not a GPU final-video job");
    expect(() => createCoordinatedRenderPlan(
      request({ segmented: { segmentFrames: 48 } }),
      stablePackage(),
      { ...HOST, injectedBrowserRenderer: true },
    )).toThrow("fixed host browser session");
  });
});

function request(change: Partial<FinalRenderRequest> = {}): FinalRenderRequest {
  return {
    packageRoot: "/host/packages/demo",
    outputPath: "/host/renders/final.mp4",
    frameLane: "browser",
    preset: "mp4-h264",
    dryRun: false,
    reuseAttested: false,
    ...change,
  };
}

function stablePackage(change: {
  packageId?: string;
  manifestSha256?: string;
  motionId?: string;
  motionSha256?: string;
  adapterId?: "adapter.gltf";
  sourceSha256?: string;
  normalizedSourceSha256?: string;
  loweringReceiptSha256?: string;
} = {}): StableRenderPackage {
  const manifestSha256 = change.manifestSha256 ?? HASH_A;
  const motionSha256 = change.motionSha256 ?? HASH_A;
  return {
    pkg: {
      manifest: { id: change.packageId ?? "package-demo" },
      motion: { id: change.motionId ?? "motion-demo" },
    } as StableRenderPackage["pkg"],
    lineage: {
      schema: "shellx-motion/package-render-lineage@1",
      manifestSha256,
      motionSha256,
      ...(change.adapterId ? {
        adapterId: change.adapterId,
        sourceSha256: change.sourceSha256,
        normalizedSourceSha256: change.normalizedSourceSha256,
        loweringReceiptSha256: change.loweringReceiptSha256,
      } : {}),
    },
  };
}
