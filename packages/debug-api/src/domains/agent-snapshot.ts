/** Build the compact read-only agent snapshot from host-governed sources. */
import { canonicalJson, canonicalJsonSha256, type MotionJobStatus, type MotionPackage } from "@shellx-motion/core";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { assertConfiguredAuthoringInputRoot, AuthoringRootPolicyError } from "./authoring-root-policy.js";
import {
  type AgentSnapshotReceiptRead, type AgentSnapshotServices, type CompactWarning, type MotionAgentSnapshot,
  type SnapshotTruncation, MAX_AGENT_SNAPSHOT_BYTES, MAX_AGENT_SNAPSHOT_ID_SCALARS,
  MAX_AGENT_SNAPSHOT_JOB_COUNT, MAX_AGENT_SNAPSHOT_LABEL_SCALARS, MAX_AGENT_SNAPSHOT_RECEIPT_DISCOVERY_ENTRIES,
  MAX_AGENT_SNAPSHOT_REQUEST_SCALARS, MAX_AGENT_SNAPSHOT_ROOT_SCALARS, MAX_AGENT_SNAPSHOT_WARNINGS,
  AGENT_SNAPSHOT_SCHEMA,
} from "./agent-snapshot-contract.js";
import { addWarning, buildActions, buildJobs, buildReceipts, compactText, motionFacts, sourceFreshness, timelineFacts } from "./agent-snapshot-projector.js";

export {
  AGENT_SNAPSHOT_SCHEMA, MAX_AGENT_SNAPSHOT_BYTES, MAX_AGENT_SNAPSHOT_REQUEST_SCALARS,
  MAX_AGENT_SNAPSHOT_ROOT_SCALARS, MAX_AGENT_SNAPSHOT_WARNINGS, MAX_AGENT_SNAPSHOT_WARNING_SCALARS,
  MAX_AGENT_SNAPSHOT_RECEIPTS, MAX_AGENT_SNAPSHOT_JOBS, MAX_AGENT_SNAPSHOT_NEAREST_ACTIONS,
  MAX_AGENT_SNAPSHOT_PLAN_STEPS,
} from "./agent-snapshot-contract.js";
export { AGENT_SNAPSHOT_SCHEMA_DOCUMENT } from "./agent-snapshot-schema.js";
export type { AgentSnapshotReceiptEntry, AgentSnapshotReceiptRead, AgentSnapshotServices, MotionAgentSnapshot } from "./agent-snapshot-contract.js";

/** Keep the agent-domain route beside the snapshot contract and projector. */
export async function dispatchMotionAgentSnapshot(command: MotionDebugCommand, args: unknown, services: AgentSnapshotServices): Promise<MotionDebugResult | null> {
  return command === "motion.agent.snapshot" ? await buildMotionAgentSnapshot(args, services) : null;
}

/** Build the shared value used by the debug command and the fixed MCP resource. */
export async function buildMotionAgentSnapshot(args: unknown, services: AgentSnapshotServices): Promise<MotionDebugResult> {
  const input = readInput(args);
  if (!input.ok) return input.result;
  const observedAt = snapshotObservedAt(services.now);
  if (!observedAt) return unavailable("Motion agent snapshot requires a valid host observation clock.");

  const truncation: SnapshotTruncation = {
    valuesTruncated: false, warningsTruncated: false, receiptRows: { omitted: 0, exact: true }, jobRows: { omitted: 0, exact: true },
    nearestActions: 0, planSteps: 0, receiptDiscoveryIncomplete: false
  };
  const warnings: CompactWarning[] = [];
  const warningRoots = [input.packageRoot, input.receiptsRoot, services.receiptsRoot].filter((value): value is string => Boolean(value));
  const text = (value: unknown, limit: number): string => compactText(value, limit, warningRoots, truncation);
  let pkg: MotionPackage | undefined;

  if (input.packageRoot) {
    if (!services.packageLoader || !services.snapshotPackageRoots?.length) return unavailable("Motion agent snapshot package reading requires host-approved snapshot package roots.");
    try {
      await assertConfiguredAuthoringInputRoot(input.packageRoot, services.snapshotPackageRoots);
      pkg = await services.packageLoader(input.packageRoot);
      // Recheck the loader's canonical root so it cannot resolve an approved spelling elsewhere.
      await assertConfiguredAuthoringInputRoot(pkg.root, services.snapshotPackageRoots);
      warningRoots.push(pkg.root);
    } catch (error) {
      if (error instanceof AuthoringRootPolicyError) return { ok: false, error: { code: error.code, message: "motion.agent.snapshot packageRoot is not inside an approved host snapshot package root." }, warnings: [] };
      return { ok: false, error: { code: "invalid_args", message: "Motion agent snapshot could not load the approved package." }, warnings: [] };
    }
  }

  const receiptsRoot = input.receiptsRoot ?? services.receiptsRoot;
  if (input.receiptsRoot) {
    try {
      const roots = services.snapshotReceiptRoots ?? [];
      const admitted = services.isPathInsideTrustedRoot ? await Promise.all(roots.map(async (root) => await services.isPathInsideTrustedRoot!(root, input.receiptsRoot!))) : [];
      if (!admitted.some(Boolean)) return receiptRootRefusal();
    } catch { return receiptRootRefusal(); }
  }
  if (receiptsRoot) warningRoots.push(receiptsRoot);

  let receiptRead: AgentSnapshotReceiptRead = { entries: [], complete: false };
  let receiptReadAttempted = false;
  if (receiptsRoot && services.readSnapshotReceipts) {
    receiptReadAttempted = true;
    try {
      receiptRead = await services.readSnapshotReceipts(receiptsRoot);
      if (!Array.isArray(receiptRead.entries)) receiptRead = { entries: [], complete: false };
    } catch { receiptRead = { entries: [], complete: false }; }
  }
  if (receiptRead.entries.length > MAX_AGENT_SNAPSHOT_RECEIPT_DISCOVERY_ENTRIES) receiptRead = { entries: receiptRead.entries.slice(0, MAX_AGENT_SNAPSHOT_RECEIPT_DISCOVERY_ENTRIES), complete: false };
  if (receiptReadAttempted && !receiptRead.complete) {
    truncation.receiptDiscoveryIncomplete = true;
    addWarning(warnings, { source: "receipts", message: "Receipt discovery is incomplete." }, warningRoots, truncation);
  }

  let timeline: Awaited<ReturnType<NonNullable<AgentSnapshotServices["readSnapshotTimelineState"]>>> | undefined;
  let timelineComplete = false;
  if (pkg && services.readSnapshotTimelineState) {
    try {
      timeline = await services.readSnapshotTimelineState(pkg);
      timelineComplete = timeline.warnings.length === 0;
      for (const warning of timeline.warnings) addWarning(warnings, { source: "timeline", message: warning }, warningRoots, truncation);
    } catch { addWarning(warnings, { source: "timeline", message: "Persisted timeline controls are temporarily unavailable." }, warningRoots, truncation); }
  }

  let jobs: MotionJobStatus[] = [];
  let jobsComplete = false;
  if (services.jobView && services.jobCallerId?.trim()) {
    try {
      // No list limit: the core bounded store provides an exact caller-visible count.
      jobs = await services.jobView.list({ callerId: services.jobCallerId, scope: "own" });
      jobsComplete = true;
    } catch { addWarning(warnings, { source: "jobs", message: "Job snapshot is temporarily unavailable." }, warningRoots, truncation); }
  } else if (services.jobView) {
    // A label or a transport name is not a principal. Do not turn the missing identity into a
    // shared "unattributed" owner and leak its jobs through a read-only snapshot.
    addWarning(warnings, { source: "jobs", message: "Job snapshot is unavailable because this caller has no authenticated owner principal." }, warningRoots, truncation);
  }
  if (jobs.length > MAX_AGENT_SNAPSHOT_JOB_COUNT) {
    jobs = jobs.slice(0, MAX_AGENT_SNAPSHOT_JOB_COUNT);
    jobsComplete = false;
    addWarning(warnings, { source: "jobs", message: "Job discovery exceeded the compact snapshot bound." }, warningRoots, truncation);
  }

  const snapshot: Omit<MotionAgentSnapshot, "snapshotId" | "observedAt"> = {
    schema: AGENT_SNAPSHOT_SCHEMA,
    freshness: {
      cache: { scope: "private", mode: "none", maxAgeMs: 0 },
      package: sourceFreshness(Boolean(pkg), Boolean(pkg), observedAt),
      timeline: sourceFreshness(Boolean(pkg && services.readSnapshotTimelineState), timelineComplete, observedAt),
      receipts: sourceFreshness(receiptReadAttempted, receiptReadAttempted && receiptRead.complete, observedAt),
      jobs: { ...sourceFreshness(Boolean(services.jobView && services.jobCallerId?.trim()), jobsComplete, observedAt), scope: "own" }
    },
    identity: {
      engineVersion: text(services.engineVersion ?? "unknown", MAX_AGENT_SNAPSHOT_LABEL_SCALARS),
      ...(pkg ? { package: {
        id: text(pkg.manifest.id, MAX_AGENT_SNAPSHOT_ID_SCALARS), motionId: text(pkg.motion.id, MAX_AGENT_SNAPSHOT_ID_SCALARS),
        ...(pkg.manifest.name ? { name: text(pkg.manifest.name, MAX_AGENT_SNAPSHOT_LABEL_SCALARS) } : {}),
        // Canonical package content, never root location, is the package identity authority.
        fingerprint: canonicalJsonSha256({ manifest: pkg.manifest, motion: pkg.motion })
      } } : {})
    },
    state: { packageOpen: Boolean(pkg), ...(pkg ? { motion: motionFacts(pkg) } : {}), ...(timeline ? { timeline: timelineFacts(timeline) } : {}) },
    selection: { status: "unavailable", persisted: false, reason: "Selection is not persisted by Motion; motion.select and motion.highlight only report the supplied target." },
    actions: buildActions(input.request, text, truncation), receipts: buildReceipts(receiptRead.entries, receiptRead.complete, text, truncation), jobs: buildJobs(jobs, jobsComplete, text, truncation), warnings, truncation
  };

  for (const entry of receiptRead.entries) {
    const receiptWarnings = Array.isArray(entry.receipt.warnings) ? entry.receipt.warnings : [];
    for (const warning of receiptWarnings) {
      if (warnings.length >= MAX_AGENT_SNAPSHOT_WARNINGS) { truncation.warningsTruncated = true; break; }
      addWarning(warnings, { source: "receipts", message: warning }, warningRoots, truncation);
    }
    if (truncation.warningsTruncated) break;
  }

  const complete: MotionAgentSnapshot = { ...snapshot, snapshotId: canonicalJsonSha256(snapshotIdentityProjection(snapshot)), observedAt };
  if (Buffer.byteLength(canonicalJson(complete), "utf8") > MAX_AGENT_SNAPSHOT_BYTES) return { ok: false, error: { code: "snapshot_too_large", message: "Motion agent snapshot exceeded its fixed 12288-byte output budget." }, warnings: [] };
  return { ok: true, result: complete, warnings: complete.warnings.map((warning) => warning.message) };
}

/** Identity deliberately excludes every observation clock; persisted `createdAt` remains content. */
function snapshotIdentityProjection(snapshot: Omit<MotionAgentSnapshot, "snapshotId" | "observedAt">): Record<string, unknown> {
  const { observedAt: _package, ...packageFreshness } = snapshot.freshness.package;
  const { observedAt: _timeline, ...timelineFreshness } = snapshot.freshness.timeline;
  const { observedAt: _receipts, ...receiptFreshness } = snapshot.freshness.receipts;
  const { observedAt: _jobs, ...jobFreshness } = snapshot.freshness.jobs;
  return { schema: snapshot.schema, freshness: { cache: snapshot.freshness.cache, package: packageFreshness, timeline: timelineFreshness, receipts: receiptFreshness, jobs: jobFreshness }, identity: snapshot.identity, state: snapshot.state, selection: snapshot.selection, actions: snapshot.actions, receipts: snapshot.receipts, jobs: snapshot.jobs, warnings: snapshot.warnings, truncation: snapshot.truncation };
}

function readInput(args: unknown): { ok: true; packageRoot?: string; receiptsRoot?: string; request?: string } | { ok: false; result: MotionDebugResult } {
  if (args === undefined || args === null) return { ok: true };
  if (typeof args !== "object" || Array.isArray(args)) return invalidSnapshotArgs();
  const prototype = Object.getPrototypeOf(args);
  if (prototype !== Object.prototype && prototype !== null) return invalidSnapshotArgs();
  const allowed = new Set(["packageRoot", "receiptsRoot", "request"]);
  const fields = new Map<string, PropertyDescriptor>();
  for (const key of Reflect.ownKeys(args)) {
    if (typeof key !== "string" || !allowed.has(key)) return invalidSnapshotArgs();
    const descriptor = Object.getOwnPropertyDescriptor(args, key);
    // Do not invoke caller-owned accessors while validating a data-only snapshot request.
    if (!descriptor || !("value" in descriptor)) return invalidSnapshotArgs();
    fields.set(key, descriptor);
  }
  const read = (name: "packageRoot" | "receiptsRoot" | "request", limit: number): string | undefined | null => {
    const value = fields.get(name)?.value;
    return value === undefined || value === null ? undefined : typeof value === "string" && Array.from(value).length <= limit ? value : null;
  };
  const packageRoot = read("packageRoot", MAX_AGENT_SNAPSHOT_ROOT_SCALARS);
  const receiptsRoot = read("receiptsRoot", MAX_AGENT_SNAPSHOT_ROOT_SCALARS);
  const request = read("request", MAX_AGENT_SNAPSHOT_REQUEST_SCALARS);
  if (packageRoot === null || receiptsRoot === null || request === null) return invalidSnapshotArgs();
  return { ok: true, ...(packageRoot ? { packageRoot } : {}), ...(receiptsRoot ? { receiptsRoot } : {}), ...(request ? { request } : {}) };
}

function receiptRootRefusal(): MotionDebugResult { return { ok: false, error: { code: "invalid_args", message: "motion.agent.snapshot receiptsRoot is not inside a trusted host receipts root." }, warnings: [] }; }
function invalidSnapshotArgs(): { ok: false; result: MotionDebugResult } { return { ok: false, result: { ok: false, error: { code: "invalid_args", message: "motion.agent.snapshot accepts only own bounded string packageRoot, receiptsRoot, and request arguments." }, warnings: [] } }; }
function snapshotObservedAt(now: AgentSnapshotServices["now"]): string | null { const value = (now ?? (() => new Date()))(); return value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : null; }
function unavailable(message: string): MotionDebugResult { return { ok: false, error: { code: "capability_unavailable", message, suggestedAction: "Ask the host operator to configure the required read-only snapshot roots." }, warnings: [] }; }
