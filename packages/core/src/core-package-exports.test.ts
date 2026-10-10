import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { collectPackedRuntimeExportContract } from "../../../scripts/public/packed-runtime-exports.mjs";
import * as publicCore from "./index";
import * as admittedExecution from "./package-admitted-execution-internal";
import * as motionBehaviorValidation from "./motion-behavior-validation-internal";
import * as pairedPublication from "./paired-output-receipt-publication";

type Manifest = {
  name: string;
  exports: Record<string, unknown>;
  publishConfig: { exports: Record<string, unknown> };
};

function coreManifest(): Manifest {
  return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as Manifest;
}

function collectStringExportTargets(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectStringExportTargets);
  if (value && typeof value === "object") return Object.values(value).flatMap(collectStringExportTargets);
  return [];
}

describe("Core packed package exports", () => {
  it("publishes exactly the source entries required by the derived shipping-consumer contract", () => {
    const manifest = coreManifest();
    const contract = collectPackedRuntimeExportContract();
    const expected = contract.runtime
      .filter((entry) => entry.packageName === manifest.name)
      .map((entry) => entry.subpath)
      .sort();
    const privateEntries = contract.privateEntries
      .filter((entry) => entry.packageName === manifest.name)
      .map((entry) => entry.subpath);

    expect(Object.keys(manifest.publishConfig.exports).sort()).toEqual(expected);
    for (const subpath of privateEntries) {
      expect(manifest.publishConfig.exports).not.toHaveProperty(subpath);
    }
  });

  it("retains adopted Q1 value leaves as source-only internal Core subpaths", () => {
    const manifest = coreManifest();
    const contract = collectPackedRuntimeExportContract();
    const expectedSource = {
      "./internal/canonical-json": "./src/canonical-json.ts",
      "./internal/linear-srgb-sdr-final-math": "./src/linear-srgb-sdr-final-math.ts",
    };
    expect(Object.fromEntries(Object.keys(expectedSource).map((subpath) => [subpath, manifest.exports[subpath]]))).toEqual(expectedSource);
    for (const subpath of Object.keys(expectedSource)) expect(manifest.publishConfig.exports).not.toHaveProperty(subpath);
    const q1RuntimeEntries = contract.runtime.filter((entry) => entry.packageName === "@shellx-motion/core" && Object.hasOwn(expectedSource, entry.subpath));
    expect(q1RuntimeEntries).toEqual([]);
    const q1PrivateEntries = contract.privateEntries.filter((entry) => entry.packageName === "@shellx-motion/core" && Object.hasOwn(expectedSource, entry.subpath));
    expect(q1PrivateEntries.map(({ subpath, sourceTarget }) => ({ subpath, sourceTarget }))).toEqual([
      { subpath: "./internal/canonical-json", sourceTarget: "./src/canonical-json.ts" },
      { subpath: "./internal/linear-srgb-sdr-final-math", sourceTarget: "./src/linear-srgb-sdr-final-math.ts" },
    ]);
    expect(publicCore).toHaveProperty("canonicalJson"); // Existing root export; no Q1 value route is added to it.
    for (const symbol of ["composeLinearSrgbLayers", "linearSrgbGradientPosition", "sampleLinearSrgbGradient"]) {
      expect(publicCore).not.toHaveProperty(symbol);
    }
  });

  it("keeps internal authority out of Core's public barrel", () => {
    expect(publicCore).not.toHaveProperty("createTrustedWorkspaceAnchor");
    expect(publicCore).not.toHaveProperty("withTrustedWorkspaceAnchor");
    expect(publicCore).not.toHaveProperty("revalidateMotionRenderDeliverySources");
    expect(publicCore).not.toHaveProperty("compileGpuParametricTracePreviewStaticPlan");
    expect(publicCore).not.toHaveProperty("compileGpuParametricTracePreviewFramePlan");
    expect(publicCore).not.toHaveProperty("compileCheckpointStoryboardRetainedTracePreviewStaticPlan");
    expect(publicCore).not.toHaveProperty("compileCheckpointStoryboardRetainedTracePreviewFramePlan");
    expect(publicCore).not.toHaveProperty("readDataRecipeCheckpointDescriptor");
    expect(publicCore).not.toHaveProperty("compileDataRecipeCheckpoint");
    expect(publicCore).not.toHaveProperty("verifyPairedReceiptOutputIfMarked");
    expect(publicCore).not.toHaveProperty("verifyPairedReceiptOutput");
    expect(publicCore).not.toHaveProperty("PairedOutputReceiptPublication");
    expect(publicCore).not.toHaveProperty("PairedOutputReceiptDestinationError");
    expect(publicCore).not.toHaveProperty("PairedOutputReceiptCommitUncertainError");
    expect(publicCore).not.toHaveProperty("assertArtifactMediaMagic");
    expect(publicCore).not.toHaveProperty("isCoreDerivedOutputPublication");
    expect(publicCore).not.toHaveProperty("admittedPackageExecutionSnapshot");
    expect(publicCore).not.toHaveProperty("rememberAdmittedPackageExecutionSnapshot");
    expect(publicCore).not.toHaveProperty("validateMotionBehaviors");
    expect(admittedExecution).toHaveProperty("admittedPackageExecutionSnapshot");
    expect(admittedExecution).not.toHaveProperty("rememberAdmittedPackageExecutionSnapshot");
    expect(Object.keys(motionBehaviorValidation)).toEqual(["validateMotionBehaviors"]);
    expect(pairedPublication).toHaveProperty("PairedOutputReceiptPublication");
  });

  it("ships paired output publication only through the CLI-consumed internal subpath", () => {
    const manifest = coreManifest();
    const contract = collectPackedRuntimeExportContract();
    expect(manifest.exports["./internal/paired-output-receipt-publication"])
      .toBe("./src/paired-output-receipt-publication.ts");
    expect(manifest.publishConfig.exports["./internal/paired-output-receipt-publication"])
      .toEqual({ types: "./dist/paired-output-receipt-publication.d.ts", default: "./dist/paired-output-receipt-publication.js" });
    expect(contract.runtime).toContainEqual(expect.objectContaining({
      packageName: "@shellx-motion/core",
      specifier: "@shellx-motion/core/internal/paired-output-receipt-publication"
    }));
  });

  it("keeps private prototype directories outside source and packed export maps", () => {
    const manifest = coreManifest();
    const sourceExportTargets = collectStringExportTargets(manifest.exports);
    const packedExportTargets = collectStringExportTargets(manifest.publishConfig.exports);
    expect(sourceExportTargets).toEqual(expect.arrayContaining(["./src/index.ts"]));
    expect(sourceExportTargets.every((target) => !target.includes("/unadopted/") && !target.includes("/private/"))).toBe(true);
    expect(packedExportTargets.every((target) => !target.includes("/unadopted/") && !target.includes("/private/"))).toBe(true);
  });

  it("ships the lookup-only admitted-execution internal subpath with publishConfig parity", () => {
    const manifest = coreManifest();
    expect(manifest.exports["./internal/admitted-package-execution"])
      .toBe("./src/package-admitted-execution-internal.ts");
    expect(manifest.publishConfig.exports["./internal/admitted-package-execution"])
      .toEqual({ types: "./dist/package-admitted-execution-internal.d.ts", default: "./dist/package-admitted-execution-internal.js" });
  });

  it("ships behavior validation only through its narrow internal subpath with publishConfig parity", () => {
    const manifest = coreManifest();
    expect(manifest.exports["./internal/motion-behavior-validation"])
      .toBe("./src/motion-behavior-validation-internal.ts");
    expect(manifest.publishConfig.exports["./internal/motion-behavior-validation"])
      .toEqual({ types: "./dist/motion-behavior-validation-internal.d.ts", default: "./dist/motion-behavior-validation-internal.js" });
  });

  it("ships the retained-trace preview only through its closed internal subpath", () => {
    const manifest = coreManifest();
    expect(manifest.exports["./internal/checkpoint-storyboard-retained-trace-preview"])
      .toBe("./src/internal/checkpoint-storyboard/checkpoint-storyboard-retained-trace-preview.ts");
    expect(manifest.publishConfig.exports["./internal/checkpoint-storyboard-retained-trace-preview"])
      .toEqual({
        types: "./dist/internal/checkpoint-storyboard/checkpoint-storyboard-retained-trace-preview.d.ts",
        default: "./dist/internal/checkpoint-storyboard/checkpoint-storyboard-retained-trace-preview.js"
      });
  });

  it("ships the C6D-A data-recipe compiler only through its closed internal subpath", () => {
    const manifest = coreManifest();
    expect(manifest.exports["./internal/checkpoint-storyboard-data-recipe"])
      .toBe("./src/internal/checkpoint-storyboard/checkpoint-storyboard-data-recipe.ts");
    expect(manifest.publishConfig.exports["./internal/checkpoint-storyboard-data-recipe"])
      .toEqual({
        types: "./dist/internal/checkpoint-storyboard/checkpoint-storyboard-data-recipe.d.ts",
        default: "./dist/internal/checkpoint-storyboard/checkpoint-storyboard-data-recipe.js"
      });
  });

  it("keeps the unadopted deterministic frame/checkpoint manifest source-only", () => {
    const manifest = coreManifest();
    expect(manifest.exports["./internal/checkpoint-storyboard-frame-manifest"])
      .toBe("./src/internal/checkpoint-storyboard/checkpoint-storyboard-frame-manifest.ts");
    expect(manifest.publishConfig.exports).not.toHaveProperty("./internal/checkpoint-storyboard-frame-manifest");
  });

  it("has no source or installed V2 activation export", () => {
    const manifest = coreManifest();
    expect(manifest.exports).not.toHaveProperty("./internal/render-plan-v2-submission-authority");
    expect(manifest.publishConfig.exports).not.toHaveProperty("./internal/render-plan-v2-submission-authority");
    expect(manifest.exports).not.toHaveProperty("./internal/render-plan-v2-activation");
    expect(manifest.publishConfig.exports).not.toHaveProperty("./internal/render-plan-v2-activation");
    // Historical V2 parsing is intentionally public. Activation remains absent from both source
    // and packed exports until an accepted, nonserializable authority can span every checkpoint.
    expect(publicCore).toHaveProperty("MOTION_RENDER_PLAN_V2_SCHEMA");
    for (const symbol of [
      "mintMotionRenderPlanV2SubmissionAuthority",
      "createMotionRenderPlanV2SubmissionAuthority",
      "createMotionRenderPlanV2",
      "activateMotionRenderPlanV2",
      "bindMotionRenderPlanV2",
      "submitMotionRenderPlanV2",
    ]) expect(publicCore).not.toHaveProperty(symbol);
  });
});
