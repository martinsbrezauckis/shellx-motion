import { describe, expect, it } from "vitest";
import { debugCommandContract } from "@shellx-motion/debug-api";
import { publishedArgsSchema } from "./mcp-tool-shape.js";
import { argumentProblems } from "./mcp-args-property-validation.js";

describe("MCP exact scalar schema enforcement", () => {
  it("enforces B1c's published opaque identity and handle grammar", () => {
    const contract = debugCommandContract("motion.timeline.checkpoint-storyboard.creative-review.bind");
    if (!contract) throw new Error("Expected B1c command contract.");
    const schema = publishedArgsSchema(contract);
    if (!schema) throw new Error("Expected B1c argument schema.");
    const violations = argumentProblems(schema, {
      identity: { id: "checkpoint", sha256: "a".repeat(64), revision: 1.5 },
      preview: {
        previewHandle: "checkpoint",
        receiptHandle: `checkpoint_storyboard_preview_receipt_${"D".repeat(32)}`,
      },
      creativeReviewHandle: `checkpoint_storyboard_creative_review_handle_${"D".repeat(32)}`,
    });
    expect(violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ argument: "identity.id", kind: "below_min_length", minLength: 54 }),
      expect.objectContaining({ argument: "identity.revision", kind: "not_multiple_of", multipleOf: 1 }),
      expect.objectContaining({ argument: "preview.previewHandle", kind: "below_min_length", minLength: 62 }),
      expect.objectContaining({ argument: "preview.receiptHandle", kind: "bad_pattern", pattern: "^checkpoint_storyboard_preview_receipt_[a-f0-9]{32}$" }),
      expect.objectContaining({ argument: "creativeReviewHandle", kind: "bad_pattern", pattern: "^checkpoint_storyboard_creative_review_handle_[a-f0-9]{32}$" }),
    ]));
  });

  it("enforces B1d's closed checkpoint id and whole-millisecond time target scalars", () => {
    const contract = debugCommandContract("motion.timeline.checkpoint-storyboard.preview");
    if (!contract) throw new Error("Expected B1d command contract.");
    const schema = publishedArgsSchema(contract);
    if (!schema) throw new Error("Expected B1d argument schema.");
    const identity = { id: `checkpoint_storyboard_${"a".repeat(32)}`, sha256: "b".repeat(64), revision: 1 };
    expect(argumentProblems(schema, { identity, target: { kind: "checkpoint", checkpointId: "bad id" } })).toEqual(expect.arrayContaining([
      expect.objectContaining({ argument: "target.checkpointId", kind: "bad_pattern", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$" }),
    ]));
    expect(argumentProblems(schema, { identity, target: { kind: "time", atMs: 0.5 } })).toEqual(expect.arrayContaining([
      expect.objectContaining({ argument: "target.atMs", kind: "not_multiple_of", multipleOf: 1 }),
    ]));
  });

  it("refuses unknown fields throughout the closed B7 retained-trace create descriptor", () => {
    const contract = debugCommandContract("motion.timeline.checkpoint-storyboard.create");
    if (!contract) throw new Error("Expected checkpoint storyboard create contract.");
    const schema = publishedArgsSchema(contract);
    if (!schema) throw new Error("Expected checkpoint storyboard create argument schema.");
    const caps = { maxSamples: 64, maxVertices: 64, maxWorkUnits: 16_384, maxBytes: 131_072 };
    const descriptor: any = {
      seed: 1, capabilityRequirements: ["renderer.gpu"], objectCatalog: [{ objectId: "trace-anchor", rootShapeKind: "rect", propertyMask: ["opacity"] }],
      checkpoints: [
        { id: "start", atUs: 0, objects: [{ objectId: "trace-anchor", state: "present", properties: [{ property: "opacity", value: 0.75 }] }] },
        { id: "finish", atUs: 4_000, objects: [{ objectId: "trace-anchor", state: "present", properties: [{ property: "opacity", value: 0.75 }] }] },
      ],
      edges: [{ id: "start-finish", fromCheckpointId: "start", toCheckpointId: "finish", lifecycle: [{ kind: "preserve", objectId: "trace-anchor" }], recipeIds: ["retained-line"] }],
      recipes: [{ recipeId: "retained-line", seed: 2, exactBaseRequirements: [], intent: { kind: "parametric-trace", outputObjectId: "trace-anchor", trace: {
        schema: "shellx-motion/private-parametric-trace@1", clip: { durationUs: 4_000, sampleIntervalUs: 1_000 }, drawers: [{ id: "line", driver: { kind: "parametric-graph", graph: { nodes: [
          { id: "time", kind: "time-us" }, { id: "scale", kind: "constant", value: 0.001 }, { id: "x", kind: "multiply", left: "time", right: "scale" }, { id: "zero", kind: "constant", value: 0 },
        ], output: { x: "x", y: "zero", z: "zero" } } }, retention: { kind: "full-clip", maxSamples: 5 }, output: { mode: "line", width: { source: "constant", from: 2, to: 2 }, colour: { source: "constant", from: 0.5, to: 0.5 }, opacity: { source: "constant", from: 0.75, to: 0.75 }, speedLimit: 100 } }], caps: { perDrawer: { ...caps }, aggregate: { ...caps } },
      } } }],
    };
    expect(argumentProblems(schema, { descriptor })).toEqual([]);
    for (const [argument, mutate] of [
      ["descriptor.checkpoints[0].packageRoot", (value: any) => { value.checkpoints[0].packageRoot = "/tmp/source"; }],
      ["descriptor.edges[0].renderer", (value: any) => { value.edges[0].renderer = true; }],
      ["descriptor.recipes[0].intent.trace.drawers[0].driver.graph.output.w", (value: any) => { value.recipes[0].intent.trace.drawers[0].driver.graph.output.w = "zero"; }],
      ["descriptor.recipes[0].intent.trace.drawers[0].output.receipt", (value: any) => { value.recipes[0].intent.trace.drawers[0].output.receipt = "caller-owned"; }],
    ] as const) {
      const hostile = structuredClone(descriptor);
      mutate(hostile);
      expect(argumentProblems(schema, { descriptor: hostile }), argument).toEqual(expect.arrayContaining([
        expect.objectContaining({ argument, kind: "unknown_property" }),
      ]));
    }
  });

  it("keeps the named data-recipe formula and parameter alternatives correlated", () => {
    const contract = debugCommandContract("motion.timeline.checkpoint-storyboard.create");
    if (!contract) throw new Error("Expected checkpoint storyboard create contract.");
    const schema = publishedArgsSchema(contract);
    if (!schema) throw new Error("Expected checkpoint storyboard create argument schema.");
    const base = (formulaId: string, parameters: Record<string, number>) => ({
      schema: "shellx-motion/data-recipe-checkpoint@1", storyboardSeed: 1, requiredCapability: "renderer.gpu",
      target: { objectId: "formula-trace", rootShapeKind: "rect" },
      checkpoints: [{ atUs: 0, state: "present", opacity: 0.75 }, { atUs: 63_000, state: "present", opacity: 0.75 }],
      recipe: { seed: 2, formulaId, actionId: "trace.full-clip-line@1", parameters, limits: { maxSamples: 64, maxVertices: 64, maxWorkUnits: 16_384, maxBytes: 131_072 } },
    });
    const line = { sampleCount: 64, strokeWidth: 2, strokeOpacity: 0.8, luma: 0.6, speedLimit: 1_000 };
    const lissajous = base("formula.lissajous-2d@1", { centerX: 0, centerY: 0, amplitudeX: 120, amplitudeY: 80, frequencyX: 3, frequencyY: 2, phaseTurnsQ1024: 128, ...line });
    const rose = base("formula.rose-curve-2d@1", { centerX: 0, centerY: 0, radius: 120, petals: 5, rotationTurnsQ1024: 128, ...line });
    expect(argumentProblems(schema, { descriptor: lissajous })).toEqual([]);
    expect(argumentProblems(schema, { descriptor: rose })).toEqual([]);
    expect(argumentProblems(schema, { descriptor: { ...lissajous, recipe: { ...lissajous.recipe, formulaId: "formula.rose-curve-2d@1" } } })).not.toEqual([]);
    expect(argumentProblems(schema, { descriptor: { ...rose, recipe: { ...rose.recipe, formulaId: "formula.lissajous-2d@1" } } })).not.toEqual([]);
    const scripted = structuredClone(rose) as any; scripted.recipe.parameters.script = "return globalThis";
    expect(argumentProblems(schema, { descriptor: scripted })).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "unknown_property" })]));
  });

  it("admits only the closed multi-checkpoint choreography recipe shape", () => {
    const contract = debugCommandContract("motion.timeline.checkpoint-storyboard.create");
    if (!contract) throw new Error("Expected checkpoint storyboard create contract.");
    const schema = publishedArgsSchema(contract);
    if (!schema) throw new Error("Expected checkpoint storyboard create argument schema.");
    const descriptor: any = {
      schema: "shellx-motion/data-recipe-choreography@1", storyboardSeed: 1, requiredCapability: "renderer.browser",
      objects: [
        { objectId: "orb-a", rootShapeKind: "ellipse", orbitRadius: 100, phaseTurnsQ1024: 0 },
        { objectId: "orb-b", rootShapeKind: "rect", orbitRadius: 160, phaseTurnsQ1024: 341 },
      ],
      checkpoints: [
        { atUs: 0, orbitTurnsQ1024: 0, radiusScaleQ1024: 1_024, scaleQ1024: 1_024, opacityQ1024: 1_024 },
        { atUs: 1_000_000, orbitTurnsQ1024: 256, radiusScaleQ1024: 1_024, scaleQ1024: 768, opacityQ1024: 768 },
        { atUs: 2_000_000, orbitTurnsQ1024: 512, radiusScaleQ1024: 512, scaleQ1024: 1_280, opacityQ1024: 512 },
      ],
      recipe: { seed: 2, formulaId: "formula.orbit-checkpoints-2d@1", actionId: "transform.checkpoint-orbit@1", parameters: { centerX: 320, centerY: 180, spatialTangentMode: "auto", scalarEasing: "ease-in-out" }, limits: { maxObjects: 8, maxCheckpoints: 8, maxRecipes: 14, maxWorkUnits: 16_384, maxBytes: 262_144 } },
    };
    expect(argumentProblems(schema, { descriptor })).toEqual([]);
    for (const [argument, mutate] of [
      ["descriptor.objects[0].script", (value: any) => { value.objects[0].script = "return globalThis"; }],
      ["descriptor.checkpoints[1].path", (value: any) => { value.checkpoints[1].path = [1, 2, 3]; }],
      ["descriptor.recipe.parameters.graph", (value: any) => { value.recipe.parameters.graph = {}; }],
    ] as const) {
      const hostile = structuredClone(descriptor); mutate(hostile);
      expect(argumentProblems(schema, { descriptor: hostile }), argument).toEqual(expect.arrayContaining([expect.objectContaining({ argument, kind: "unknown_property" })]));
    }
    const crossed = structuredClone(descriptor); crossed.recipe.formulaId = "formula.lissajous-2d@1";
    expect(argumentProblems(schema, { descriptor: crossed })).not.toEqual([]);
    const subMillisecond = structuredClone(descriptor); subMillisecond.checkpoints[1].atUs = 1_000_001;
    expect(argumentProblems(schema, { descriptor: subMillisecond })).toEqual(expect.arrayContaining([expect.objectContaining({ argument: "descriptor.checkpoints[1].atUs", kind: "not_multiple_of", multipleOf: 1_000 })]));
  });
});
