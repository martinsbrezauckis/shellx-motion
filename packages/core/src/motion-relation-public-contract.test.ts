import { describe, expect, it } from "vitest";
import { buildMotionPublicSchema } from "./motion-public-schema";
import { validateMotionDocumentInStages } from "./motion-validation";
import { validateDocumentSync, loadSchemaSync } from "./validate";
import { validateAgainstPublishedSchema } from "./published-schema-check";
import type { MotionDocument } from "./types";

describe("public relations@1 document contract", () => {
  it("admits active and disabled relation stores through the source-owned schema and semantic validator", async () => {
    for (const enabled of [true, false]) {
      const document = relationDocument(enabled);
      expect(validateAgainstPublishedSchema(buildMotionPublicSchema(), document)).toEqual([]);
      await expect(validateMotionDocumentInStages(document)).resolves.toMatchObject({ ok: true });
    }
  });

  it("publishes the exact bounded store structure from the source schema builder", () => {
    const schema = buildMotionPublicSchema() as { properties: Record<string, unknown>; $defs: Record<string, { properties?: Record<string, unknown>; oneOf?: Array<{ properties: Record<string, unknown> }> }> };
    expect(schema.properties.relations).toEqual({ $ref: "#/$defs/motionRelations" });
    expect(schema.$defs.motionRelations).toMatchObject({
      type: "object",
      required: ["schema", "bindings"],
      properties: { schema: { const: "shellx-motion/relations@1" }, bindings: { minItems: 1, maxItems: 32 } },
    });
    const attach = schema.$defs.motionRelation?.oneOf?.[0];
    expect(attach?.properties.startUs).toEqual({ type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
    expect(attach?.properties.durationUs).toEqual({ type: "integer", minimum: 1, maximum: 3_600_000_000 });
    expect(attach?.properties.mode).toEqual({ enum: ["follow", "similarity"] });
  });

  it("rejects malformed stores without throwing and retains semantic authority checks", () => {
    const malformed = relationDocument(false) as unknown as Record<string, unknown>;
    malformed.relations = { schema: "shellx-motion/relations@1", bindings: [] };
    expect(validateAgainstPublishedSchema(buildMotionPublicSchema(), malformed)).not.toEqual([]);
    expect(validateDocumentSync(loadSchemaSync("motion"), malformed)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.objectContaining({ path: "/relations" })]),
    });

    const conflicting = relationDocument(false);
    conflicting.layers[1]!.keyframes = { "transform.x": [{ atMs: 0, value: 0 }] };
    expect(validateDocumentSync(loadSchemaSync("motion"), conflicting)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.objectContaining({ path: "/relations/bindings/0" })]),
    });
  });
});

function relationDocument(enabled: boolean): MotionDocument {
  return {
    schema: "shellx-motion/motion@1", id: "relation-contract", name: "Relation contract", durationMs: 1_000, fps: 30, width: 100, height: 50,
    assets: [], provenance: { sourceApp: "test", createdBy: "test" },
    layers: [
      { id: "leader", type: "shape", shape: "rect", startMs: 0, durationMs: 1_000, transform: { x: 10, y: 10, width: 10, height: 10 } },
      { id: "follower", type: "shape", shape: "rect", startMs: 0, durationMs: 1_000, transform: { x: 30, y: 10, width: 10, height: 10 } },
    ],
    relations: {
      schema: "shellx-motion/relations@1",
      bindings: [{
        id: "follow", enabled, kind: "attach", mode: "follow", startUs: 0, durationUs: 1_000_000,
        source: { layerId: "leader", anchor: { x: 0, y: 0 } },
        target: { layerId: "follower", anchor: { x: 0, y: 0 } },
        offset: { space: "source", x: 0, y: 0, rotationDeg: 0, scale: 1 },
      }],
    },
  };
}
