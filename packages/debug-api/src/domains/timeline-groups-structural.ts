/** Group/precomposition mutations composed with the shared atomic timeline package transaction. */
import {
  addMotionGroupChild,
  createMotionGroup,
  deleteMotionGroup,
  duplicateMotionGroupSubtree,
  moveMotionGroupChild,
  removeMotionGroupChild,
  reorderMotionGroupRoot,
  reorderMotionGroupChild,
  splitMotionGroupAtMs,
  trimMotionGroup,
  unwrapMotionGroup,
  wrapMotionGroupSelection,
  type MotionDocument,
  type MotionGroupWrapInput,
  type MotionLayer
} from "@shellx-motion/core";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import {
  isTimelineGroupCommand,
  readTimelineGroupIntent,
  type TimelineGroupIntent
} from "./timeline-groups.js";
import {
  commitAtomicTimelineMutation,
  isTimelineCommonEditResult,
  readTimelineCommonEditArgs,
  type TimelineCommonEditArgs,
  type TimelinePackageEditServices
} from "./timeline-package-edit.js";

export interface TimelineGroupsStructuralServices extends TimelinePackageEditServices {}

export async function dispatchTimelineGroupsStructuralCommand(
  command: MotionDebugCommand,
  args: unknown,
  services: TimelineGroupsStructuralServices
): Promise<MotionDebugResult | null> {
  if (!isTimelineGroupCommand(command)) return null;
  const parsed = readTimelineGroupIntent(command, args);
  if (!parsed) return null;
  if (!parsed.ok) return invalidArgs(parsed.problem);
  const common = readTimelineCommonEditArgs(command, args, services);
  if (isTimelineCommonEditResult(common)) return common;
  return commitGroupMutation(command, parsed.intent, common, services);
}

function commitGroupMutation(
  command: MotionDebugCommand,
  intent: TimelineGroupIntent,
  common: TimelineCommonEditArgs,
  services: TimelineGroupsStructuralServices
): Promise<MotionDebugResult> {
  const receiptStem = `timeline-group-${intent.kind}`;
  return commitAtomicTimelineMutation({
    ...common,
    command,
    receiptPrefix: receiptStem,
    receiptFileName: `${receiptStem}.receipt.json`,
    invalidCode: "timeline_group_invalid",
    failureCode: "timeline_group_failed",
    services,
    mutate: (pkg) => mutateGroup(pkg.motion, intent),
    outputFacts: groupFacts,
    visibleFacts: groupVisibleFacts,
    resultFacts: groupFacts
  });
}

function mutateGroup(motion: MotionDocument, intent: TimelineGroupIntent) {
  if (intent.kind === "create") {
    return createMotionGroup(motion, {
      group: intent.group as unknown as MotionLayer,
      ...(intent.layerIndex === undefined ? {} : { layerIndex: intent.layerIndex }),
      ...(intent.parentGroupId === undefined ? {} : { parentGroupId: intent.parentGroupId }),
      ...(intent.childIndex === undefined ? {} : { childIndex: intent.childIndex }),
      ...(intent.trackIndex === undefined ? {} : { trackIndex: intent.trackIndex })
    });
  }
  if (intent.kind === "child-add") return addMotionGroupChild(motion, intent);
  if (intent.kind === "child-remove") return removeMotionGroupChild(motion, intent);
  if (intent.kind === "child-move") return moveMotionGroupChild(motion, intent);
  if (intent.kind === "child-reorder") return reorderMotionGroupChild(motion, intent);
  if (intent.kind === "wrap") return wrapMotionGroupSelection(motion, { group: intent.group as unknown as MotionGroupWrapInput["group"], childLayerIds: intent.childLayerIds });
  if (intent.kind === "unwrap") return unwrapMotionGroup(motion, intent);
  if (intent.kind === "delete") return deleteMotionGroup(motion, intent);
  if (intent.kind === "duplicate") return duplicateMotionGroupSubtree(motion, intent);
  if (intent.kind === "trim") return trimMotionGroup(motion, intent);
  if (intent.kind === "root-reorder") return reorderMotionGroupRoot(motion, intent);
  return splitMotionGroupAtMs(motion, intent);
}

function groupFacts(mutation: { motion: MotionDocument }): Record<string, unknown> {
  const { motion: _motion, ...facts } = mutation;
  return facts;
}

function groupVisibleFacts(mutation: { motion: MotionDocument }): Record<string, unknown> {
  const facts = groupFacts(mutation);
  return {
    action: facts.action,
    changedPaths: facts.changedPaths,
    ...(typeof facts.groupId === "string" ? { groupId: facts.groupId } : {}),
    ...(typeof facts.childLayerId === "string" ? { childLayerId: facts.childLayerId } : {}),
    ...(typeof facts.newGroupId === "string" ? { newGroupId: facts.newGroupId } : {})
  };
}

function invalidArgs(message: string): MotionDebugResult {
  return { ok: false, error: { code: "invalid_args", message }, warnings: [] };
}
