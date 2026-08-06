import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSchema, validateDocument } from "./validate";
import { validateAgainstPublishedSchema, type JsonSchemaDocument } from "./published-schema-check";
import { NAMED_EASINGS_LIST } from "./timeline";

/**
 * Engine-review A4: the published schemas/motion.schema.json validated `layers` as a bare array and
 * `provenance` as a bare object while the real contract lived in the hand-written validator
 * (validate.ts). This suite pins the published schema to that validator (verify direction — no JSON
 * Schema evaluator dependency is added): the published schema must not accept documents validate.ts
 * rejects at the structural level, its required lists and easing enum are pinned to the validator's
 * constants, and real fixtures must not be false-rejected.
 */
const publishedSchema = JSON.parse(
  readFileSync(resolve("../../schemas/motion.schema.json"), "utf8")
) as JsonSchemaDocument & { required: string[]; $defs: Record<string, any> };

const baseMotion = {
  schema: "shellx-motion/motion@1",
  id: "p",
  name: "P",
  durationMs: 1000,
  fps: 30,
  width: 100,
  height: 100,
  layers: [] as unknown[],
  assets: [] as unknown[],
  provenance: {}
};

function schemaAccepts(doc: unknown): boolean {
  return validateAgainstPublishedSchema(publishedSchema, doc).length === 0;
}

async function validatorAccepts(doc: unknown): Promise<boolean> {
  return (await validateDocument(await loadSchema("motion"), doc)).ok;
}

describe("published motion schema contract", () => {
  it("agrees with validate.ts on document-level structural accept/reject", async () => {
    const cases: Array<{ label: string; doc: unknown }> = [
      { label: "valid empty document", doc: baseMotion },
      { label: "valid text layer", doc: { ...baseMotion, layers: [{ id: "l", type: "text", startMs: 0, durationMs: 100 }] } },
      { label: "layers contains a non-object", doc: { ...baseMotion, layers: [42] } },
      { label: "layer missing durationMs", doc: { ...baseMotion, layers: [{ id: "l", type: "text", startMs: 0 }] } },
      { label: "layer missing id", doc: { ...baseMotion, layers: [{ type: "text", startMs: 0, durationMs: 100 }] } },
      { label: "layer negative startMs", doc: { ...baseMotion, layers: [{ id: "l", type: "text", startMs: -5, durationMs: 100 }] } },
      { label: "missing composition field fps", doc: (() => { const c: any = { ...baseMotion }; delete c.fps; return c; })() },
      { label: "provenance is not an object", doc: { ...baseMotion, provenance: [] } }
    ];
    for (const { label, doc } of cases) {
      // eslint-disable-next-line no-await-in-loop
      const validator = await validatorAccepts(doc);
      expect(schemaAccepts(doc), `${label}: schema accept=${schemaAccepts(doc)} vs validator accept=${validator}`).toBe(validator);
    }
  });

  it("rejects the exact structural gaps A4 flagged (previously accepted by the bare-array schema)", () => {
    expect(schemaAccepts({ ...baseMotion, layers: [42] })).toBe(false);
    expect(schemaAccepts({ ...baseMotion, layers: [{ id: "l", type: "text", startMs: 0 }] })).toBe(false);
    expect(schemaAccepts({ ...baseMotion, provenance: [] })).toBe(false);
  });

  it("does not false-reject shipped motion fixtures", () => {
    for (const fixture of ["lower-third", "keyframed-lower-third"]) {
      const doc = JSON.parse(readFileSync(resolve(`../../fixtures/packages/${fixture}/motion.json`), "utf8"));
      expect(validateAgainstPublishedSchema(publishedSchema, doc)).toEqual([]);
    }
  });

  it("pins the schema's required lists and easing enum to the validator's constants", async () => {
    // Top-level required is pinned to the validator's own SCHEMAS.motion.required (loadSchema).
    expect(publishedSchema.required).toEqual((await loadSchema("motion")).required);
    // Layer-level required mirrors validateMotionLayers.
    expect(publishedSchema.$defs.layer.required).toEqual(["id", "type", "startMs", "durationMs"]);
    // Easing named enum is pinned to the validator's NAMED_EASINGS set.
    expect(publishedSchema.$defs.easing.anyOf[0].enum).toEqual([...NAMED_EASINGS_LIST]);
  });
});
