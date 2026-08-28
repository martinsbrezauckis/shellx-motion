import { describe, expect, it } from "vitest";
import { validateMotionDocumentGraphs } from "./motion-document-graphs";
import { validateMotionDocumentInStages } from "./motion-validation";
import { readMotionDocument } from "./package";
import { buildMotionPublicSchema } from "./motion-public-schema";
import { validateAgainstPublishedSchema } from "./published-schema-check";
import { loadSchemaSync, validateDocumentSync } from "./validate";

describe("public layoutGapAnimation@1 root admission", () => {
  it("rejects an accessor before sync, staged, published, package, or graph generic enumeration", async () => {
    const accessor = motionDocument();
    let reads = 0;
    Object.defineProperty(accessor, "layoutGapAnimation", {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error("layout gap root accessor must not run");
      },
    });

    const expected = [{ path: "/layoutGapAnimation", message: "must be an enumerable data property; accessors are not accepted" }];
    expect(validateDocumentSync(loadSchemaSync("motion"), accessor)).toEqual({ ok: false, errors: expected });
    await expect(validateMotionDocumentInStages(accessor)).resolves.toMatchObject({
      ok: false,
      stage: "structural",
      errors: expected,
    });
    expect(validateAgainstPublishedSchema(buildMotionPublicSchema(), accessor)).toEqual(expected);
    expect(() => readMotionDocument(accessor)).toThrow("accessors are not accepted");
    const graphErrors: Array<{ path: string; message: string }> = [];
    validateMotionDocumentGraphs(accessor, graphErrors);
    expect(graphErrors).toEqual(expected);
    expect(reads).toBe(0);
  });
});

function motionDocument(): Record<string, unknown> {
  return {
    schema: "shellx-motion/motion@1",
    id: "layout-gap-preflight",
    name: "Layout gap preflight",
    durationMs: 1_000,
    fps: 30,
    width: 100,
    height: 100,
    layers: [],
    assets: [],
    provenance: { sourceApp: "test", createdBy: "test" },
  };
}
