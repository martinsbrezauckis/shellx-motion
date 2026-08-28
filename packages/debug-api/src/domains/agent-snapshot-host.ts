/** Host-only assembly for the compact read-only agent snapshot. */
import { loadMotionPackage, MotionJobView } from "@shellx-motion/core";
import type { AgentSnapshotReceiptRead, AgentSnapshotServices } from "./agent-snapshot-contract.js";
import { buildMotionAgentSnapshot } from "./agent-snapshot.js";
import { readTimelineControlState } from "./timeline-controls.js";
import { MOTION_ENGINE_VERSION } from "../version.js";

/** The small host context the snapshot is allowed to consult. */
export interface AgentSnapshotHostContext {
  snapshotPackageRoots?: string[];
  receiptsRoot?: string;
  scratchRoot?: string;
  operatorReceiptRoots?: string[];
  jobView?: MotionJobView | null;
}

export interface AgentSnapshotHostBindings {
  isPathInsideTrustedRoot: NonNullable<AgentSnapshotServices["isPathInsideTrustedRoot"]>;
  readSnapshotReceipts: (receiptsRoot: string) => Promise<AgentSnapshotReceiptRead>;
  /** Server-generated/authenticated job owner, when the caller is allowed to see job state. */
  jobCallerId?: string;
}

/** Build one governed service bag for the Debug command and fixed MCP resource alike. */
export function agentSnapshotHostServices(
  context: AgentSnapshotHostContext,
  bindings: AgentSnapshotHostBindings
): AgentSnapshotServices {
  return {
    engineVersion: MOTION_ENGINE_VERSION,
    packageLoader: loadMotionPackage,
    snapshotPackageRoots: context.snapshotPackageRoots,
    receiptsRoot: context.receiptsRoot,
    snapshotReceiptRoots: snapshotReceiptRoots(context),
    isPathInsideTrustedRoot: bindings.isPathInsideTrustedRoot,
    readSnapshotReceipts: bindings.readSnapshotReceipts,
    readSnapshotTimelineState: readTimelineControlState,
    jobView: context.jobView === null ? null : context.jobView ?? new MotionJobView(),
    jobCallerId: bindings.jobCallerId
  };
}

/** Read the shared projection without routing a caller-selected Debug command. */
export async function readMotionAgentSnapshotFromHost(
  args: { packageRoot?: string; receiptsRoot?: string },
  services: AgentSnapshotServices
) {
  return await buildMotionAgentSnapshot(args, services);
}

function snapshotReceiptRoots(context: AgentSnapshotHostContext): string[] {
  return [context.receiptsRoot, context.scratchRoot, ...(context.operatorReceiptRoots ?? [])]
    .filter((root): root is string => Boolean(root));
}
