import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildMotionPublicSchema,
  MOTION_DOCUMENT_REQUIRED,
  MOTION_DOCUMENT_SCHEMA
} from "./motion-public-schema";
import {
  MOTION_VALIDATION_CONTRACT,
  MOTION_VALIDATION_STAGE_ORDER,
  motionValidationSchemaComment,
  renderMotionValidationGuide,
} from "./motion-validation-contract";
import { validateMotionDocumentInStages } from "./motion-validation";
import { validateAgainstPublishedSchema, type JsonSchemaDocument } from "./published-schema-check";
import { MOTION_EFFECT_MODULE_VERSION_MAX_LENGTH, MOTION_EFFECT_MODULE_VERSION_SCHEMA_PATTERN } from "./effect-module";
import { loadSchema, validateDocument } from "./validate";

/**
 * Differential corpus for the published Motion document schema.
 *
 * The generated JSON Schema intentionally covers portable structural rules while
 * `validate.ts` remains the authority for reference integrity, ordering, budget,
 * and renderer-semantic checks. This suite makes that boundary executable: every
 * shipped valid document must be accepted by both, while representative static
 * failures from the runtime validator must be refused by the public schema too.
 */
const publishedSchema = JSON.parse(
  readFileSync(resolve("../../schemas/motion.schema.json"), "utf8")
) as JsonSchemaDocument & { required: string[]; $defs: Record<string, unknown> };

const baseMotion = {
  schema: MOTION_DOCUMENT_SCHEMA,
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

function schemaErrors(doc: unknown): Array<{ path: string; message: string }> {
  return validateAgainstPublishedSchema(publishedSchema, doc);
}

async function runtimeErrors(doc: unknown): Promise<Array<{ path: string; message: string }>> {
  const result = await validateDocument(await loadSchema("motion"), doc);
  return result.ok ? [] : result.errors;
}

function shippedMotionFixturePaths(directory = resolve("../../fixtures")): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return shippedMotionFixturePaths(path);
      return entry.isFile() && entry.name === "motion.json" ? [path] : [];
    })
    .sort();
}

describe("generated published motion schema contract", () => {
  it("uses Core's bounded canonical effect-module SemVer check and skips pattern work once over bound", () => {
    const effectModule = (version: string) => ({
      ...baseMotion,
      layers: [{
        id: "afterimage",
        type: "adjustment",
        startMs: 0,
        durationMs: 100,
        effectModule: {
          schema: "shellx-motion/effect-module-ref@1",
          moduleId: "motion.afterimage-stack",
          version,
          parameters: { echoes: [{ dxPx: 0, dyPx: 0, color: "#FFFFFFFF", opacityQ16: 0 }], amountQ16: 0 }
        }
      }]
    });
    const versionSchema = (publishedSchema.$defs.effectModule as { properties: { version: Record<string, unknown> } }).properties.version;
    expect(versionSchema).toMatchObject({ maxLength: MOTION_EFFECT_MODULE_VERSION_MAX_LENGTH, pattern: MOTION_EFFECT_MODULE_VERSION_SCHEMA_PATTERN });
    const externalPattern = new RegExp(String(versionSchema.pattern));
    const accepted = ["0.0.0", "1.2.3", "1.2.3-rc.1", "1.2.3-0", "1.2.3-alpha-01"];
    const rejected = ["v1.2.3", "1.2.3+build", "latest", "01.2.3", "1.02.3", "1.2.03", "1.2.3-01", "1.2.3-00", "1.2.3-rc.01"];
    for (const version of accepted) {
      expect(externalPattern.test(version), `${version}: exported JSON Schema pattern`).toBe(true);
      expect(schemaErrors(effectModule(version)), version).toEqual([]);
    }
    for (const version of rejected) {
      expect(externalPattern.test(version), `${version}: exported JSON Schema pattern`).toBe(false);
      expect(schemaErrors(effectModule(version)), version).toContainEqual({ path: "/layers/0/effectModule/version", message: `must match pattern ${MOTION_EFFECT_MODULE_VERSION_SCHEMA_PATTERN}` });
    }
    const overBound = `1.2.3-${"a".repeat(MOTION_EFFECT_MODULE_VERSION_MAX_LENGTH)}`;
    expect(schemaErrors(effectModule(overBound))).toEqual([{ path: "/layers/0/effectModule/version", message: `must contain at most ${MOTION_EFFECT_MODULE_VERSION_MAX_LENGTH} character(s)` }]);
  });

  it("publishes the code-owned two-stage vocabulary and ordering", () => {
    expect(MOTION_VALIDATION_CONTRACT).toBe("shellx-motion/motion-validation@1");
    expect(MOTION_VALIDATION_STAGE_ORDER).toEqual(["structural", "semantic"]);
    expect(publishedSchema.$comment).toContain(motionValidationSchemaComment());
    const guide = renderMotionValidationGuide();
    expect(guide).toContain(MOTION_VALIDATION_CONTRACT);
    expect(guide.indexOf("**structural**")).toBeLessThan(guide.indexOf("**semantic**"));
    expect(guide).toContain("not** proof that a package is renderable");
  });

  it("fails closed when stage-one encounters a future JSON Schema keyword", async () => {
    const futureSchema = { ...buildMotionPublicSchema(), unevaluatedProperties: false };
    await expect(validateMotionDocumentInStages(baseMotion, futureSchema))
      .rejects.toThrow("Unsupported JSON Schema keyword 'unevaluatedProperties'");
  });

  it("is emitted byte-for-byte from the canonical document-contract source", () => {
    expect(publishedSchema).toEqual(buildMotionPublicSchema());
    expect(publishedSchema.$id).toBe(MOTION_DOCUMENT_SCHEMA);
    expect(publishedSchema.required).toEqual([...MOTION_DOCUMENT_REQUIRED]);
  });

  it("accepts every valid shipped Motion fixture in both the runtime and public schema", async () => {
    const paths = shippedMotionFixturePaths();
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      const document = JSON.parse(readFileSync(path, "utf8"));
      // eslint-disable-next-line no-await-in-loop
      const runtime = await runtimeErrors(document);
      const schema = schemaErrors(document);
      expect(runtime, `${path} must be accepted by validate.ts`).toEqual([]);
      expect(schema, `${path} must be accepted by the published schema`).toEqual([]);
    }
  });

  it("refuses representative runtime structural failures in the public schema too", async () => {
    const rainWithoutGround = {
      schema: "shellx-motion/environment@1",
      kind: "rain",
      seed: 1,
      quality: "preview",
      mode: "scene",
      intensity: 0.5,
      wind: 0,
      dropSpeed: 1,
      dropLength: 1,
      depthLayers: 1,
      color: "#ffffff",
      backgroundColor: "#000000",
      lightColor: "#ffffff",
      accentColor: "#ffffff",
      atmosphere: { mist: 0.2, lensDroplets: 0.2 }
    };
    const cases: Array<{ label: string; document: unknown }> = [
      {
        label: "missing required document field",
        document: (() => {
          const document: Record<string, unknown> = { ...baseMotion };
          delete document.fps;
          return document;
        })()
      },
      { label: "layer is not an object", document: { ...baseMotion, layers: [42] } },
      { label: "layer misses duration", document: { ...baseMotion, layers: [{ id: "l", type: "text", startMs: 0 }] } },
      { label: "keyframe misses value", document: { ...baseMotion, layers: [{ id: "l", type: "text", startMs: 0, durationMs: 100, keyframes: { opacity: [{ atMs: 0 }] } }] } },
      { label: "crop is on a text layer", document: { ...baseMotion, layers: [{ id: "l", type: "text", startMs: 0, durationMs: 100, crop: { x: 0, y: 0, width: 10, height: 10 } }] } },
      { label: "safe text-fit misses safe-area id", document: { ...baseMotion, layers: [{ id: "l", type: "text", startMs: 0, durationMs: 100, textFit: { policy: "safe" } }] } },
      { label: "unsupported transition", document: { ...baseMotion, layers: [{ id: "l", type: "text", startMs: 0, durationMs: 100, transitions: { in: { type: "spin", durationMs: 100 } } }] } },
      { label: "particle layer misses emitter", document: { ...baseMotion, layers: [{ id: "l", type: "particles", startMs: 0, durationMs: 100 }] } },
      { label: "shader layer misses shader", document: { ...baseMotion, layers: [{ id: "l", type: "shader", startMs: 0, durationMs: 100 }] } },
      { label: "shader asset has an unsupported MIME type", document: { ...baseMotion, assets: [{ type: "shader", id: "shader", source: { path: "shader.glsl", mimeType: "text/plain" } }] } },
      { label: "environment layer misses its rain ground", document: { ...baseMotion, layers: [{ id: "l", type: "environment", startMs: 0, durationMs: 100, environment: rainWithoutGround }] } },
      { label: "glow exceeds runtime maximum", document: { ...baseMotion, layers: [{ id: "l", type: "shape", startMs: 0, durationMs: 100, effects: { glow: { radius: 129, color: "#ffffff" } } }] } }
    ];

    for (const { label, document } of cases) {
      // eslint-disable-next-line no-await-in-loop
      expect(await runtimeErrors(document), `${label}: validate.ts must refuse it`).not.toEqual([]);
      expect(schemaErrors(document), `${label}: public schema must refuse it`).not.toEqual([]);
    }
  });

  it("publishes bounded scene3d mesh source identity", () => {
    const source = {
      format: "gltf",
      meshIndex: 0,
      primitiveIndex: 0,
      geometrySha256: "a".repeat(64)
    };
    const document = {
      ...baseMotion,
      layers: [{
        id: "mesh",
        type: "scene3d",
        startMs: 0,
        durationMs: 100,
        scene3d: { objects: [{ primitive: "mesh", source }] }
      }]
    };

    expect(schemaErrors(document)).toEqual([]);

    const missingHash = structuredClone(document);
    delete (missingHash.layers[0] as { scene3d: { objects: Array<{ source: { geometrySha256?: string } }> } }).scene3d.objects[0].source.geometrySha256;
    expect(schemaErrors(missingHash)).toContainEqual({ path: "/layers/0/scene3d/objects/0/source/geometrySha256", message: "required" });

    const upperCaseHash = structuredClone(document);
    upperCaseHash.layers[0].scene3d.objects[0].source.geometrySha256 = "A".repeat(64);
    expect(schemaErrors(upperCaseHash)).toContainEqual({ path: "/layers/0/scene3d/objects/0/source/geometrySha256", message: "must match pattern ^[a-f0-9]{64}$" });
  });

  it("keeps host layer types and x-* nested extension namespaces open", async () => {
    const extensionDocument = {
      ...baseMotion,
      "x-host-document": { revision: 1 },
      layers: [{
        id: "host-layer",
        type: "host-custom-layer",
        startMs: 0,
        durationMs: 100,
        "x-host-layer": { opaque: true },
        transform: { "x-host-transform": "opaque" }
      }]
    };
    expect(await runtimeErrors(extensionDocument)).toEqual([]);
    expect(schemaErrors(extensionDocument)).toEqual([]);
  });

  it("leaves graph, cross-reference, and budget invariants to semantic stage two", async () => {
    const graphFailure = {
      ...baseMotion,
      compositing: { schema: "shellx-motion/compositing-graph@1", id: "graph", nodes: [], edges: [] },
    };
    const crossReferenceFailure = {
      ...baseMotion,
      layers: [{
        id: "title",
        type: "text",
        startMs: 0,
        durationMs: 100,
        textFit: { policy: "safe", safeAreaId: "missing" },
      }],
    };
    const budgetFailure = {
      ...baseMotion,
      layers: Array.from({ length: 9 }, (_, index) => ({
        id: `blur-${index}`,
        type: "shape",
        startMs: 0,
        durationMs: 100,
        effects: { motionBlur: { samples: 8, shutterAngle: 180 } },
      })),
    };

    for (const [label, document] of Object.entries({ graphFailure, crossReferenceFailure, budgetFailure })) {
      expect(schemaErrors(document), `${label}: structural JSON Schema remains intentionally portable`).toEqual([]);
      // eslint-disable-next-line no-await-in-loop
      await expect(validateMotionDocumentInStages(document), `${label}: runtime semantics must run after structural validation`)
        .resolves.toMatchObject({
          ok: false,
          stage: "semantic",
          report: {
            contract: MOTION_VALIDATION_CONTRACT,
            structural: "passed",
            semantic: "failed",
            renderability: "not_proven",
          },
        });
    }
  });
});
