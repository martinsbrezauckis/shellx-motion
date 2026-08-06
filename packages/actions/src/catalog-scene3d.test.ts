import { describe, expect, it } from "vitest";
import { findAction, planAction } from "./catalog.js";

describe("scene3d agent action", () => {
  it("routes glTF, Canvas, and Cut requests through import and visible render proof", () => {
    expect(findAction("import this glb model and render it in canvas")).toMatchObject({
      id: "motion.scene3d.gltf.import",
      permission: "write_local",
      mutates: true,
      calls: expect.arrayContaining([
        "motion.scene3d.gltf.import",
        "motion.preview.frame",
        "motion.receipts.read",
      ]),
      surfaces: expect.arrayContaining(["canvas", "cut", "scene3d"]),
    });
    expect(planAction("send this gltf render to cut").steps.map((step) => step.call)).toEqual([
      "motion.scene3d.gltf.import",
      "motion.capabilities.match",
      "motion.preview.frame",
      "motion.receipts.read",
    ]);
  });
});
