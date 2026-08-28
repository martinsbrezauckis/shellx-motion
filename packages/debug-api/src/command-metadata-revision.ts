/**
 * Strict public contract for one bounded, atomic package revision.
 *
 * The `steps` union is deliberately closed. It is not a nested debug-command envelope: no step
 * can choose a package root, output path, receipt root, permission tier, or a command outside the
 * small data-only allowlist implemented by `domains/revision-transaction.ts`.
 */
import type { MotionDebugArgPropertySchema, MotionDebugCommandMetadata } from "./command-registry.js";
import { argsSchema } from "./command-metadata-shared.js";

const SHA256: MotionDebugArgPropertySchema = {
  type: "string",
  maxLength: 64,
  description: "Lowercase 64-character SHA-256 digest. The runtime rejects any other value."
};

const BASE: MotionDebugArgPropertySchema = {
  type: "object",
  required: ["packageId", "motionId", "manifestSha256", "motionSha256"],
  additionalProperties: false,
  description: "Exact identity and authored-document hashes observed on the source revision.",
  properties: {
    packageId: { type: "string", maxLength: 96, description: "Expected stable package id." },
    motionId: { type: "string", maxLength: 96, description: "Expected stable Motion document id." },
    manifestSha256: SHA256,
    motionSha256: SHA256
  }
};

const LAYER_ID: MotionDebugArgPropertySchema = { type: "string", maxLength: 256, description: "Target stable layer id." };
const EASING: MotionDebugArgPropertySchema = { type: "string", enumRef: "easing", description: "Named easing preset only; custom easing objects are not part of the transaction v1 allowlist." };

function step(
  command: string,
  required: string[],
  properties: Record<string, MotionDebugArgPropertySchema>
): MotionDebugArgPropertySchema {
  return {
    type: "object",
    required: ["command", ...required],
    additionalProperties: false,
    properties: {
      command: { type: "string", enum: [command], description: "Literal allowlisted revision operation." },
      ...properties
    }
  };
}

const STEPS: MotionDebugArgPropertySchema = {
  type: "array",
  minItems: 1,
  maxItems: 32,
  description: "Ordered, closed, data-only mutation steps. They run against one copied base package and publish once only when every step succeeds.",
  items: {
    type: "object",
    oneOf: [
      step("motion.timeline.layer.text.set", ["layerId", "text"], {
        layerId: LAYER_ID,
        text: { type: "string", maxLength: 16_384, description: "Replacement text." }
      }),
      step("motion.timeline.layer.name.set", ["layerId", "name"], {
        layerId: LAYER_ID,
        name: { type: "string", maxLength: 256, description: "Non-blank display name." }
      }),
      step("motion.timeline.layer.visibility.set", ["layerId", "visible"], {
        layerId: LAYER_ID,
        visible: { type: "boolean", description: "Whether the layer renders." }
      }),
      step("motion.timeline.layer.lock", ["layerId", "locked"], {
        layerId: LAYER_ID,
        locked: { type: "boolean", description: "Whether later edits to this layer are refused." }
      }),
      step("motion.timeline.keyframe.upsert", ["layerId", "target", "atMs", "value"], {
        layerId: LAYER_ID,
        target: { type: "string", enumRef: "keyframeTarget", description: "Existing typed keyframe target, including pathReveal targets." },
        atMs: { type: "number", minimum: 0, description: "Keyframe time in milliseconds." },
        value: { type: ["number", "string"], description: "Finite numeric value or supported typed string value for the selected target." },
        easing: EASING
      }),
      step("motion.timeline.keyframe.delete", ["layerId", "target", "atMs"], {
        layerId: LAYER_ID,
        target: { type: "string", enumRef: "keyframeTarget", description: "Existing typed keyframe target, including pathReveal targets." },
        atMs: { type: "number", minimum: 0, description: "Keyframe time in milliseconds." }
      }),
      step("motion.timeline.keyframe.move", ["layerId", "target", "fromMs", "toMs"], {
        layerId: LAYER_ID,
        target: { type: "string", enumRef: "keyframeTarget", description: "Existing typed keyframe target, including pathReveal targets." },
        fromMs: { type: "number", minimum: 0, description: "Current keyframe time in milliseconds." },
        toMs: { type: "number", minimum: 0, description: "New keyframe time in milliseconds." }
      }),
      step("motion.timeline.spatial.position.upsert", ["layerId", "atMs", "x", "y"], {
        layerId: LAYER_ID,
        atMs: { type: "number", minimum: 0, description: "Position time in milliseconds." },
        x: { type: "number", description: "Finite horizontal position in pixels." },
        y: { type: "number", description: "Finite vertical position in pixels." },
        easing: EASING
      }),
      step("motion.timeline.spatial.position.move", ["layerId", "fromMs", "toMs"], {
        layerId: LAYER_ID,
        fromMs: { type: "number", minimum: 0, description: "Current spatial position time in milliseconds." },
        toMs: { type: "number", minimum: 0, description: "New spatial position time in milliseconds." }
      }),
      step("motion.timeline.spatial.position.delete", ["layerId", "atMs"], {
        layerId: LAYER_ID,
        atMs: { type: "number", minimum: 0, description: "Spatial position time in milliseconds." }
      })
    ]
  }
};
const PLAN_STEPS: MotionDebugArgPropertySchema = {
  ...STEPS,
  description: "Ordered, closed, data-only mutation steps replayed only in memory to predict the final document. Planning writes no package or receipt."
};

export const REVISION_COMMAND_METADATA = {
  "motion.revision.transaction.plan": {
    argsSchema: argsSchema(["packageRoot", "base", "steps"], {
      packageRoot: { type: "string", maxLength: 4096, description: "Existing Motion package root, at most 4096 UTF-8 bytes with no NUL byte, inside host-configured authoring input roots." },
      base: BASE,
      steps: PLAN_STEPS
    })
  },
  "motion.revision.transaction": {
    argsSchema: argsSchema(["packageRoot", "outDir", "base", "steps"], {
      packageRoot: { type: "string", maxLength: 4096, description: "Source Motion package root, at most 4096 UTF-8 bytes with no NUL byte. It is never changed in place." },
      outDir: { type: "string", maxLength: 4096, description: "One absent or empty output directory outside packageRoot, at most 4096 UTF-8 bytes with no NUL byte. The completed revision is atomically published here." },
      base: BASE,
      steps: STEPS,
      createdBy: { type: "string", maxLength: 256, description: "Optional attribution recorded in the one aggregate package receipt." }
    }),
    expectedReceipts: [{
      operation: "revision.transaction",
      mode: "emits",
      required: true,
      artifactRoles: ["motion_package", "revision_transaction_receipt"]
    }]
  }
} satisfies MotionDebugCommandMetadata;
