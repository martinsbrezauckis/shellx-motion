import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { renderableLayerTypes, validateAgainstPublishedSchema, type JsonSchemaDocument } from "@shellx-motion/core";
import { convertCanvasFrameToMotionPackage } from "./index";

/**
 * Connector-review D3: the Canvas frame-selection contract advertised
 * `shellx-motion/canvas-frame-selection@1` but shipped no schema file — the only definition of
 * "valid frame selection" on the Motion side was the imperative parser
 * (parseCanvasFrameSelection in ./fixture-parse). This suite pins the published
 * schemas/canvas-frame-selection.schema.json to that parser: every fixture must be accepted by both,
 * and structural violations must be rejected by both, so schema-vs-parser drift fails CI.
 */
const schemaPath = resolve("../../schemas/canvas-frame-selection.schema.json");
const fixturesDir = resolve("../../fixtures/canvas");

function loadSchema(): JsonSchemaDocument {
  return JSON.parse(readFileSync(schemaPath, "utf8")) as JsonSchemaDocument;
}

function fixtureFiles(): string[] {
  return readdirSync(fixturesDir).filter((name) => name.endsWith(".json"));
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

/** The Motion-side parser is the authority; it accepts a selection iff conversion does not throw. */
function parserAccepts(doc: unknown): boolean {
  try {
    convertCanvasFrameToMotionPackage(doc);
    return true;
  } catch {
    return false;
  }
}

function schemaAccepts(schema: JsonSchemaDocument, doc: unknown): boolean {
  return validateAgainstPublishedSchema(schema, doc).length === 0;
}

describe("canvas frame-selection published schema contract", () => {
  it("accepts every shipped Canvas fixture (schema and parser agree)", () => {
    const schema = loadSchema();
    const files = fixtureFiles();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const doc = readJson(resolve(fixturesDir, file));
      expect(validateAgainstPublishedSchema(schema, doc)).toEqual([]);
      expect(parserAccepts(doc)).toBe(true);
    }
  });

  it("rejects structural violations identically to the Motion parser (no drift)", () => {
    const schema = loadSchema();
    const base = readJson(resolve(fixturesDir, "frame-selection.json")) as Record<string, unknown>;

    // Each mutation removes/breaks a field the parser enforces structurally. The published schema
    // must reject exactly the same documents the parser rejects.
    const mutations: Array<{ label: string; mutate: (doc: any) => void }> = [
      { label: "root missing selectedFrameId", mutate: (doc) => { delete doc.selectedFrameId; } },
      { label: "root empty selectedFrameId", mutate: (doc) => { doc.selectedFrameId = ""; } },
      { label: "unsupported schema id", mutate: (doc) => { doc.schema = "shellx-unknown/frame@9"; } },
      { label: "project missing name", mutate: (doc) => { delete doc.project.name; } },
      { label: "brand missing tokens", mutate: (doc) => { delete doc.brand.tokens; } },
      { label: "frame missing width", mutate: (doc) => { delete doc.frames[0].width; } },
      { label: "frame width not a number", mutate: (doc) => { doc.frames[0].width = "1080"; } },
      { label: "layer missing kind", mutate: (doc) => { delete doc.frames[0].layers[0].kind; } },
      { label: "layer kind no lane renders", mutate: (doc) => { doc.frames[0].layers[0].kind = "rect"; } },
      { label: "layer kind unknown entirely", mutate: (doc) => { doc.frames[0].layers[0].kind = "plugin-widget"; } },
      { label: "layer missing startMs", mutate: (doc) => { delete doc.frames[0].layers[0].startMs; } },
      { label: "imageEditorOutput missing sha256", mutate: (doc) => { delete doc.imageEditorOutputs[0].sha256; } }
    ];

    for (const { label, mutate } of mutations) {
      const doc = structuredClone(base);
      mutate(doc);
      expect(schemaAccepts(schema, doc), `${label}: schema should reject`).toBe(false);
      expect(parserAccepts(doc), `${label}: parser should reject`).toBe(false);
    }
  });

  it("pins the schema's required field lists to the parser's enforced fields", () => {
    // Mirror of parseCanvasFrameSelection / parseFrame / parseLayer / parseImageEditorOutput. If the
    // parser's required set changes, update both it and this pin (and the reject-agreement test above
    // will already have started failing).
    const schema = loadSchema() as any;
    expect(schema.required).toEqual(["schema", "selectedFrameId", "project", "brand", "frames", "imageEditorOutputs"]);
    expect(schema.$defs.frame.required).toEqual(["id", "name", "durationMs", "fps", "width", "height", "layers"]);
    expect(schema.$defs.layer.required).toEqual(["id", "kind", "startMs", "durationMs"]);
    expect(schema.$defs.imageEditorOutput.required).toEqual(
      ["id", "assetId", "kind", "path", "mimeType", "width", "height", "sha256", "editStack"]
    );
    expect(schema.properties.schema.enum).toEqual(
      ["shellx-motion/canvas-frame-selection@1", "shellx-canvas/frame-selection@1"]
    );
  });

  it("pins the published layer.kind enum to the renderer capability cards", () => {
    // The parser rejects a kind no lane can render, so the published schema has to reject the same
    // set — otherwise the schema promises a document the importer refuses. Deriving the expectation
    // from renderableLayerTypes() means registering a lane, or widening a lane's layerTypes, fails
    // here until the published contract is updated with it.
    const schema = loadSchema() as any;
    expect(schema.$defs.layer.properties.kind.enum).toEqual([...renderableLayerTypes()]);
  });
});
