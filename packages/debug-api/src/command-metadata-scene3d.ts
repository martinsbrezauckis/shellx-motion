import type { MotionDebugCommandMetadata } from "./command-registry.js";

export const SCENE3D_COMMAND_METADATA = {
  "motion.scene3d.gltf.import": {
    argsSchema: {
      type: "object",
      required: ["sourcePath", "outDir"],
      properties: {
        sourcePath: { type: "string", description: "Host-approved local .gltf or .glb source path." },
        outDir: { type: "string", description: "Host-approved empty or absent package output directory." },
        createdBy: { type: "string", description: "Optional author identity recorded in package provenance." },
        createdAt: { type: "string", description: "Optional deterministic ISO timestamp for receipts." },
      },
      additionalProperties: false,
    },
    expectedReceipts: [{
      operation: "adapter.lower",
      mode: "emits",
      required: true,
      artifactRoles: ["motion_package", "gltf_source", "adapter_lowering_receipt"],
    }],
  },
} satisfies MotionDebugCommandMetadata;
