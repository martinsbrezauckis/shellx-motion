import {
  proceduralRelationshipGraphFingerprint,
  validateMotionProceduralGraph,
  type MotionProceduralGraph,
} from "@shellx-motion/core";
import { describe, expect, it } from "vitest";
import { validateProceduralOutput, validateProceduralRequest } from "./procedural-client.js";

const SHA = "a".repeat(64);

describe("procedural SDK transport guards", () => {
  it("accepts allow-listed data nodes and rejects executable, cyclic, and over-broad inputs", () => {
    expect(validateProceduralRequest("proceduralSet", {
      packageRoot: "/motion/source",
      outDir: "/motion/output",
      relationship: relationship(),
    })).toBeNull();
    expect(validateProceduralRequest("proceduralSet", {
      relationship: { ...relationship(), expression: "time * 20" },
    })).toMatchObject({ code: "invalid_request", message: expect.stringMatching(/unsupported field/i) });
    expect(validateProceduralRequest("proceduralSet", {
      relationship: {
        ...relationship(),
        nodes: [{ id: "loop", type: "negate", input: "loop" }],
        outputNodeId: "loop",
      },
    })).toMatchObject({ code: "invalid_request", message: expect.stringMatching(/acyclic/i) });
    expect(validateProceduralRequest("proceduralBake", {
      relationshipIds: ["drift"],
      startMs: 900,
      endMs: 100,
    })).toMatchObject({ code: "invalid_request", message: expect.stringContaining("must not exceed") });
    expect(validateProceduralRequest("proceduralBake", { relationshipIds: [] }))
      .toMatchObject({ code: "invalid_request", message: expect.stringContaining("1..64") });
    expect(validateProceduralRequest("proceduralSetEnabled", {
      relationshipId: "drift",
      enabled: "yes",
    })).toMatchObject({ code: "invalid_request", message: expect.stringContaining("boolean") });
  });

  it("binds mutation state, summaries, receipts, and bake evidence to the request", () => {
    const output = mutationOutput();
    const request = { packageRoot: "/motion/source", outDir: "/motion/output", relationship: relationship() };
    expect(validateProceduralOutput("proceduralSet", output, request)).toBeNull();
    expect(validateProceduralOutput("proceduralSet", {
      ...output,
      receipt: { ...output.receipt, path: "/motion/output/receipts/swapped.json" },
    }, request)).toMatchObject({ code: "invalid_transport_response" });
    expect(validateProceduralOutput("proceduralSet", {
      ...output,
      state: { ...output.state, fingerprint: "b".repeat(64) },
    }, request)).toMatchObject({ code: "invalid_transport_response" });
    expect(validateProceduralOutput("proceduralSet", {
      ...output,
      state: {
        ...output.state,
        validation: { ...output.state.validation, estimate: { maxWorkPerFrame: 1n } },
      },
    }, request)).toMatchObject({ code: "invalid_transport_response" });

    const baked = {
      ...output,
      operation: "procedural.relationship.bake",
      state: {
        graph: null,
        relationships: [],
        validation: null,
        fingerprint: null,
        evaluation: null,
      },
      receipt: { ...output.receipt, operation: "procedural.relationship.bake" },
      bake: { relationshipIds: ["drift"], sampleCount: 3, keyframeCount: 3, fingerprint: SHA },
    };
    expect(validateProceduralOutput("proceduralBake", baked, {
      packageRoot: "/motion/source",
      outDir: "/motion/output",
      relationshipIds: ["drift"],
    })).toBeNull();
    const { bake: _bake, ...missingBake } = baked;
    expect(validateProceduralOutput("proceduralBake", missingBake, {
      packageRoot: "/motion/source",
      outDir: "/motion/output",
    })).toMatchObject({ code: "invalid_transport_response", message: expect.stringContaining("bake evidence") });
  });

  /**
   * A relationship is checked WITHOUT a document, so the layers and audio envelopes it names are
   * synthesized around it (`placeholderLayers` / `placeholderEnvelopes`). These three cases pin what
   * a caller may be told about that invented half — all three were reproduced against the shipped
   * code during cross-host verification before the attribution was added.
   */
  describe("relationship pre-flight against a placeholder document context", () => {
    const envelopeRelationship = (envelopeIds: string[]) => ({
      id: "drift",
      enabled: true,
      target: { layerId: "target", property: "transform.scale" },
      nodes: envelopeIds.map((envelopeId, index) => ({ id: `env${index}`, type: "audio-envelope", envelopeId })),
      outputNodeId: "env0",
    });

    it("points a refusal at the caller's own field, not at the envelope it invented", () => {
      // The mistake is the empty target.layerId. The synthesized envelope inherits that empty layer
      // id and envelopes are validated first, so this used to answer
      // "/relationships/audioEnvelopes/0/sourceLayerId: must reference an existing layer" —
      // a path the caller never wrote and cannot edit.
      const answer = validateProceduralRequest("proceduralSet", {
        relationship: { ...envelopeRelationship(["kick"]), target: { layerId: "", property: "transform.scale" } },
      });

      expect(answer?.message).toContain("/relationships/relationships/0/target/layerId");
      expect(answer?.message).not.toContain("/relationships/audioEnvelopes");
    });

    it("says so in words when only the synthesized context objected", () => {
      // 17 audio-envelope nodes are inside the 64-node budget but produce 17 placeholder envelopes,
      // one past the 16 a document may hold. The caller sent no envelopes at all, so the refusal has
      // to explain where they came from instead of naming an array the caller does not have.
      const answer = validateProceduralRequest("proceduralSet", {
        relationship: envelopeRelationship(Array.from({ length: 17 }, (_unused, index) => `env_${index}`)),
      });

      expect(answer?.message).toContain("/relationships/relationships/0/nodes");
      expect(answer?.message).toContain("this check had to synthesize");
      expect(answer?.message).toContain("must contain at most 16 envelopes");
      expect(answer?.message).not.toContain("/relationships/audioEnvelopes");
    });

    it("does not pretend to know whether a named envelope exists", () => {
      // Deliberate and documented: the pre-flight has no document, so it accepts a relationship
      // naming an envelope the package may not have, and the engine — which has the document —
      // refuses it against the real envelope list. Recorded here so the boundary is a decision
      // rather than an assumption.
      expect(validateProceduralRequest("proceduralSet", { relationship: envelopeRelationship(["kick"]) })).toBeNull();

      const engine = validateMotionProceduralGraph(
        { schema: "shellx-motion/procedural-relationships@1", relationships: [envelopeRelationship(["kick"])] } as unknown as MotionProceduralGraph,
        { durationMs: 2_000, fps: 30, layers: [{ id: "target", type: "shape" }] },
      );
      expect(engine.ok).toBe(false);
      expect(engine.issues[0]).toMatchObject({ code: "node.envelope_missing" });
    });
  });
});

function relationship() {
  return {
    id: "drift",
    enabled: true,
    target: { layerId: "target", property: "transform.x" },
    nodes: [
      { id: "source", type: "property", ref: { layerId: "driver", property: "opacity" } },
      { id: "speed", type: "constant", value: 20 },
      { id: "output", type: "add", left: "source", right: "speed" },
    ],
    outputNodeId: "output",
  };
}

function mutationOutput() {
  const graph = { schema: "shellx-motion/procedural-relationships@1" as const, relationships: [relationship()] };
  const receiptPath = "/motion/output/receipts/procedural-relationship-set.receipt.json";
  return {
    packageRoot: "/motion/output",
    package: { packageId: "pkg", motionId: "motion" },
    operation: "procedural.relationship.set",
    changedPaths: ["/relationships/relationships/drift"],
    state: {
      graph,
      relationships: [{
        id: "drift",
        enabled: true,
        target: { layerId: "target", property: "transform.x" },
        sources: [{ layerId: "driver", property: "opacity" }],
        audioEnvelopeIds: [],
        nodeCount: 3,
        outputNodeId: "output",
      }],
      validation: validateMotionProceduralGraph(graph, {
        durationMs: 1_000,
        fps: 30,
        layers: [{ id: "driver", type: "shape" }, { id: "target", type: "shape" }],
      }),
      fingerprint: proceduralRelationshipGraphFingerprint(graph as unknown as MotionProceduralGraph),
      evaluation: null,
    },
    receipt: {
      schema: "shellx-motion/receipt@1",
      id: "procedural-set",
      packageId: "pkg",
      operation: "procedural.relationship.set",
      status: "passed",
      path: receiptPath,
      sha256: SHA,
    },
    receiptPath,
    warnings: [],
  };
}
