/** Declarative contracts for typed compositing graph authoring. */
import type { MotionDebugArgPropertySchema, MotionDebugCommandMetadata } from "./command-registry.js";

const PACKAGE: Record<string, MotionDebugArgPropertySchema> = {
  packageRoot: { type: "string", description: "Source Motion package." },
};
const MUTATION: Record<string, MotionDebugArgPropertySchema> = {
  ...PACKAGE,
  outDir: { type: "string", description: "Empty or absent copy-on-write output directory." },
  receiptsRoot: { type: "string", description: "Optional trusted host receipt mirror." },
  createdBy: { type: "string", description: "Optional author identity recorded in output facts." },
};

/**
 * The graph commands additionally accept `packageDir` for `outDir`
 * (`domains/authoring-compositing-graph.ts` reads `outDir ?? packageDir`).
 *
 * The procedural relationship commands below deliberately do NOT get this: their parser reads
 * `outDir` only, so declaring the synonym there would advertise an argument the handler rejects —
 * the mirror of the defect this sweep fixed, and just as unusable for an agent.
 */
const GRAPH_MUTATION: Record<string, MotionDebugArgPropertySchema> = {
  ...MUTATION,
  outDir: { ...MUTATION.outDir, aliases: ["packageDir"] },
};

/**
 * The four `motion.procedural.relationship.*` commands share one argument parser
 * (`domains/authoring-procedural.ts#mutationArgs`) that reads every one of these on every command
 * and folds each supplied argument into the receipt input, then enforces per-command REQUIREDness
 * afterwards. So each command accepts the whole set and `required` is the real discriminator —
 * declaring less would make `additionalProperties: false` refuse calls the engine accepts.
 * `scripts/debug-arg-coverage.ts` holds the two in agreement.
 */
const RELATIONSHIP_MUTATION: Record<string, MotionDebugArgPropertySchema> = {
  ...MUTATION,
  relationship: { type: "object", description: "Data-only typed scalar relationship; executable expressions are rejected. Required by motion.procedural.relationship.set." },
  relationshipId: { type: "string", description: "Stable relationship id. Required by enabled.set and detach." },
  enabled: { type: "boolean", description: "Whether the relationship participates in evaluation. Required by motion.procedural.relationship.enabled.set." },
  relationshipIds: { type: "array", description: "Optional relationship ids; bake defaults to all enabled relationships." },
  startMs: { type: "number", minimum: 0, description: "First baked sample time in milliseconds; the layer start when omitted." },
  endMs: { type: "number", minimum: 0, description: "Last baked sample time in milliseconds; the layer end when omitted." },
  sampleEveryFrames: { type: "number", minimum: 1, description: "Bake one keyframe every N frames; must be a positive integer." },
};

export const COMPOSITING_COMMAND_METADATA = {
  "motion.compositing.graph.inspect": {
    argsSchema: {
      type: "object",
      required: ["packageRoot"],
      properties: PACKAGE,
      additionalProperties: false,
    },
    expectedReceipts: [
      { operation: "compositing.graph.set", mode: "reads", required: false },
    ],
  },
  "motion.compositing.graph.set": {
    argsSchema: {
      type: "object",
      required: ["packageRoot", "outDir", "graph"],
      properties: {
        ...GRAPH_MUTATION,
        graph: { type: "object", description: "Versioned, acyclic, data-only compositing graph." },
      },
      additionalProperties: false,
    },
    expectedReceipts: [{
      operation: "compositing.graph.set",
      mode: "emits",
      required: true,
      artifactRoles: ["motion_package", "compositing_graph_receipt"],
    }],
  },
  "motion.compositing.graph.remove": {
    argsSchema: {
      type: "object",
      required: ["packageRoot", "outDir"],
      // `graph` is read here too: set and remove share one handler that hashes the supplied graph
      // into the receipt's mutation input regardless of which ran. Omitting it from the schema made
      // additionalProperties:false refuse a call the engine accepts.
      properties: {
        ...GRAPH_MUTATION,
        graph: { type: "object", description: "Ignored by remove; recorded in the receipt input hash when supplied." },
      },
      additionalProperties: false,
    },
    expectedReceipts: [{
      operation: "compositing.graph.remove",
      mode: "emits",
      required: true,
      artifactRoles: ["motion_package", "compositing_graph_receipt"],
    }],
  },
  "motion.procedural.inspect": {
    argsSchema: {
      type: "object",
      required: ["packageRoot"],
      properties: {
        ...PACKAGE,
        atMs: { type: "number", minimum: 0, description: "Optional timeline time to evaluate readable relationship outputs." },
      },
      additionalProperties: false,
    },
  },
  "motion.procedural.relationship.set": {
    argsSchema: {
      type: "object",
      required: ["packageRoot", "outDir", "relationship"],
      properties: RELATIONSHIP_MUTATION,
      additionalProperties: false,
    },
    expectedReceipts: [proceduralReceipt("procedural.relationship.set")],
  },
  "motion.procedural.relationship.enabled.set": {
    argsSchema: {
      type: "object",
      required: ["packageRoot", "outDir", "relationshipId", "enabled"],
      properties: RELATIONSHIP_MUTATION,
      additionalProperties: false,
    },
    expectedReceipts: [proceduralReceipt("procedural.relationship.enabled.set")],
  },
  "motion.procedural.relationship.bake": {
    argsSchema: {
      type: "object",
      required: ["packageRoot", "outDir"],
      properties: RELATIONSHIP_MUTATION,
      additionalProperties: false,
    },
    expectedReceipts: [proceduralReceipt("procedural.relationship.bake")],
  },
  "motion.procedural.relationship.detach": {
    argsSchema: {
      type: "object",
      required: ["packageRoot", "outDir", "relationshipId"],
      properties: RELATIONSHIP_MUTATION,
      additionalProperties: false,
    },
    expectedReceipts: [proceduralReceipt("procedural.relationship.detach")],
  },
} satisfies MotionDebugCommandMetadata;

function proceduralReceipt(operation: string) {
  return {
    operation,
    mode: "emits" as const,
    required: true,
    artifactRoles: ["motion_package", "procedural_relationship_receipt"],
  };
}
