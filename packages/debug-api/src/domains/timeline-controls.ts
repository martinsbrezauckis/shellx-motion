/** Persist timeline UI controls without following package-controlled links. */
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { escalateReceiptStatusForWarnings, hashBuffer, hashPackageFile, resolvePackageAsset, type MotionPackage, type OperationReceipt } from "@shellx-motion/core";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { nonNegativeNumberArg, positiveNumberArg, stringArg } from "./args.js";
import { callerReceiptsRootRefusal, type ReceiptsRootPolicyServices } from "./receipts-root-policy.js";
import { hasStableReceiptStoreCapability } from "../receipt-store-stable-reader.js";
import { MAX_TIMELINE_STATE_BYTES, persistTimelineControlState, type TimelineControlPersistenceServices, type TrustedTimelineStateDirectory } from "./timeline-control-persistence.js";

export interface TimelineRangeState {
  startMs: number;
  endMs: number;
}

export interface TimelineViewportState extends TimelineRangeState {
  zoom?: number;
  pixelsPerSecond?: number;
}

export interface TimelineControlState {
  schema: "shellx-motion/timeline-state@1";
  packageId: string;
  motionId: string;
  durationMs: number;
  playheadMs: number;
  selectedRange?: TimelineRangeState;
  viewport?: TimelineViewportState;
  updatedAt: string;
}

export interface TimelineControlReadResult {
  state: TimelineControlState;
  statePath: string;
  warnings: string[];
}

export interface TimelineControlServices extends ReceiptsRootPolicyServices {
  /**
   * The platform capability the host has admitted for durable timeline state.
   *
   * Production leaves this unset and therefore uses the actual runtime platform. Keeping it
   * injectable lets the domain prove its refusal boundary without mutating global process state.
   */
  timelineControlPersistencePlatform?: NodeJS.Platform;
  /** Host-only procfs test seam paired with `timelineControlPersistencePlatform`. */
  timelineControlPersistenceProcSelfFdUsable?: () => boolean;
  packageLoader?: (packageRoot: string) => Promise<MotionPackage>;
  readTimelineControls?: (pkg: MotionPackage) => Promise<TimelineControlReadResult>;
  writeTimelineControls?: (pkg: MotionPackage, state: TimelineControlState) => Promise<string>;
  writeReceipt?: (root: string, receipt: OperationReceipt) => Promise<string>;
}

export type { TimelineControlPersistenceServices } from "./timeline-control-persistence.js";

export async function dispatchTimelineControlCommand(
  command: MotionDebugCommand,
  args: unknown,
  services: TimelineControlServices
): Promise<MotionDebugResult | null> {
  if (command !== "motion.timeline.playhead.set"
    && command !== "motion.timeline.range.select"
    && command !== "motion.timeline.viewport.set") return null;
  const packageRoot = stringArg(args, "packageRoot");
  // The caller's value is kept separate from the host default so only the caller's is
  // fenced — see receipts-root-policy.ts for why the resolved value is the wrong thing to check.
  const requestedReceiptsRoot = stringArg(args, "receiptsRoot") ?? undefined;
  const receiptsRoot = requestedReceiptsRoot ?? services.receiptsRoot;
  if (!packageRoot) return invalidArgs(`${command} requires packageRoot.`);
  // Durable control state retains a no-follow directory descriptor through /proc before committing
  // the state file. That primitive is intentionally implemented only on Linux. Refuse before any
  // package load, control-state lookup, state-directory creation, or host receipt write, so a
  // non-Linux request is a pure capability response rather than a partial durable mutation.
  if (!hasStableReceiptStoreCapability(
    services.timelineControlPersistencePlatform,
    services.timelineControlPersistenceProcSelfFdUsable
  )) {
    return capabilityUnavailable("Timeline durable controls require Linux retained no-follow directory capability support.");
  }
  if (!services.packageLoader || !services.readTimelineControls || !services.writeTimelineControls) {
    return capabilityUnavailable("Safe timeline control persistence is unavailable.");
  }
  // These three commands are draft_motion — tier 2 of 6, below every tier that grants
  // writes — and each mirrors its receipt through the host writer, which mkdir -p's whatever root
  // it is handed. Refused here, before the package is even loaded, so a rejected root never
  // reaches the state write either.
  const receiptsRootRefusal = await callerReceiptsRootRefusal(command, requestedReceiptsRoot, services);
  if (receiptsRootRefusal) return receiptsRootRefusal;
  if (receiptsRoot && !services.writeReceipt) return capabilityUnavailable("Timeline control receipt persistence is unavailable.");

  try {
    const pkg = await services.packageLoader(packageRoot);
    const loaded = await services.readTimelineControls(pkg);
    const previousState = loaded.state;
    let nextState: TimelineControlState = {
      ...previousState,
      packageId: pkg.manifest.id,
      motionId: pkg.motion.id,
      durationMs: pkg.motion.durationMs,
      updatedAt: new Date().toISOString()
    };
    let operationOutput: Record<string, unknown>;
    let receiptPrefix: string;

    if (command === "motion.timeline.playhead.set") {
      const atMsArg = nonNegativeNumberArg(args, "atMs");
      const playheadArg = atMsArg !== null ? atMsArg : nonNegativeNumberArg(args, "playheadMs");
      if (playheadArg === null || playheadArg === false) return invalidArgs("playheadMs must be a non-negative number.");
      if (playheadArg > pkg.motion.durationMs) return invalidArgs("playheadMs must be within motion duration.");
      operationOutput = { playheadMs: playheadArg, previousPlayheadMs: previousState.playheadMs };
      nextState = { ...nextState, playheadMs: playheadArg };
      receiptPrefix = "timeline-playhead";
    } else if (command === "motion.timeline.range.select") {
      const startMs = nonNegativeNumberArg(args, "startMs");
      const endMs = nonNegativeNumberArg(args, "endMs");
      if (startMs === null || startMs === false) return invalidArgs("startMs must be a non-negative number.");
      if (endMs === null || endMs === false) return invalidArgs("endMs must be a non-negative number.");
      if (endMs < startMs) return invalidArgs("endMs must be greater than or equal to startMs.");
      if (endMs > pkg.motion.durationMs) return invalidArgs("selected range must be within motion duration.");
      const selectedRange = { startMs, endMs };
      operationOutput = { selectedRange, previousRange: previousState.selectedRange ?? null };
      nextState = { ...nextState, selectedRange };
      receiptPrefix = "timeline-range";
    } else {
      const startMs = nonNegativeNumberArg(args, "startMs");
      const endMs = nonNegativeNumberArg(args, "endMs");
      const zoom = positiveNumberArg(args, "zoom");
      const pixelsPerSecond = positiveNumberArg(args, "pixelsPerSecond");
      if (startMs === null || startMs === false) return invalidArgs("startMs must be a non-negative number.");
      if (endMs === null || endMs === false) return invalidArgs("endMs must be a non-negative number.");
      if (endMs <= startMs) return invalidArgs("viewport endMs must be greater than startMs.");
      if (endMs > pkg.motion.durationMs) return invalidArgs("viewport range must be within motion duration.");
      if (zoom === false) return invalidArgs("zoom must be a positive number.");
      if (pixelsPerSecond === false) return invalidArgs("pixelsPerSecond must be a positive number.");
      const viewport = {
        startMs,
        endMs,
        ...(zoom !== null ? { zoom } : {}),
        ...(pixelsPerSecond !== null ? { pixelsPerSecond } : {})
      };
      operationOutput = { viewport, previousViewport: previousState.viewport ?? null };
      nextState = { ...nextState, viewport };
      receiptPrefix = "timeline-viewport";
    }

    const manifestPath = resolvePackageAsset(pkg, "manifest.json");
    const motionPath = resolvePackageAsset(pkg, pkg.manifest.motion);
    const inputHashes = {
      "manifest.json": await hashPackageFile(manifestPath),
      [pkg.manifest.motion]: await hashPackageFile(motionPath),
      "timeline-state.previous": hashBuffer(Buffer.from(JSON.stringify(previousState), "utf8"))
    };
    const controls = visibleTimelineControlState(nextState, loaded.statePath);
    const output = {
      statePath: loaded.statePath,
      durationMs: pkg.motion.durationMs,
      controls,
      previousControls: visibleTimelineControlState(previousState, loaded.statePath),
      ...operationOutput
    };
    const receipt: OperationReceipt = {
      schema: "shellx-motion/receipt@1",
      id: `${receiptPrefix}-${pkg.manifest.id}-${hashBuffer(Buffer.from(JSON.stringify({ command, inputHashes, output }), "utf8")).slice(0, 16)}`,
      operation: command.replace("motion.", ""),
      // `loaded.warnings` ships on this receipt (see below), so the status has to account for it
      // rather than assert `passed` over the top of it.
      status: escalateReceiptStatusForWarnings("passed", loaded.warnings),
      packageId: pkg.manifest.id,
      inputHashes,
      createdAt: new Date().toISOString(),
      lane: "debug-api",
      output,
      warnings: loaded.warnings
    };

    // Persist only after all validation, hashing, and receipt construction succeeds.
    const statePath = await services.writeTimelineControls(pkg, nextState);
    if (statePath !== loaded.statePath) throw new Error("Timeline control writer returned an unexpected state path.");
    const hostReceiptPath = receiptsRoot ? await services.writeReceipt!(receiptsRoot, receipt) : undefined;
    return {
      ok: true,
      receiptId: receipt.id,
      visibleState: {
        panel: "timeline",
        operation: receipt.operation,
        packageId: pkg.manifest.id,
        motionId: pkg.motion.id,
        statePath,
        ...operationOutput,
        ...(hostReceiptPath ? { hostReceiptPath } : {})
      },
      result: {
        ok: true,
        packageId: pkg.manifest.id,
        motionId: pkg.motion.id,
        statePath,
        controls,
        ...operationOutput,
        receipt,
        ...(hostReceiptPath ? { hostReceiptPath } : {})
      },
      warnings: receipt.warnings
    };
  } catch (error) {
    return commandFailure("timeline_control_failed", error);
  }
}

export async function readTimelineControlState(pkg: MotionPackage): Promise<TimelineControlReadResult> {
  const statePath = timelineControlStatePath(pkg);
  const fallback = defaultTimelineControlState(pkg);
  try {
    const stateDir = await trustedStateDirectory(pkg, false);
    if (!stateDir) return { state: fallback, statePath, warnings: [] };
    const safeStatePath = join(stateDir.path, "timeline-state.json");
    const handle = await open(safeStatePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > MAX_TIMELINE_STATE_BYTES) throw new Error("Timeline control state is not a bounded regular file.");
      const text = await handle.readFile({ encoding: "utf8" });
      const after = await handle.stat();
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
        throw new Error("Timeline control state changed while being read.");
      }
      const parsed = JSON.parse(text);
      const state = normalizeTimelineControlState(parsed, pkg);
      if (!state) return { state: fallback, statePath, warnings: [`Ignored invalid timeline control state at ${statePath}.`] };
      return { state, statePath, warnings: [] };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { state: fallback, statePath, warnings: [] };
    return { state: fallback, statePath, warnings: [`Ignored unreadable timeline control state at ${statePath}.`] };
  }
}

export async function writeTimelineControlState(
  pkg: MotionPackage,
  state: TimelineControlState,
  services: TimelineControlPersistenceServices = {}
): Promise<string> {
  const stateDir = await trustedStateDirectory(pkg, true);
  if (!stateDir) throw new Error("Timeline control state directory could not be created.");
  await persistTimelineControlState(stateDir, state, () => trustedStateDirectory(pkg, false), services);
  return timelineControlStatePath(pkg);
}

export function visibleTimelineControlState(state: TimelineControlState, statePath: string): Record<string, unknown> {
  return {
    schema: state.schema,
    statePath,
    packageId: state.packageId,
    motionId: state.motionId,
    durationMs: state.durationMs,
    playheadMs: state.playheadMs,
    ...(state.selectedRange ? { selectedRange: state.selectedRange } : {}),
    ...(state.viewport ? { viewport: state.viewport } : {}),
    updatedAt: state.updatedAt
  };
}

async function trustedStateDirectory(pkg: MotionPackage, create: boolean): Promise<TrustedTimelineStateDirectory | null> {
  const packageRoot = await realpath(pkg.root);
  const path = join(packageRoot, ".shellx-motion");
  if (create) {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
  }
  let facts;
  try {
    facts = await lstat(path);
  } catch (error) {
    if (!create && errorCode(error) === "ENOENT") return null;
    throw error;
  }
  if (facts.isSymbolicLink() || !facts.isDirectory()) throw new Error("Timeline control state directory must be a real directory.");
  const canonical = await realpath(path);
  const rel = relative(packageRoot, canonical);
  if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
    throw new Error("Timeline control state directory escapes the package root.");
  }
  return { path: canonical, dev: facts.dev, ino: facts.ino };
}

function timelineControlStatePath(pkg: MotionPackage): string {
  return join(resolve(pkg.root), ".shellx-motion", "timeline-state.json");
}

function defaultTimelineControlState(pkg: MotionPackage): TimelineControlState {
  return {
    schema: "shellx-motion/timeline-state@1",
    packageId: pkg.manifest.id,
    motionId: pkg.motion.id,
    durationMs: pkg.motion.durationMs,
    playheadMs: 0,
    updatedAt: new Date().toISOString()
  };
}

function normalizeTimelineControlState(value: unknown, pkg: MotionPackage): TimelineControlState | null {
  const record = ownRecord(value);
  if (!record || record.schema !== "shellx-motion/timeline-state@1") return null;
  if (record.packageId !== pkg.manifest.id || record.motionId !== pkg.motion.id) return null;
  const playheadMs = readTimelineStateNumber(record.playheadMs);
  if (playheadMs === null || playheadMs > pkg.motion.durationMs) return null;
  const selectedRange = normalizeTimelineStateRange(record.selectedRange, pkg.motion.durationMs, false);
  const viewport = normalizeTimelineStateRange(record.viewport, pkg.motion.durationMs, true);
  return {
    schema: "shellx-motion/timeline-state@1",
    packageId: pkg.manifest.id,
    motionId: pkg.motion.id,
    durationMs: pkg.motion.durationMs,
    playheadMs,
    ...(selectedRange ? { selectedRange } : {}),
    ...(viewport ? { viewport } : {}),
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : new Date().toISOString()
  };
}

function normalizeTimelineStateRange(value: unknown, durationMs: number, viewport: false): TimelineRangeState | undefined;
function normalizeTimelineStateRange(value: unknown, durationMs: number, viewport: true): TimelineViewportState | undefined;
function normalizeTimelineStateRange(value: unknown, durationMs: number, viewport: boolean): TimelineRangeState | TimelineViewportState | undefined {
  if (value === undefined) return undefined;
  const record = ownRecord(value);
  if (!record) return undefined;
  const startMs = readTimelineStateNumber(record.startMs);
  const endMs = readTimelineStateNumber(record.endMs);
  if (startMs === null || endMs === null || endMs < startMs || endMs > durationMs) return undefined;
  if (viewport && endMs <= startMs) return undefined;
  const zoom = readTimelineStateNumber(record.zoom);
  const pixelsPerSecond = readTimelineStateNumber(record.pixelsPerSecond);
  return {
    startMs,
    endMs,
    ...(viewport && zoom !== null && zoom > 0 ? { zoom } : {}),
    ...(viewport && pixelsPerSecond !== null && pixelsPerSecond > 0 ? { pixelsPerSecond } : {})
  };
}

function ownRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}

function readTimelineStateNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

function invalidArgs(message: string): MotionDebugResult {
  return { ok: false, error: { code: "invalid_args", message }, warnings: [] };
}

function capabilityUnavailable(message: string): MotionDebugResult {
  return {
    ok: false,
    error: { code: "capability_unavailable", message, suggestedAction: "Configure the required host capability and retry." },
    warnings: []
  };
}

function commandFailure(code: string, error: unknown): MotionDebugResult {
  return { ok: false, error: { code, message: error instanceof Error ? error.message : String(error) }, warnings: [] };
}
