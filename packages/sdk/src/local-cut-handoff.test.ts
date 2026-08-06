import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { attachRenderedMediaToCutPlan, planCutImport } from "@shellx-motion/adapters-cut";
import { loadMotionPackage, type AttestedArtifactHandleReference } from "@shellx-motion/core";
import { verifySdkCutPlan } from "./local-cut-handoff.js";

describe("local SDK Cut handoff verification", () => {
  it("accepts only the exact operation and receipt bound to the artifact reference", async () => {
    const pkg = await loadMotionPackage(resolve("../../fixtures/packages/web-card"));
    const reference = artifactReference();
    const plan = attachRenderedMediaToCutPlan(planCutImport(pkg, {
      targetId: "shellx-cut",
      modes: ["rendered_media"],
      lowerableLayerTypes: [],
    }), { dryRun: false, handle: reference });

    expect(() => verifySdkCutPlan(plan, pkg, reference)).not.toThrow();

    const operationTamper = structuredClone(plan);
    if (operationTamper.operations[0]?.verb !== "cut.media.import_rendered") throw new Error("expected rendered operation");
    operationTamper.operations[0].durationMs += 1;
    expect(() => verifySdkCutPlan(operationTamper, pkg, reference)).toThrow("does not exactly match");

    const receiptTamper = structuredClone(plan);
    receiptTamper.receipt.inputHashes.artifactDescriptorSha256 = "9".repeat(64);
    expect(() => verifySdkCutPlan(receiptTamper, pkg, reference)).toThrow("does not exactly match");

    const idTamper = structuredClone(plan);
    idTamper.receipt.id = "cut-import-stale-base";
    expect(() => verifySdkCutPlan(idTamper, pkg, reference)).toThrow("does not exactly match");

    const lineageTamper = structuredClone(plan);
    const rendered = lineageTamper.operations[0];
    if (rendered.verb !== "cut.media.import_rendered" || !rendered.renderedMedia || rendered.renderedMedia.dryRun) {
      throw new Error("expected rendered artifact operation");
    }
    rendered.renderedMedia.handle.packageLineage!.motionSha256 = "8".repeat(64);
    expect(() => verifySdkCutPlan(lineageTamper, pkg, reference)).toThrow("does not exactly match");
  });
});

function artifactReference(): AttestedArtifactHandleReference {
  return {
    schema: "shellx-motion/artifact-handle-ref@1",
    id: "artifact-0123456789abcdef01234567",
    operationHash: "1".repeat(64),
    rootRelativePath: ".shellx-motion/artifacts/rendered.artifact.json",
    sha256: "2".repeat(64),
    packageLineage: {
      schema: "shellx-motion/package-render-lineage@1",
      manifestSha256: "3".repeat(64),
      motionSha256: "4".repeat(64),
    },
  };
}
