import { describe, expect, it } from "vitest";
import { buildMotionPublicSchema, MOTION_DOCUMENT_SCHEMA } from "./motion-public-schema";
import { validateAgainstPublishedSchema } from "./published-schema-check";

describe("source-owned text-runs@1 public schema", () => {
  it("closes run keys, bounds run count, and documents semantic text ownership xor", () => {
    const valid = textRuns();
    const value = valid.textRuns as { schema: string; runs: unknown[] };
    expect(errors(valid)).toEqual([]);
    expect(errors({ ...valid, textRuns: { ...value, runs: Array.from({ length: 33 }, () => ({ text: "x", fontAssetId: "brand" })) } })).not.toEqual([]);
    expect(errors({ ...valid, textRuns: { ...value, runs: [{ text: "x", fontAssetId: "brand", arbitrary: true }] } })).not.toEqual([]);
    const schema = buildMotionPublicSchema() as { $defs: { layer: { $comment: string }; textRuns: Record<string, unknown> } };
    expect(schema.$defs.textRuns).toMatchObject({ additionalProperties: false, required: ["schema", "runs"] });
    expect(schema.$defs.layer.$comment).toContain("validate.ts enforces text/textRuns");
  });
});

function textRuns(): Record<string, unknown> {
  return {
    id: "title", type: "text", startMs: 0, durationMs: 1_000,
    textRuns: { schema: "shellx-motion/text-runs@1", runs: [{ text: "Hello", fontAssetId: "brand", fontSizePx: 24 }] }
  };
}

function errors(layer: Record<string, unknown>) {
  return validateAgainstPublishedSchema(buildMotionPublicSchema(), {
    schema: MOTION_DOCUMENT_SCHEMA, id: "text_runs_schema", name: "Text runs", durationMs: 1_000, fps: 30, width: 100, height: 100,
    assets: [], provenance: {}, layers: [layer]
  });
}
