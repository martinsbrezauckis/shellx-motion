/** Argument and receipt contracts for bounded timeline group/precomposition edits. */
import type { MotionDebugCommandMetadata } from "./command-registry.js";
import { argsSchema, editReceipt, PACKAGE_EDIT } from "./command-metadata-shared.js";

const EDIT = ["packageRoot", "outDir"];
const GROUP_ID = { groupId: { type: "string" as const, description: "Target group layer id." } };
const CHILD_LAYER_ID = { childLayerId: { type: "string" as const, description: "Direct child layer id." } };
const GROUP_INPUT = {
  group: {
    type: "object" as const,
    description: "Group layer data. Create requires a complete group with type group, startMs, durationMs, and childLayerIds; wrap derives those fields and accepts only id plus neutral metadata. Core validates all structure and bounds."
  }
};
const INDEX = { index: { type: "number" as const, minimum: 0, description: "Zero-based insertion or reorder index." } };

export const TIMELINE_GROUP_COMMAND_METADATA = {
  "motion.timeline.group.create": {
    argsSchema: argsSchema(EDIT.concat("group"), {
      ...PACKAGE_EDIT,
      ...GROUP_INPUT,
      layerIndex: { type: "number", minimum: 0, description: "Flat layer-store insertion index; appended when omitted." },
      parentGroupId: { type: "string", description: "Optional parent group id; omit for a root group." },
      childIndex: { type: "number", minimum: 0, description: "Insertion index in the parent group; appended when omitted." },
      trackIndex: { type: "number", minimum: 0, description: "Insertion index in the selected group track." }
    }),
    expectedReceipts: editReceipt("timeline.group.create")
  },
  "motion.timeline.group.child.add": {
    argsSchema: argsSchema([...EDIT, "groupId", "childLayerId"], {
      ...PACKAGE_EDIT, ...GROUP_ID, ...CHILD_LAYER_ID,
      index: { type: "number", minimum: 0, description: "Child insertion index; appended when omitted." }
    }),
    expectedReceipts: editReceipt("timeline.group.child.add")
  },
  "motion.timeline.group.child.remove": {
    argsSchema: argsSchema([...EDIT, "groupId", "childLayerId"], { ...PACKAGE_EDIT, ...GROUP_ID, ...CHILD_LAYER_ID }),
    expectedReceipts: editReceipt("timeline.group.child.remove")
  },
  "motion.timeline.group.child.move": {
    argsSchema: argsSchema([...EDIT, "sourceGroupId", "destinationGroupId", "childLayerId"], {
      ...PACKAGE_EDIT,
      sourceGroupId: { type: ["string", "null"], description: "Current direct parent id, or null when the child is a root layer. This must be explicit." },
      destinationGroupId: { type: "string", description: "Destination direct parent group id." },
      ...CHILD_LAYER_ID,
      index: { type: "number", minimum: 0, description: "Destination child insertion index; appended when omitted." }
    }),
    expectedReceipts: editReceipt("timeline.group.child.move")
  },
  "motion.timeline.group.child.reorder": {
    argsSchema: argsSchema([...EDIT, "groupId", "childLayerId", "index"], { ...PACKAGE_EDIT, ...GROUP_ID, ...CHILD_LAYER_ID, ...INDEX }),
    expectedReceipts: editReceipt("timeline.group.child.reorder")
  },
  "motion.timeline.group.wrap": {
    argsSchema: argsSchema([...EDIT, "group", "childLayerIds"], {
      ...PACKAGE_EDIT, ...GROUP_INPUT,
      childLayerIds: { type: "array", items: { type: "string", description: "Selected direct child layer id." }, minItems: 1, maxItems: 256, description: "One contiguous range of direct sibling ids. Input order is normalized to owner order." }
    }),
    expectedReceipts: editReceipt("timeline.group.wrap")
  },
  "motion.timeline.group.unwrap": {
    argsSchema: argsSchema([...EDIT, "groupId"], { ...PACKAGE_EDIT, ...GROUP_ID }),
    expectedReceipts: editReceipt("timeline.group.unwrap")
  },
  "motion.timeline.group.delete": {
    argsSchema: argsSchema([...EDIT, "groupId", "disposition"], {
      ...PACKAGE_EDIT, ...GROUP_ID,
      disposition: { type: "string", enum: ["cascade", "unwrap"], description: "Required child disposition: cascade deletes the full subtree; unwrap only succeeds for an exactly neutral group." }
    }),
    expectedReceipts: editReceipt("timeline.group.delete")
  },
  "motion.timeline.group.duplicate": {
    argsSchema: argsSchema([...EDIT, "groupId"], {
      ...PACKAGE_EDIT, ...GROUP_ID,
      newGroupId: { type: "string", description: "Optional deterministic id for the cloned root group." },
      offsetMs: { type: "number", minimum: 0, description: "Non-negative timeline offset for the cloned root group." }
    }),
    expectedReceipts: editReceipt("timeline.group.duplicate")
  },
  "motion.timeline.group.trim": {
    argsSchema: argsSchema([...EDIT, "groupId"], {
      ...PACKAGE_EDIT, ...GROUP_ID,
      startMs: { type: "number", minimum: 0, description: "Optional new group start in its direct owner's local timeline." },
      durationMs: { type: "number", exclusiveMinimum: 0, description: "Optional new positive group duration; every direct child must still fit." }
    }),
    expectedReceipts: editReceipt("timeline.group.trim")
  },
  "motion.timeline.group.root.reorder": {
    argsSchema: argsSchema([...EDIT, "groupId", "index"], { ...PACKAGE_EDIT, ...GROUP_ID, ...INDEX }),
    expectedReceipts: editReceipt("timeline.group.root.reorder")
  },
  "motion.timeline.group.split": {
    argsSchema: argsSchema([...EDIT, "groupId", "atMs"], {
      ...PACKAGE_EDIT, ...GROUP_ID,
      atMs: { type: "number", minimum: 0, description: "Split point in the direct owner's timeline; it must be strictly inside the group." },
      newGroupId: { type: "string", description: "Optional explicit id for the new tail group." }
    }),
    expectedReceipts: editReceipt("timeline.group.split")
  }
} satisfies MotionDebugCommandMetadata;
