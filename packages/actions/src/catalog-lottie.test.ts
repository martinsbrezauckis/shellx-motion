import { describe, expect, it } from "vitest";
import { findAction, guideAction } from "./catalog.js";

describe("Lottie action discovery", () => {
  it("publishes the bounded Lottie and dotLottie import workflows", () => {
    expect(findAction("import Lottie")).toMatchObject({
      id: "motion.lottie.import", permission: "write_local", calls: ["motion.lottie.import"]
    });
    expect(findAction("import dotLottie")).toMatchObject({
      id: "motion.dotlottie.import", permission: "write_local", calls: ["motion.dotlottie.import"]
    });
  });

  it("guides imports with typed source/output arguments, host-root limits, receipts, and related imports", () => {
    const lottie = guideAction("motion.lottie.import");
    expect(lottie.steps).toEqual([expect.objectContaining({
      call: "motion.lottie.import",
      purpose: expect.stringContaining("host-approved Lottie JSON source")
    })]);
    expect(lottie.examples).toEqual([expect.objectContaining({
      call: "motion.lottie.import",
      args: { sourcePath: "<host-approved-lottie-json>", outDir: "<host-approved-empty-or-absent-package-output>" }
    })]);
    expect(lottie.cautions.join(" ")).toContain("host-approved authoring input and output roots");
    expect(lottie.verify.join(" ")).toContain("loweringReceiptPath and diagnosticsReceiptPath");
    expect(lottie.related.map((action) => action.id)).toEqual([
      "motion.dotlottie.import", "motion.scene3d.gltf.import", "motion.preview.frame"
    ]);

    const dotLottie = guideAction("motion.dotlottie.import");
    expect(dotLottie.examples[0]).toMatchObject({
      call: "motion.dotlottie.import",
      args: expect.objectContaining({ sourcePath: expect.any(String), outDir: expect.any(String), animationId: expect.any(String), themeId: expect.any(String) })
    });
    expect(dotLottie.cautions.join(" ")).toContain("State machines are preserved but never executed");
  });
});
