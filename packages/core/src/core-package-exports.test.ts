import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { collectPackedRuntimeExportContract } from "../../../scripts/packed-runtime-exports.mjs";
import * as publicCore from "./index";
import * as admittedExecution from "./package-admitted-execution-internal";
import * as motionBehaviorValidation from "./motion-behavior-validation-internal";

type Manifest = {
  name: string;
  exports: Record<string, unknown>;
  publishConfig: { exports: Record<string, unknown> };
};

function coreManifest(): Manifest {
  return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as Manifest;
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
    expect(publicCore).not.toHaveProperty("isCoreDerivedOutputPublication");
    expect(publicCore).not.toHaveProperty("admittedPackageExecutionSnapshot");
    expect(publicCore).not.toHaveProperty("rememberAdmittedPackageExecutionSnapshot");
    expect(publicCore).not.toHaveProperty("validateMotionBehaviors");
    expect(admittedExecution).toHaveProperty("admittedPackageExecutionSnapshot");
    expect(admittedExecution).not.toHaveProperty("rememberAdmittedPackageExecutionSnapshot");
    expect(Object.keys(motionBehaviorValidation)).toEqual(["validateMotionBehaviors"]);
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
    expect(manifest.publishConfig.exports).not.toHaveProperty("./internal/render-delivery-source");
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
});
