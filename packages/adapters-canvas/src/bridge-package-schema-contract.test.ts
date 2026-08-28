import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  integrationCapabilitiesForHost,
  validateAgainstPublishedSchema,
  type JsonSchemaDocument
} from "@shellx-motion/core";
import {
  CANVAS_BRIDGE_PACKAGE_SCHEMA,
  convertCanvasFrameToMotionPackage,
  writeCanvasMotionPackage
} from "./index";

/**
 * The capability handshake advertised canvas-bridge-package@1 before a producer emitted it or a
 * JSON Schema existed. This is deliberately an end-to-end contract test: the existing
 * Canvas fixtures feed the real producer, the composed published schema validates the result,
 * and the package writer consumes that same result.
 */
const schemasDir = resolve("../../schemas");
const fixturesDir = resolve("../../fixtures/canvas");
const packageSchemaPath = resolve(schemasDir, "canvas-bridge-package.schema.json");
const tempDirs: string[] = [];
const itLinux = process.platform === "linux" ? it : it.skip;

function loadSchema(name: string): JsonSchemaDocument {
  return JSON.parse(readFileSync(resolve(schemasDir, name), "utf8")) as JsonSchemaDocument;
}

function resolveSchemaReference(ref: string): JsonSchemaDocument | undefined {
  if (!["package-manifest.schema.json", "motion.schema.json", "receipt.schema.json"].includes(ref)) {
    return undefined;
  }
  return loadSchema(ref);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function schemaErrors(value: unknown): Array<{ path: string; message: string }> {
  return validateAgainstPublishedSchema(loadSchema("canvas-bridge-package.schema.json"), value, resolveSchemaReference);
}

describe("Canvas bridge package published schema contract", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("matches the advertised integration capability on both bridge hosts", () => {
    const schema = loadSchema("canvas-bridge-package.schema.json");
    expect(schema.$id).toBe(CANVAS_BRIDGE_PACKAGE_SCHEMA);
    for (const host of ["shellx-motion", "shellx-canvas"] as const) {
      expect(integrationCapabilitiesForHost(host).schemas.canvas).toContain(CANVAS_BRIDGE_PACKAGE_SCHEMA);
    }
  });

  itLinux("keeps every shipped Canvas fixture valid from producer through schema to package writer", async () => {
    const fixtureNames = readdirSync(fixturesDir).filter((name) => name.endsWith(".json")).sort();
    expect(fixtureNames.length).toBeGreaterThan(0);

    for (const name of fixtureNames) {
      const canvasPackage = convertCanvasFrameToMotionPackage(readJson(resolve(fixturesDir, name)), {
        createdAt: "2026-08-08T00:00:00.000Z",
        inputPath: `fixtures/canvas/${name}`
      });
      expect(canvasPackage.schema, `${name}: producer must emit the advertised id`).toBe(CANVAS_BRIDGE_PACKAGE_SCHEMA);
      expect(schemaErrors(canvasPackage), `${name}: published schema must accept producer output`).toEqual([]);

      const packageDir = await mkdtemp(join(process.cwd(), ".tmp-shellx-motion-canvas-bridge-package-"));
      tempDirs.push(packageDir);
      // Schema production remains valid without reading a source asset. Publication does not:
      // every declared asset needs an explicit host-approved root and immutable copied bytes.
      if (canvasPackage.manifest.assets.length > 0) {
        await expect(writeCanvasMotionPackage(canvasPackage, { packageDir }))
          .rejects.toThrow("Canvas package assets require an explicit host-approved sourceRoot.");
      } else {
        const written = await writeCanvasMotionPackage(canvasPackage, { packageDir });
        expect(readJson(written.manifestPath)).toEqual(canvasPackage.manifest);
        expect(readJson(written.motionPath)).toEqual(canvasPackage.motion);
        expect(readJson(written.receiptPath)).toMatchObject({ ...canvasPackage.receipt, artifacts: expect.any(Array) });
      }
    }
  });

  it("rejects wrong or incomplete canonical envelopes", async () => {
    const canvasPackage = convertCanvasFrameToMotionPackage(readJson(resolve(fixturesDir, "frame-selection.json")), {
      createdAt: "2026-08-08T00:00:00.000Z"
    });

    const wrongSchema = { ...canvasPackage, schema: "shellx-motion/canvas-bridge-package@2" };
    expect(schemaErrors(wrongSchema)).not.toEqual([]);
    const wrongSchemaDir = await mkdtemp(join(process.cwd(), ".tmp-shellx-motion-canvas-bridge-wrong-schema-"));
    tempDirs.push(wrongSchemaDir);
    await expect(writeCanvasMotionPackage(wrongSchema as any, { packageDir: wrongSchemaDir }))
      .rejects.toThrow("Unsupported Canvas bridge package schema");

    const missingReceipt = { ...canvasPackage } as Record<string, unknown>;
    delete missingReceipt.receipt;
    expect(schemaErrors(missingReceipt)).not.toEqual([]);

    const unknownTopLevelField = { ...canvasPackage, unexpected: true };
    expect(schemaErrors(unknownTopLevelField)).toContainEqual({ path: "/unexpected", message: "unexpected property" });

    const badManifest = {
      ...canvasPackage,
      manifest: { ...canvasPackage.manifest, schema: "shellx-motion/package-manifest@999" }
    };
    expect(schemaErrors(badManifest)).not.toEqual([]);

    const badIntegration = {
      ...canvasPackage,
      integration: { ...canvasPackage.integration, payloadSchema: "shellx-canvas/frame-selection@999" }
    };
    expect(schemaErrors(badIntegration)).not.toEqual([]);

  });

  itLinux("retains the explicit id-less legacy writer path", async () => {
    const canvasPackage = convertCanvasFrameToMotionPackage(readJson(resolve(fixturesDir, "frame-selection.json")), {
      createdAt: "2026-08-08T00:00:00.000Z"
    });
    // New producers always include `schema`; this deliberately preserves old in-process callers
    // whose CanvasMotionExport was constructed before the schema existed, without presenting that shape as a
    // versioned external wire contract.
    const { schema: _legacySchema, ...legacyPackage } = canvasPackage;
    const legacyAssetFreePackage = {
      ...legacyPackage,
      manifest: { ...legacyPackage.manifest, assets: [] },
      motion: { ...legacyPackage.motion, assets: [] }
    };
    expect(schemaErrors(legacyPackage)).not.toEqual([]);
    const legacyDir = await mkdtemp(join(process.cwd(), ".tmp-shellx-motion-canvas-bridge-legacy-"));
    tempDirs.push(legacyDir);
    await expect(writeCanvasMotionPackage(legacyAssetFreePackage, { packageDir: legacyDir })).resolves.toMatchObject({ packageDir: legacyDir });
  });
});
