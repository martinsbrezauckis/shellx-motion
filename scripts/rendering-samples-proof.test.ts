import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { renderingSamplesProofPlan, succeededMotionReceiptOperations } from "./rendering-samples-proof";
import { renderingSamplesProofRoot, renderingSamplesProofRootEnvironment } from "./rendering-samples-proof-root";

const repository = resolve(import.meta.dirname, "..");

describe("rendering-samples proof plan", () => {
  it("covers every declared workflow with an explicit bounded output contract", async () => {
    const catalog = JSON.parse(await readFile(join(repository, "docs/public/rendering-sample-catalog.json"), "utf8")) as Record<string, unknown>;
    const plan = renderingSamplesProofPlan(catalog);
    expect(plan).toHaveLength(8);
    expect(plan.map((binding) => binding.familyId)).toEqual([
      "family.keying-and-roto@1",
      "family.tracking-and-stabilization@1",
      "family.fixed-scene3d-and-gltf@1",
      "family.cutout-rig-bake@1",
      "family.audio-delivery@1",
      "family.caption-import-and-delivery@1",
      "family.html-css-and-canvas@1",
      "family.html-css-and-canvas@1"
    ]);
    expect(plan.flatMap((binding) => binding.proofOutputs).every((output) => !output.path.includes(".."))).toBe(true);
    expect(plan.filter((binding) => binding.kind === "cli-import").every((binding) => binding.proofOutputs[0]?.mediaType === "application/vnd.shellx.motion.package")).toBe(true);
  });

  it("refuses missing or traversal proof-output declarations before command execution", () => {
    expect(() => renderingSamplesProofPlan({ familyWorkflowBindings: [{
      familyId: "family.test@1",
      title: "unsafe",
      kind: "package-script",
      packageScript: "test",
      receiptOperations: ["test"],
      proofOutputs: [{ path: "../outside", kind: "file", mediaType: "application/json" }]
    }] })).toThrow("proof output path must be unique and safely relative");
  });

  it("counts only succeeded shellx-motion receipts, never incidental operation fields", () => {
    expect(succeededMotionReceiptOperations([{
      operation: "incidental.operation",
      nested: [
        { schema: "shellx-motion/receipt@1", status: "failed", operation: "failed.operation" },
        { schema: "shellx-motion/receipt@1", status: "warning", operation: "warned.operation" },
        { schema: "other/receipt@1", status: "passed", operation: "foreign.operation" },
        { schema: "shellx-motion/receipt@1", status: "passed", operation: "passed.operation" }
      ]
    }])).toEqual(["warned.operation", "passed.operation"]);
  });

  it("admits a workflow override only below the proof-owned scratch root", () => {
    const previous = process.env[renderingSamplesProofRootEnvironment];
    try {
      const safeRoot = resolve(repository, ".scratch", "rendering-samples-proof", "run-test", "binding");
      process.env[renderingSamplesProofRootEnvironment] = safeRoot;
      expect(renderingSamplesProofRoot(".scratch/default-smoke")).toBe(safeRoot);

      process.env[renderingSamplesProofRootEnvironment] = resolve(repository, ".scratch", "outside-proof-root");
      expect(() => renderingSamplesProofRoot(".scratch/default-smoke")).toThrow("must name a child");
    } finally {
      if (previous === undefined) delete process.env[renderingSamplesProofRootEnvironment];
      else process.env[renderingSamplesProofRootEnvironment] = previous;
    }
  });
});
