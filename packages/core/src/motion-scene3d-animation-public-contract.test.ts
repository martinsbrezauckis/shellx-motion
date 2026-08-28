import { describe, expect, it } from "vitest";
import { canonicalJson } from "./canonical-json";
import { buildMotionPublicSchema } from "./motion-public-schema";
import { MOTION_SCENE3D_ANIMATION_SCHEMA } from "./motion-scene3d-animation-types";
import { validateMotionDocumentInStages } from "./motion-validation";
import { readMotionDocument } from "./package";
import { validateAgainstPublishedSchema } from "./published-schema-check";
import { loadSchemaSync, validateDocumentSync } from "./validate";
import type { MotionDocument } from "./types";

describe("public scene3dAnimation@1 document contract", () => {
  it("publishes one optional bounded root and admits it through the shared descriptor authority", async () => {
    const document = sceneDocument();
    const schema = buildMotionPublicSchema() as { properties: Record<string, unknown>; $defs: Record<string, { properties?: Record<string, unknown> }> };
    expect(schema.properties.scene3dAnimation).toEqual({ $ref: "#/$defs/motionScene3dAnimation" });
    expect(schema.$defs.motionScene3dAnimation).toMatchObject({
      type: "object", required: ["schema", "tracks"],
      properties: { schema: { const: "shellx-motion/scene3d-animation@1" }, tracks: { minItems: 1, maxItems: 64 } },
    });
    expect(validateAgainstPublishedSchema(buildMotionPublicSchema(), document)).toEqual([]);
    await expect(validateMotionDocumentInStages(document)).resolves.toMatchObject({ ok: true });
  });

  it("binds every locator to existing scene3d authority and exact document microseconds", () => {
    const unknownLayer = sceneDocument();
    unknownLayer.scene3dAnimation!.tracks[0]!.locator.layerId = "missing" as never;
    expect(validateDocumentSync(loadSchemaSync("motion"), unknownLayer)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.objectContaining({ path: "/scene3dAnimation", message: expect.stringContaining("unknown scene layer") })]),
    });

    const afterDocument = sceneDocument();
    afterDocument.scene3dAnimation!.tracks[0]!.keyframes[0]!.atUs = 1_000_001;
    expect(validateDocumentSync(loadSchemaSync("motion"), afterDocument)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.objectContaining({ path: "/scene3dAnimation/tracks/0/keyframes/0/atUs", message: expect.stringContaining("document duration") })]),
    });
  });

  it("keeps continuous combined-camera validity as exact frame-time evidence, not admission proof", async () => {
    const document = sceneDocument();
    document.scene3dAnimation!.tracks = [{
      id: "camera-position", locator: { layerId: "world", scope: "camera", property: "position" },
      keyframes: [{ atUs: 500_000, value: [0, 0, 0] }],
    }];
    await expect(validateMotionDocumentInStages(document)).resolves.toMatchObject({ ok: true });
  });

  it("canonically reopens a package document payload with the same public descriptor rather than a second scene graph", () => {
    const document = sceneDocument();
    document.scene3dAnimation!.tracks = [{
      id: "background", locator: { layerId: "world", scope: "background", property: "color" },
      keyframes: [{ atUs: 500_000, value: "#AABBCC" }],
    }];
    const first = readMotionDocument(JSON.parse(JSON.stringify(document)));
    const reopened = readMotionDocument(JSON.parse(JSON.stringify(first)));
    expect(first.scene3dAnimation).toMatchObject({ schema: MOTION_SCENE3D_ANIMATION_SCHEMA, tracks: [{ keyframes: [{ value: "#aabbcc" }] }] });
    expect(canonicalJson(reopened)).toBe(canonicalJson(first));
  });

  it("rejects accessor and reflection-backed roots before generic document enumeration", async () => {
    const accessor = sceneDocument(); let reads = 0;
    Object.defineProperty(accessor, "scene3dAnimation", { enumerable: true, get() { reads += 1; return sceneDocument().scene3dAnimation; } });
    expect(() => readMotionDocument(accessor)).toThrow("accessors are not accepted");
    expect(validateDocumentSync(loadSchemaSync("motion"), accessor)).toEqual({ ok: false, errors: [{ path: "/scene3dAnimation", message: "must be an enumerable data property; accessors are not accepted" }] });
    await expect(validateMotionDocumentInStages(accessor)).resolves.toMatchObject({ ok: false, stage: "structural", errors: [{ path: "/scene3dAnimation", message: "must be an enumerable data property; accessors are not accepted" }] });
    expect(validateAgainstPublishedSchema(buildMotionPublicSchema(), accessor)).toEqual([{ path: "/scene3dAnimation", message: "must be an enumerable data property; accessors are not accepted" }]);
    expect(reads).toBe(0);

    const reflected = new Proxy(sceneDocument(), { getOwnPropertyDescriptor(target, key) { if (key === "scene3dAnimation") throw new Error("reflection blocked"); return Reflect.getOwnPropertyDescriptor(target, key); } });
    expect(() => readMotionDocument(reflected)).toThrow("descriptor reflection failed");
    expect(validateDocumentSync(loadSchemaSync("motion"), reflected)).toEqual({ ok: false, errors: [{ path: "/scene3dAnimation", message: "descriptor reflection failed" }] });
    await expect(validateMotionDocumentInStages(reflected)).resolves.toMatchObject({ ok: false, stage: "structural", errors: [{ path: "/scene3dAnimation", message: "descriptor reflection failed" }] });
    expect(validateAgainstPublishedSchema(buildMotionPublicSchema(), reflected)).toEqual([{ path: "/scene3dAnimation", message: "descriptor reflection failed" }]);
  });
});

function sceneDocument(): MotionDocument {
  return {
    schema: "shellx-motion/motion@1", id: "scene3d-animation", name: "Scene3d animation", durationMs: 1_000, fps: 30, width: 100, height: 50,
    assets: [], provenance: { sourceApp: "test", createdBy: "test" },
    layers: [{
      id: "world", type: "scene3d", startMs: 0, durationMs: 1_000,
      scene3d: {
        schema: "shellx-motion/scene3d@1",
        camera: { position: [0, 2, 6], target: [0, 0, 0], fovDeg: 45, near: 0.1, far: 100 },
        lighting: { ambient: 0.25, direction: [0, -1, -1], intensity: 1, color: "#ffffff" },
        backgroundColor: "#101820",
        objects: [{ id: "beacon", primitive: "box", position: [0, 0, 0], rotationDeg: [0, 0, 0], scale: 1, color: "#00aaff", emissive: 0.1 }],
      },
    }],
    scene3dAnimation: {
      schema: MOTION_SCENE3D_ANIMATION_SCHEMA,
      tracks: [{
        id: "camera-fov", locator: { layerId: "world", scope: "camera", property: "fovDeg" },
        keyframes: [{ atUs: 500_000, value: 50, easing: "ease-in" }],
      }],
    },
  };
}
