/** Declarative keying and roto command contracts. */
import type { MotionDebugArgPropertySchema, MotionDebugCommandMetadata } from "./command-registry.js";

const PACKAGE_LAYER_PROPERTIES: Record<string, MotionDebugArgPropertySchema> = {
  packageRoot: { type: "string", description: "Source Motion package." },
  layerId: { type: "string", description: "Image or video layer id." },
};

/**
 * The five mutating keying/roto commands share one handler (`domains/authoring-keying.ts#mutate`),
 * and that handler reads `keying` AND `mask` on every one of them — both are hashed into the
 * receipt's `mutation` input hash regardless of which operation ran. `additionalProperties: false`
 * therefore has to name both, or a call the engine accepts is refused at the MCP transport.
 * `scripts/debug-arg-coverage.ts` proves the two stay in agreement.
 */
const MUTATION_PROPERTIES: Record<string, MotionDebugArgPropertySchema> = {
  ...PACKAGE_LAYER_PROPERTIES,
  outDir: {
    type: "string",
    aliases: ["packageDir"],
    description: "Empty or absent output directory for the copy-on-write package."
  },
  receiptsRoot: { type: "string", description: "Optional trusted host receipt mirror." },
  keying: { type: "object", description: "Chroma-key controls. Applied by motion.keying.apply; on the other operations it is only recorded in the receipt input hash." },
  mask: { type: "object", description: "Roto mask. Applied by motion.roto.upsert; on the other operations it is only recorded in the receipt input hash." },
};

const mutationReceipt = (operation: string) => [
  { operation, mode: "emits" as const, required: true, artifactRoles: ["motion_package", "keying_receipt"] },
];

export const KEYING_COMMAND_METADATA = {
  "motion.keying.inspect": {
    argsSchema: { type: "object", required: ["packageRoot", "layerId"], properties: PACKAGE_LAYER_PROPERTIES, additionalProperties: false },
    expectedReceipts: [{ operation: "keying.apply", mode: "reads", required: false, artifactRoles: ["keying_receipt"] }],
  },
  "motion.keying.apply": {
    argsSchema: {
      type: "object",
      required: ["packageRoot", "outDir", "layerId", "keying"],
      properties: { ...MUTATION_PROPERTIES, keying: { type: "object", description: "Bounded chroma-key and matte-cleanup controls." } },
      additionalProperties: false,
    },
    expectedReceipts: mutationReceipt("keying.apply"),
  },
  "motion.keying.remove": {
    argsSchema: { type: "object", required: ["packageRoot", "outDir", "layerId"], properties: MUTATION_PROPERTIES, additionalProperties: false },
    expectedReceipts: mutationReceipt("keying.remove"),
  },
  "motion.roto.upsert": {
    argsSchema: {
      type: "object",
      required: ["packageRoot", "outDir", "layerId", "mask"],
      properties: { ...MUTATION_PROPERTIES, mask: { type: "object", description: "Bounded animated roto mask with optional tracking attachment." } },
      additionalProperties: false,
    },
    expectedReceipts: mutationReceipt("roto.upsert"),
  },
  "motion.roto.tracking.detach": {
    argsSchema: { type: "object", required: ["packageRoot", "outDir", "layerId"], properties: MUTATION_PROPERTIES, additionalProperties: false },
    expectedReceipts: mutationReceipt("roto.tracking.detach"),
  },
  "motion.roto.remove": {
    argsSchema: { type: "object", required: ["packageRoot", "outDir", "layerId"], properties: MUTATION_PROPERTIES, additionalProperties: false },
    expectedReceipts: mutationReceipt("roto.remove"),
  },
} satisfies MotionDebugCommandMetadata;
