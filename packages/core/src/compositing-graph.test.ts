import { describe, expect, it } from "vitest";
import type { MotionDocument, MotionLayer } from "./types";
import type { MotionCompositingCompileMetadata, MotionCompositingEdge, MotionCompositingGraph, MotionCompositingNode } from "./compositing-graph-types";
import {
  MotionCompositingGraphError, compileMotionCompositingGraph, compileMotionDocumentCompositing,
  compositingGraphFingerprint, restoreMotionDocumentCompositing,
} from "./compositing-graph-compile";
import { validateMotionCompositingGraph } from "./compositing-graph-validate";
import { loadSchema, validateDocument } from "./validate";

describe("typed compositing graph", () => {
  it("validates and deterministically compiles source, transform, color, blur, and output nodes", async () => {
    const document = motion([shape("plate", "#223344")]);
    const graph = graphOf([
      { id: "source", type: "source", layerId: "plate" },
      { id: "move", type: "transform", transform: { x: 80, y: 40, scale: 1.1 } },
      { id: "grade", type: "color", brightness: 1.15, contrast: 1.2, saturate: 0.8 },
      { id: "soften", type: "blur", radius: 6 },
      { id: "output", type: "output" },
    ], chain(["source", "move", "grade", "soften", "output"]));
    const validation = validateMotionCompositingGraph(graph, context(document));
    expect(validation).toMatchObject({ ok: true, order: ["source", "move", "grade", "soften", "output"] });
    expect(validation.estimate).toMatchObject({ nodeCount: 5, edgeCount: 4, sourceCount: 1, maxDepth: 5 });
    const result = compileMotionCompositingGraph(document, graph);
    expect(result.layers).toEqual([{
      ...shape("plate", "#223344"), id: "cg.graph.soften", transform: { x: 80, y: 40, scale: 1.1 },
      effects: { brightness: 1.15, contrast: 1.2, saturate: 0.8, blur: 6 },
    }]);
    expect(result.metadata).toMatchObject({ graphId: "graph", sourceLayerIds: ["plate"], outputLayerIds: ["cg.graph.soften"] });
    expect(result.metadata.fingerprint).toMatch(/^[a-f0-9]{16}$/);
    expect(compositingGraphFingerprint(structuredClone(graph))).toBe(result.metadata.fingerprint);
    expect(await validateDocument(await loadSchema("motion"), { ...document, compositing: graph })).toEqual({ ok: true });
  });

  it("compiles typed blend branches with deterministic fan-out-safe identities", () => {
    const document = motion([shape("background", "#112233"), shape("foreground", "#88ccff")]);
    const graph = graphOf([
      { id: "bg", type: "source", layerId: "background" },
      { id: "fg", type: "source", layerId: "foreground" },
      { id: "fg_move", type: "transform", transform: { x: 120 } },
      { id: "blend", type: "blend", mode: "screen" },
      { id: "output", type: "output" },
    ], [edge("bg_blend", "bg", "blend", "background"), edge("fg_move", "fg", "fg_move", "input"), edge("move_blend", "fg_move", "blend", "foreground"), edge("blend_out", "blend", "output", "input")]);
    const result = compileMotionCompositingGraph(document, graph);
    expect(result.layers).toHaveLength(2);
    expect(result.layers[0].id).toBe("cg.graph.blend.background.0");
    expect(result.layers[1]).toMatchObject({ id: "cg.graph.blend.foreground.0", blendMode: "screen", transform: { x: 120 } });
    expect(validateMotionCompositingGraph(graph, context(document)).estimate.maxFanOut).toBe(1);
  });

  it("compiles an explicit shape matte to existing MotionIR semantics", async () => {
    const document = motion([shape("matte_shape", "#ffffff"), shape("content", "#ff3366")]);
    const graph = graphOf([
      { id: "matte_source", type: "source", layerId: "matte_shape" },
      { id: "content_source", type: "source", layerId: "content" },
      { id: "matte", type: "matte", matteType: "alpha" },
      { id: "output", type: "output" },
    ], [edge("content_matte", "content_source", "matte", "input"), edge("shape_matte", "matte_source", "matte", "matte"), edge("matte_out", "matte", "output", "input")]);
    const result = compileMotionCompositingGraph(document, graph);
    expect(result.layers[1].matte).toEqual({ type: "alpha", sourceLayerId: result.layers[0].id });
    const compiled = compileMotionDocumentCompositing({ ...document, compositing: graph });
    expect(compiled.layers.slice(0, 2).every((layer) => layer.visible === false)).toBe(true);
    expect(compiled["x-compositing-compile"]).toMatchObject({ graphId: "graph", outputLayerIds: result.layers.map((layer) => layer.id) });
    expect(document.layers.every((layer) => layer.visible === undefined)).toBe(true);
    expect(await validateDocument(await loadSchema("motion"), compiled)).toEqual({ ok: true });
    const recompiled = compileMotionDocumentCompositing(compiled);
    expect(recompiled.layers).toEqual(compiled.layers);
    expect(recompiled["x-compositing-compile"]).toEqual(compiled["x-compositing-compile"]);
    expect(restoreMotionDocumentCompositing(compiled)).toEqual({ ...document, compositing: graph });
  });

  it("refuses forged compile metadata before it can classify an ordinary layer as generated", () => {
    const document = motion([shape("plate", "#112233"), shape("ordinary", "#445566")]);
    const graph = graphOf([
      { id: "source", type: "source", layerId: "plate" },
      { id: "output", type: "output" },
    ], chain(["source", "output"]));
    const compiled = compileMotionDocumentCompositing({ ...document, compositing: graph });
    const metadata = structuredClone(compiled["x-compositing-compile"] as MotionCompositingCompileMetadata);
    metadata.outputLayerIds = ["ordinary"];
    const forged = {
      ...compiled,
      layers: compiled.layers.filter((layer) => !String(layer.id).startsWith("cg."))
        .map((layer) => layer.id === "ordinary"
          ? { ...layer, "x-compositing-generated": { schema: metadata.schema, graphId: metadata.graphId, fingerprint: metadata.fingerprint } }
          : layer),
      "x-compositing-compile": metadata,
    };
    expect(() => restoreMotionDocumentCompositing(forged)).toThrow(/deterministic graph compilation/);
    expect(document.layers.map((layer) => layer.id)).toEqual(["plate", "ordinary"]);
  });

  it("refuses missing, drifted, and stray compile markers", () => {
    const document = motion([shape("plate", "#112233")]);
    const graph = graphOf([
      { id: "source", type: "source", layerId: "plate" },
      { id: "output", type: "output" },
    ], chain(["source", "output"]));
    const compiled = compileMotionDocumentCompositing({ ...document, compositing: graph });
    const generatedIndex = compiled.layers.findIndex((layer) => String(layer.id).startsWith("cg."));
    const missing = structuredClone(compiled);
    delete missing.layers[generatedIndex]["x-compositing-generated"];
    expect(() => restoreMotionDocumentCompositing(missing)).toThrow(/generated marker/);
    const drifted = structuredClone(compiled);
    (drifted["x-compositing-compile"] as MotionCompositingCompileMetadata).fingerprint = "0".repeat(16);
    expect(() => restoreMotionDocumentCompositing(drifted)).toThrow(/not bound/);
    const stray = structuredClone(compiled);
    stray.layers[0]["x-compositing-generated"] = structuredClone(stray.layers[generatedIndex]["x-compositing-generated"]);
    expect(() => restoreMotionDocumentCompositing(stray)).toThrow(/not declared/);
  });

  it("recompiles generated output from a source layer changed by another authoring family", () => {
    const document = motion([shape("plate", "#112233")]);
    const graph = graphOf([
      { id: "source", type: "source", layerId: "plate" },
      { id: "output", type: "output" },
    ], chain(["source", "output"]));
    const compiled = compileMotionDocumentCompositing({ ...document, compositing: graph });
    const edited = structuredClone(compiled);
    const source = edited.layers.find((layer) => layer.id === "plate")!;
    source.fill = "#abcdef";
    expect(edited.layers.find((layer) => String(layer.id).startsWith("cg."))?.fill).toBe("#112233");
    const recompiled = compileMotionDocumentCompositing(edited);
    expect(recompiled.layers.find((layer) => String(layer.id).startsWith("cg."))?.fill).toBe("#abcdef");
    expect(restoreMotionDocumentCompositing(recompiled).layers[0].fill).toBe("#abcdef");
  });

  it("accepts real graph fan-out while retaining typed input ports", () => {
    const document = motion([shape("plate", "#112233")]);
    const graph = graphOf([
      { id: "source", type: "source", layerId: "plate" },
      { id: "left", type: "transform", transform: { x: -20 } },
      { id: "right", type: "transform", transform: { x: 20 } },
      { id: "blend", type: "blend", mode: "plus-lighter" },
      { id: "output", type: "output" },
    ], [edge("source_left", "source", "left", "input"), edge("source_right", "source", "right", "input"), edge("left_blend", "left", "blend", "background"), edge("right_blend", "right", "blend", "foreground"), edge("blend_out", "blend", "output", "input")]);
    const validation = validateMotionCompositingGraph(graph, context(document));
    expect(validation.ok).toBe(true);
    expect(validation.estimate.maxFanOut).toBe(2);
    expect(new Set(compileMotionCompositingGraph(document, graph).layers.map((layer) => layer.id)).size).toBe(2);
  });

  it("rejects cycles, port type mismatches, occupied inputs, and disconnected nodes", () => {
    const document = motion([shape("plate", "#112233")]);
    const mismatch = graphOf([
      { id: "source", type: "source", layerId: "plate" }, { id: "blend", type: "blend", mode: "screen" },
      { id: "blur", type: "blur", radius: 4 }, { id: "output", type: "output" },
    ], [edge("a", "source", "blend", "background"), edge("b", "source", "blend", "foreground"), edge("c", "blend", "blur", "input"), edge("d", "blur", "output", "input")]);
    expect(validateMotionCompositingGraph(mismatch, context(document)).issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "edge.type_mismatch" })]));
    const occupied = structuredClone(mismatch); occupied.edges.push(edge("extra", "source", "blur", "input"));
    expect(validateMotionCompositingGraph(occupied, context(document)).issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "edge.input_occupied" })]));
    const cycle = graphOf([
      { id: "source", type: "source", layerId: "plate" }, { id: "a", type: "transform", transform: { x: 1 } },
      { id: "b", type: "transform", transform: { x: 2 } }, { id: "output", type: "output" },
    ], [edge("a_b", "a", "b", "input"), edge("b_a", "b", "a", "input"), edge("source_out", "source", "output", "input")]);
    expect(validateMotionCompositingGraph(cycle, context(document)).issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "graph.cycle" })]));
    expect(() => compileMotionCompositingGraph(document, mismatch)).toThrow(MotionCompositingGraphError);
  });

  it("rejects unknown/prototype-shaped data, noncontiguous sources, and resource amplification", () => {
    const document = motion([shape("a", "#111111"), shape("between", "#222222"), shape("b", "#333333")]);
    const graph = graphOf([
      { id: "a", type: "source", layerId: "a" }, { id: "b", type: "source", layerId: "b" },
      { id: "blend", type: "blend", mode: "screen" }, { id: "output", type: "output" },
    ], [edge("a_blend", "a", "blend", "background"), edge("b_blend", "b", "blend", "foreground"), edge("out", "blend", "output", "input")]);
    expect(validateMotionCompositingGraph(graph, context(document)).issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "source.noncontiguous" })]));
    expect(validateMotionCompositingGraph({ ...graph, execute: "alert(1)" }, context(document)).issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "object.field" })]));
    expect(validateMotionCompositingGraph(Object.create(graph), context(document)).issues[0].code).toBe("graph.object");
    const accessor = { ...graph }; Object.defineProperty(accessor, "execute", { get: () => { throw new Error("must not execute"); } });
    expect(() => validateMotionCompositingGraph(accessor, context(document))).not.toThrow();
    expect(validateMotionCompositingGraph(accessor, context(document)).issues[0].code).toBe("graph.object");
    const huge = validateMotionCompositingGraph(graph, { ...context(document), width: 32_768, height: 32_768 });
    expect(huge.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "graph.pixel_budget" }), expect.objectContaining({ code: "graph.memory_budget" })]));
  });
});

function motion(layers: MotionLayer[]): MotionDocument {
  return { schema: "shellx-motion/motion@1", id: "motion", name: "Graph fixture", durationMs: 1000, fps: 30, width: 640, height: 360, layers, assets: [], provenance: { sourceApp: "test", createdBy: "test" } };
}
function shape(id: string, fill: string): MotionLayer { return { id, type: "shape", shape: "rectangle", startMs: 0, durationMs: 1000, fill, width: 640, height: 360 }; }
function context(document: MotionDocument) { return { width: document.width, height: document.height, layers: document.layers }; }
function graphOf(nodes: MotionCompositingNode[], edges: MotionCompositingEdge[]): MotionCompositingGraph { return { schema: "shellx-motion/compositing-graph@1", id: "graph", nodes, edges }; }
function edge(id: string, from: string, to: string, port: MotionCompositingEdge["to"]["port"]): MotionCompositingEdge { return { id, from: { nodeId: from, port: "output" }, to: { nodeId: to, port } }; }
function chain(ids: string[]): MotionCompositingEdge[] { return ids.slice(1).map((id, index) => edge(`edge_${index}`, ids[index], id, "input")); }
