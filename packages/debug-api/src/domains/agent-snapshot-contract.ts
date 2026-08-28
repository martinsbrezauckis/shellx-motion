/** Stable types and ceilings for the compact agent snapshot. */
import type { MotionJobView, MotionPackage } from "@shellx-motion/core";
import type { TimelineControlReadResult } from "./timeline-controls.js";

export const AGENT_SNAPSHOT_SCHEMA = "shellx-motion/agent-snapshot@1";
export const MAX_AGENT_SNAPSHOT_BYTES = 12_288;
export const MAX_AGENT_SNAPSHOT_REQUEST_SCALARS = 256;
export const MAX_AGENT_SNAPSHOT_ROOT_SCALARS = 4_096;
export const MAX_AGENT_SNAPSHOT_WARNINGS = 8;
export const MAX_AGENT_SNAPSHOT_WARNING_SCALARS = 240;
export const MAX_AGENT_SNAPSHOT_RECEIPTS = 4;
export const MAX_AGENT_SNAPSHOT_JOBS = 3;
export const MAX_AGENT_SNAPSHOT_NEAREST_ACTIONS = 3;
export const MAX_AGENT_SNAPSHOT_PLAN_STEPS = 12;
export const MAX_AGENT_SNAPSHOT_ID_SCALARS = 160;
export const MAX_AGENT_SNAPSHOT_LABEL_SCALARS = 160;
export const MAX_AGENT_SNAPSHOT_OPERATION_SCALARS = 96;
export const MAX_AGENT_SNAPSHOT_TIMESTAMP_SCALARS = 40;
export const MAX_AGENT_SNAPSHOT_ACTION_CALLS = 4;
export const MAX_AGENT_SNAPSHOT_PLAN_ARGUMENTS = 8;
export const MAX_AGENT_SNAPSHOT_PLAN_ARGUMENT_GROUPS = 2;
export const MAX_AGENT_SNAPSHOT_PLAN_ARGUMENT_ALTERNATIVES = 8;
export const MAX_AGENT_SNAPSHOT_PLAN_CAUTIONS = 3;
export const MAX_AGENT_SNAPSHOT_RECEIPT_DISCOVERY_ENTRIES = 10_000;
export const MAX_AGENT_SNAPSHOT_JOB_COUNT = 10_000;
export const MAX_AGENT_SNAPSHOT_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

export interface AgentSnapshotReceiptEntry {
  receipt: {
    id?: unknown;
    operation?: unknown;
    status?: unknown;
    packageId?: unknown;
    lane?: unknown;
    createdAt?: unknown;
    warnings?: unknown;
  };
}

export interface AgentSnapshotReceiptRead {
  entries: AgentSnapshotReceiptEntry[];
  /** False means the bounded traversal stopped early or could not read part of the configured store. */
  complete: boolean;
}

export interface AgentSnapshotServices {
  /** Injectable so tests never depend on the machine clock. It must return a valid Date. */
  now?: () => Date;
  engineVersion?: string;
  packageLoader?: (packageRoot: string) => Promise<MotionPackage>;
  /** Host-approved input roots; absence fails closed for caller-supplied packageRoot. */
  snapshotPackageRoots?: string[];
  /** Host-owned default receipt root. */
  receiptsRoot?: string;
  /** Every host root that can validate a caller-nominated receiptsRoot. */
  snapshotReceiptRoots?: string[];
  isPathInsideTrustedRoot?: (root: string, candidate: string) => Promise<boolean>;
  readSnapshotReceipts?: (receiptsRoot: string) => Promise<AgentSnapshotReceiptRead>;
  readSnapshotTimelineState?: (pkg: MotionPackage) => Promise<TimelineControlReadResult>;
  jobView?: MotionJobView | null;
  jobCallerId?: string;
}

export interface SourceFreshness {
  available: boolean;
  complete: boolean;
  observedAt: string;
}

export interface CompactAction {
  id: string;
  alias: string;
  permission: string;
  mutates: boolean;
  callCount: number;
  calls: string[];
}

export interface CompactPlanStep {
  order: number;
  command: string;
  permission: string;
  mutates: boolean;
  /** Present only for arguments required in every valid input shape. */
  requiredArgs?: string[];
  /** Schema-derived alternative groups required in addition to `requiredArgs`. */
  requiredArgGroups?: Array<{
    mode: "anyOf" | "oneOf";
    alternatives: string[][];
  }>;
}

export interface CompactReceipt {
  id: string;
  operation: string;
  status: "passed" | "failed" | "warning" | "not_run" | "other";
  createdAt: string;
  packageId?: string;
  lane?: string;
}

export interface CompactJob {
  id: string;
  state: "pending" | "running" | "succeeded" | "failed" | "cancelled" | "skipped";
  lifecycle: "pending" | "running" | "ended";
  operation: string;
  lane: string;
  outcome?: "succeeded" | "failed" | "cancelled" | "skipped";
  createdAtMs: number;
  pollAfterMs?: number;
  warningCount: number;
}

export interface CompactWarning {
  source: "package" | "timeline" | "receipts" | "jobs";
  message: string;
}

export interface CountTruncation {
  omitted: number;
  /** False means `omitted` is only a lower bound because source discovery was incomplete. */
  exact: boolean;
}

export interface SnapshotTruncation {
  valuesTruncated: boolean;
  warningsTruncated: boolean;
  receiptRows: CountTruncation;
  jobRows: CountTruncation;
  nearestActions: number;
  planSteps: number;
  receiptDiscoveryIncomplete: boolean;
}

export interface MotionAgentSnapshot {
  schema: typeof AGENT_SNAPSHOT_SCHEMA;
  snapshotId: string;
  observedAt: string;
  freshness: {
    cache: { scope: "private"; mode: "none"; maxAgeMs: 0 };
    package: SourceFreshness;
    timeline: SourceFreshness;
    receipts: SourceFreshness;
    jobs: SourceFreshness & { scope: "own" };
  };
  identity: {
    engineVersion: string;
    package?: { id: string; motionId: string; name?: string; fingerprint: string };
  };
  state: {
    packageOpen: boolean;
    motion?: {
      durationMs: number;
      fps: number;
      width: number;
      height: number;
      layerCount: number;
      assetCount: number;
      sceneCount: number;
      trackCount: number;
      markerCount: number;
      keyframeCount: number;
    };
    timeline?: {
      playheadMs: number;
      selectedRange?: { startMs: number; endMs: number };
      viewport?: { startMs: number; endMs: number; zoom?: number; pixelsPerSecond?: number };
    };
  };
  selection: { status: "unavailable"; persisted: false; reason: string };
  actions: {
    entrypoints: Array<{ command: string; permission: string; mutates: boolean }>;
    request?: {
      find: { matched: boolean; action?: CompactAction; nearest: CompactAction[] };
      guide: { equivalentTo: "plan" };
      plan: { steps: CompactPlanStep[]; cautionCount: number; cautions: string[] };
    };
  };
  receipts: {
    count: number;
    countExact: boolean;
    statusCounts: { passed: number; failed: number; warning: number; notRun: number; other: number };
    statusCountsExact: boolean;
    recent: CompactReceipt[];
  };
  jobs: { count: number; countExact: boolean; recent: CompactJob[] };
  warnings: CompactWarning[];
  truncation: SnapshotTruncation;
}
