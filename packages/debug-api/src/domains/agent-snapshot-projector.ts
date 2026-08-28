/** Bounded field projectors used by the compact snapshot builder. */
import type { MotionJobStatus, MotionPackage } from "@shellx-motion/core";
import { findActionMatch, planAction, type MotionAction, type MotionActionPlanStep, type MotionActionSummary } from "@shellx-motion/actions";
import { debugCommandContract } from "../command-metadata.js";
import { requiredArgGroups } from "./agent-plan-arguments.js";
import type { TimelineControlReadResult } from "./timeline-controls.js";
import {
  type AgentSnapshotReceiptEntry, type CompactAction, type CompactReceipt, type CompactWarning,
  type MotionAgentSnapshot, type SnapshotTruncation, type SourceFreshness,
  MAX_AGENT_SNAPSHOT_ACTION_CALLS, MAX_AGENT_SNAPSHOT_ID_SCALARS, MAX_AGENT_SNAPSHOT_JOBS,
  MAX_AGENT_SNAPSHOT_LABEL_SCALARS, MAX_AGENT_SNAPSHOT_NEAREST_ACTIONS, MAX_AGENT_SNAPSHOT_OPERATION_SCALARS,
  MAX_AGENT_SNAPSHOT_PLAN_ARGUMENT_ALTERNATIVES, MAX_AGENT_SNAPSHOT_PLAN_ARGUMENT_GROUPS,
  MAX_AGENT_SNAPSHOT_PLAN_ARGUMENTS, MAX_AGENT_SNAPSHOT_PLAN_CAUTIONS, MAX_AGENT_SNAPSHOT_PLAN_STEPS,
  MAX_AGENT_SNAPSHOT_RECEIPTS, MAX_AGENT_SNAPSHOT_SAFE_INTEGER, MAX_AGENT_SNAPSHOT_TIMESTAMP_SCALARS,
  MAX_AGENT_SNAPSHOT_WARNINGS, MAX_AGENT_SNAPSHOT_WARNING_SCALARS,
} from "./agent-snapshot-contract.js";

export function buildActions(request: string | undefined, text: TextProjector, truncation: SnapshotTruncation): MotionAgentSnapshot["actions"] {
  const entrypoints = [
    { command: "motion.actions.find", permission: "read_motion", mutates: false },
    { command: "motion.actions.guide", permission: "read_motion", mutates: false },
    { command: "motion.actions.plan", permission: "read_motion", mutates: false }
  ];
  if (!request) return { entrypoints };
  const match = findActionMatch(request);
  const nearest = match.nearest.slice(0, MAX_AGENT_SNAPSHOT_NEAREST_ACTIONS).map((action) => compactAction(action, text));
  truncation.nearestActions = Math.max(0, match.nearest.length - nearest.length);
  const plan = planAction(request);
  const steps = plan.steps.slice(0, MAX_AGENT_SNAPSHOT_PLAN_STEPS).map((step) => compactPlanStep(step, text));
  truncation.planSteps = Math.max(0, plan.steps.length - steps.length);
  return {
    entrypoints,
    request: {
      // The request selects compact catalog facts but is never echoed into the result.
      find: { matched: match.matched, ...(match.action ? { action: compactAction(match.action, text) } : {}), nearest },
      guide: { equivalentTo: "plan" },
      plan: { steps, cautionCount: plan.cautions.length, cautions: plan.cautions.slice(0, MAX_AGENT_SNAPSHOT_PLAN_CAUTIONS).map((caution) => text(caution, MAX_AGENT_SNAPSHOT_LABEL_SCALARS)) }
    }
  };
}

export function buildReceipts(entries: AgentSnapshotReceiptEntry[], complete: boolean, text: TextProjector, truncation: SnapshotTruncation): MotionAgentSnapshot["receipts"] {
  const ordered = [...entries].sort((left, right) => receiptCreatedAt(right) < receiptCreatedAt(left) ? -1 : receiptCreatedAt(right) > receiptCreatedAt(left) ? 1 : 0);
  const statusCounts = { passed: 0, failed: 0, warning: 0, notRun: 0, other: 0 };
  for (const entry of entries) {
    switch (receiptStatus(entry.receipt.status)) {
      case "passed": statusCounts.passed += 1; break;
      case "failed": statusCounts.failed += 1; break;
      case "warning": statusCounts.warning += 1; break;
      case "not_run": statusCounts.notRun += 1; break;
      default: statusCounts.other += 1; break;
    }
  }
  const recent = ordered.slice(0, MAX_AGENT_SNAPSHOT_RECEIPTS).map(({ receipt }) => ({
    id: text(receipt.id ?? "unknown", MAX_AGENT_SNAPSHOT_ID_SCALARS), operation: text(receipt.operation ?? "unknown", MAX_AGENT_SNAPSHOT_OPERATION_SCALARS), status: receiptStatus(receipt.status), createdAt: text(receipt.createdAt ?? "unknown", MAX_AGENT_SNAPSHOT_TIMESTAMP_SCALARS),
    ...(typeof receipt.packageId === "string" ? { packageId: text(receipt.packageId, MAX_AGENT_SNAPSHOT_ID_SCALARS) } : {}), ...(typeof receipt.lane === "string" ? { lane: text(receipt.lane, 64) } : {})
  }));
  truncation.receiptRows = { omitted: Math.max(0, ordered.length - recent.length), exact: complete };
  return { count: entries.length, countExact: complete, statusCounts, statusCountsExact: complete, recent };
}

export function buildJobs(jobs: MotionJobStatus[], complete: boolean, text: TextProjector, truncation: SnapshotTruncation): MotionAgentSnapshot["jobs"] {
  const recent = jobs.slice(0, MAX_AGENT_SNAPSHOT_JOBS).map((job) => ({
    id: text(job.jobId, MAX_AGENT_SNAPSHOT_ID_SCALARS), state: job.state, lifecycle: job.lifecycle, operation: text(job.operation, MAX_AGENT_SNAPSHOT_OPERATION_SCALARS), lane: text(job.lane, 64),
    ...(job.outcome ? { outcome: job.outcome } : {}), createdAtMs: finiteNonNegativeInteger(job.createdAtMs), ...(job.pollAfterMs !== undefined ? { pollAfterMs: finiteNonNegativeInteger(job.pollAfterMs) } : {}), warningCount: Array.isArray(job.warnings) ? job.warnings.length : 0
  }));
  truncation.jobRows = { omitted: Math.max(0, jobs.length - recent.length), exact: complete };
  return { count: jobs.length, countExact: complete, recent };
}

export function motionFacts(pkg: MotionPackage): MotionAgentSnapshot["state"]["motion"] {
  const keyframeCount = pkg.motion.layers.reduce((total, layer) => total + Object.values(layer.keyframes ?? {}).reduce((count, frames) => count + (Array.isArray(frames) ? frames.length : 0), 0), 0);
  return { durationMs: finiteNonNegative(pkg.motion.durationMs), fps: finiteNonNegative(pkg.motion.fps), width: finiteNonNegative(pkg.motion.width), height: finiteNonNegative(pkg.motion.height), layerCount: pkg.motion.layers.length, assetCount: pkg.motion.assets.length, sceneCount: pkg.motion.scenes?.length ?? 0, trackCount: pkg.motion.tracks?.length ?? 0, markerCount: pkg.motion.markers?.length ?? 0, keyframeCount };
}

export function timelineFacts(timeline: TimelineControlReadResult): NonNullable<MotionAgentSnapshot["state"]["timeline"]> {
  const state = timeline.state;
  return { playheadMs: finiteNonNegative(state.playheadMs), ...(state.selectedRange ? { selectedRange: { startMs: finiteNonNegative(state.selectedRange.startMs), endMs: finiteNonNegative(state.selectedRange.endMs) } } : {}), ...(state.viewport ? { viewport: { startMs: finiteNonNegative(state.viewport.startMs), endMs: finiteNonNegative(state.viewport.endMs), ...(state.viewport.zoom !== undefined ? { zoom: finiteNonNegative(state.viewport.zoom) } : {}), ...(state.viewport.pixelsPerSecond !== undefined ? { pixelsPerSecond: finiteNonNegative(state.viewport.pixelsPerSecond) } : {}) } } : {}) };
}

export function sourceFreshness(available: boolean, complete: boolean, observedAt: string): SourceFreshness { return { available, complete, observedAt }; }
export type TextProjector = (value: unknown, limit: number) => string;

export function addWarning(warnings: CompactWarning[], warning: CompactWarning, roots: readonly string[], truncation: SnapshotTruncation): void {
  const message = compactText(warning.message, MAX_AGENT_SNAPSHOT_WARNING_SCALARS, roots, truncation);
  if (!message || warnings.some((entry) => entry.source === warning.source && entry.message === message)) return;
  if (warnings.length >= MAX_AGENT_SNAPSHOT_WARNINGS) { truncation.warningsTruncated = true; return; }
  warnings.push({ source: warning.source, message });
}

export function compactText(value: unknown, limit: number, roots: readonly string[], truncation: SnapshotTruncation): string {
  const safe = sanitizeText(typeof value === "string" ? value : String(value ?? ""), roots);
  const scalars = Array.from(safe);
  if (scalars.length <= limit) return safe || "unknown";
  truncation.valuesTruncated = true;
  return `${scalars.slice(0, Math.max(0, limit - 1)).join("")}…`;
}

function compactAction(action: MotionAction | MotionActionSummary, text: TextProjector): CompactAction {
  return { id: text(action.id, MAX_AGENT_SNAPSHOT_ID_SCALARS), alias: text("aliases" in action ? action.aliases[0] ?? action.id : action.primaryAlias, MAX_AGENT_SNAPSHOT_LABEL_SCALARS), permission: text(action.permission, 32), mutates: action.mutates, callCount: action.calls.length, calls: action.calls.slice(0, MAX_AGENT_SNAPSHOT_ACTION_CALLS).map((call) => text(call, MAX_AGENT_SNAPSHOT_OPERATION_SCALARS)) };
}

function compactPlanStep(step: MotionActionPlanStep, text: TextProjector) {
  const contract = debugCommandContract(step.call);
  const requiredArgs = [...new Set(contract?.argsSchema?.required ?? [])]
    .slice(0, MAX_AGENT_SNAPSHOT_PLAN_ARGUMENTS)
    .map((arg) => text(arg, 64));
  const groups = requiredArgGroups(contract?.argsSchema)
    .slice(0, MAX_AGENT_SNAPSHOT_PLAN_ARGUMENT_GROUPS)
    .map((group) => ({
      mode: group.mode,
      alternatives: group.alternatives
        .slice(0, MAX_AGENT_SNAPSHOT_PLAN_ARGUMENT_ALTERNATIVES)
        .map((alternative) => alternative.slice(0, MAX_AGENT_SNAPSHOT_PLAN_ARGUMENTS).map((arg) => text(arg, 64)))
    }));
  return {
    order: finiteNonNegativeInteger(step.order), command: text(step.call, MAX_AGENT_SNAPSHOT_OPERATION_SCALARS),
    permission: text(contract?.permission ?? "read_motion", 32), mutates: contract?.mutates ?? false,
    ...(requiredArgs.length > 0 ? { requiredArgs } : {}),
    ...(groups.length > 0 ? { requiredArgGroups: groups } : {})
  };
}

function receiptCreatedAt(entry: AgentSnapshotReceiptEntry): string { return typeof entry.receipt.createdAt === "string" ? entry.receipt.createdAt : ""; }
function receiptStatus(value: unknown): CompactReceipt["status"] { return value === "passed" || value === "failed" || value === "warning" || value === "not_run" ? value : "other"; }
function finiteNonNegative(value: unknown): number { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(value, MAX_AGENT_SNAPSHOT_SAFE_INTEGER) : 0; }
function finiteNonNegativeInteger(value: unknown): number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0; }

/** Remove terminal controls and absolute package, receipt, or artifact locations before bounding. */
function sanitizeText(value: string, roots: readonly string[]): string {
  let text = value;
  for (const root of roots) if (root) text = text.split(root).join("[path]");
  text = text.replace(/\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)?/g, "").replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "").replace(/\u001B./g, "");
  text = text.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ").replace(/file:\/\/[^\s<>'"`]+/gi, "[path]");
  return text.replace(/(^|[^A-Za-z0-9+.-])(?:[A-Za-z]:[\\/][^\s<>'"`]+|\\\\[^\s<>'"`]+|\/[^\s<>'"`]+)/g, "$1[path]").replace(/\s+/g, " ").trim();
}
