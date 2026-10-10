import type { Stats } from "node:fs";
import { canonicalJson } from "./canonical-json";
import { motionJobOwnerKey } from "./job-id-file";
import { isMotionJobLeaseRunNonce } from "./job-lease-run-storage";
import { assertMotionJobId } from "./job-registry";
import { closedRecord, closedRecordWithOptional, opaqueText, sha256 } from "./lifecycle-envelope-validation";

export const CLAIM_FILE = "claim.json";
export const MAX_CLAIM_BYTES = 2_048;

const POINTER_SCHEMA = "shellx-motion/job-identity-claim-pointer@1";
const STATE_SCHEMA = "shellx-motion/job-identity-claim@1";
const CALLER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const PHASES = [
  "claimed",
  "admission_bound",
  "plan_bound",
  "host_lease_published",
  "submitted",
  "executing",
  // Records that terminal-event publication began. Peer replay still requires claim release plus
  // durable terminal proof; phase itself is diagnostic evidence, not replay authority.
  "settling",
  "terminal_evidence",
  "terminal_recorded"
] as const;

export type MotionJobIdentityClaimPhase = typeof PHASES[number];

/** Only path-free class/fingerprint data may be retained in a private claim. */
export type MotionJobIdentityClaimAdmissionIntent =
  | Readonly<{ mode: "legacy-planless" }>
  | Readonly<{ mode: "planned"; planFingerprint: string }>;

/** A path-free view used only by the trusted caller deciding whether a dead owner may recover. */
export interface MotionJobIdentityClaimSnapshot {
  readonly admission: MotionJobIdentityClaimAdmissionIntent;
  readonly phase: MotionJobIdentityClaimPhase;
  readonly pid: number;
  readonly claimedAtMs: number;
  readonly heartbeatAtMs: number;
}

export type MotionJobIdentityClaimRecoveryDecision = "takeover" | "refuse";

export interface MotionJobIdentityClaimStoreServices {
  /** Trusted host-owned root. It is never derived from a submitted job request. */
  readonly claimRoot?: string;
  readonly now?: () => number;
  readonly pid?: number;
  /** `true` includes EPERM: uncertainty must retain an existing claim. */
  readonly isProcessAlive?: (pid: number) => boolean;
}

export interface MotionJobIdentityClaimAcquireInput {
  readonly callerId: string;
  readonly jobId: string;
  readonly admission: MotionJobIdentityClaimAdmissionIntent;
  /** A dead holder is only reclaimed through this explicit lifecycle policy. */
  readonly recoverDeadOwner?: (claim: MotionJobIdentityClaimSnapshot) => MotionJobIdentityClaimRecoveryDecision;
}

export type MotionJobIdentityClaimAcquireFailure = Readonly<{
  ok: false;
  code: "claim_conflict" | "claim_held" | "claim_recovery_required" | "claim_recovery_refused" | "claim_invalid" | "claim_unavailable";
  claim?: MotionJobIdentityClaimSnapshot;
}>;

export type MotionJobIdentityClaimMutationResult =
  | Readonly<{ ok: true; claim: MotionJobIdentityClaimSnapshot }>
  | Readonly<{ ok: false; code: "claim_lost" | "claim_invalid" | "claim_phase_invalid" | "claim_unavailable" }>;

export type MotionJobIdentityClaimReleaseResult =
  | Readonly<{ ok: true; released: true }>
  | Readonly<{ ok: false; code: "claim_lost" | "claim_invalid" | "claim_unavailable" }>;

export interface ClaimIdentity {
  readonly callerId: string;
  readonly jobId: string;
  readonly ownerKey: string;
}

export interface ClaimToken extends ClaimIdentity {
  readonly runNonce: string;
  readonly pid: number;
}

export interface StoredPointer extends ClaimToken {
  readonly admission: MotionJobIdentityClaimAdmissionIntent;
  readonly claimedAtMs: number;
}

export interface StoredState extends StoredPointer {
  readonly heartbeatAtMs: number;
  readonly phase: MotionJobIdentityClaimPhase;
}

export type PointerRead =
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "invalid" }>
  | Readonly<{ kind: "pointer"; pointer: StoredPointer; metadata: Stats }>;

export type CurrentRead =
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "invalid" }>
  | Readonly<{ kind: "current"; pointer: StoredPointer; pointerMetadata: Stats; state: StoredState }>;

export function claimIdentity(callerId: unknown, jobId: unknown): ClaimIdentity {
  const normalizedCallerId = assertCallerId(callerId);
  const normalizedJobId = assertMotionJobId(typeof jobId === "string" ? jobId : "");
  return Object.freeze({ callerId: normalizedCallerId, jobId: normalizedJobId, ownerKey: motionJobOwnerKey(normalizedCallerId, normalizedJobId) });
}

export function parsePointer(value: unknown): StoredPointer {
  const record = closedRecord(value, ["schema", "callerId", "jobId", "runNonce", "pid", "claimedAtMs", "admission"], "Motion job identity claim pointer");
  if (record.schema !== POINTER_SCHEMA) throw new Error("Unsupported motion job identity claim pointer schema.");
  const identity = claimIdentity(record.callerId, record.jobId);
  return Object.freeze({
    ...identity,
    runNonce: claimRunNonce(record.runNonce),
    pid: positiveInteger(record.pid, "Motion job identity claim pid"),
    claimedAtMs: nonNegativeInteger(record.claimedAtMs, "Motion job identity claim claimedAtMs"),
    admission: parseAdmission(record.admission)
  });
}

export function parseState(value: unknown): StoredState {
  const record = closedRecord(
    value,
    ["schema", "callerId", "jobId", "runNonce", "pid", "claimedAtMs", "heartbeatAtMs", "admission", "phase"],
    "Motion job identity claim"
  );
  if (record.schema !== STATE_SCHEMA) throw new Error("Unsupported motion job identity claim schema.");
  const pointer = parsePointer({
    schema: POINTER_SCHEMA, callerId: record.callerId, jobId: record.jobId, runNonce: record.runNonce,
    pid: record.pid, claimedAtMs: record.claimedAtMs, admission: record.admission
  });
  const heartbeatAtMs = nonNegativeInteger(record.heartbeatAtMs, "Motion job identity claim heartbeatAtMs");
  if (heartbeatAtMs < pointer.claimedAtMs) throw new Error("Motion job identity claim heartbeat precedes its claim.");
  return Object.freeze({ ...pointer, heartbeatAtMs, phase: parsePhase(record.phase) });
}

export function parseAdmission(value: unknown): MotionJobIdentityClaimAdmissionIntent {
  const record = closedRecordWithOptional(value, ["mode"], ["planFingerprint"], "Motion job identity claim admission");
  if (record.mode === "legacy-planless" && record.planFingerprint === undefined) return Object.freeze({ mode: "legacy-planless" });
  if (record.mode !== "planned" || record.planFingerprint === undefined) throw new Error("Motion job identity claim admission mode is invalid.");
  return Object.freeze({ mode: "planned", planFingerprint: sha256(record.planFingerprint, "Motion job identity claim planFingerprint") });
}

export function serializePointer(pointer: StoredPointer): string {
  return serialize({ admission: pointer.admission, callerId: pointer.callerId, claimedAtMs: pointer.claimedAtMs, jobId: pointer.jobId,
    pid: pointer.pid, runNonce: pointer.runNonce, schema: POINTER_SCHEMA });
}

export function serializeState(state: StoredState): string {
  return serialize({ admission: state.admission, callerId: state.callerId, claimedAtMs: state.claimedAtMs, heartbeatAtMs: state.heartbeatAtMs,
    jobId: state.jobId, phase: state.phase, pid: state.pid, runNonce: state.runNonce, schema: STATE_SCHEMA });
}

export function snapshot(state: StoredState): MotionJobIdentityClaimSnapshot {
  return Object.freeze({ admission: state.admission, phase: state.phase, pid: state.pid, claimedAtMs: state.claimedAtMs, heartbeatAtMs: state.heartbeatAtMs });
}

export function samePointer(left: StoredPointer, right: StoredPointer): boolean {
  return sameToken(left, right) && left.claimedAtMs === right.claimedAtMs && sameAdmission(left.admission, right.admission);
}

export function sameToken(left: Pick<ClaimToken, "callerId" | "jobId" | "ownerKey" | "runNonce" | "pid">, right: Pick<ClaimToken, "callerId" | "jobId" | "ownerKey" | "runNonce" | "pid">): boolean {
  return left.callerId === right.callerId && left.jobId === right.jobId && left.ownerKey === right.ownerKey
    && left.runNonce === right.runNonce && left.pid === right.pid;
}

export function sameAdmission(left: MotionJobIdentityClaimAdmissionIntent, right: MotionJobIdentityClaimAdmissionIntent): boolean {
  return left.mode === right.mode && (left.mode === "legacy-planless" || (right.mode === "planned" && left.planFingerprint === right.planFingerprint));
}

export function phaseIndex(phase: MotionJobIdentityClaimPhase): number {
  return PHASES.indexOf(phase);
}

export function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`${label} must be a positive integer.`);
  return Number(value);
}

export function defaultIsProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === "EPERM";
  }
}

function parsePhase(value: unknown): MotionJobIdentityClaimPhase {
  if (typeof value !== "string" || !(PHASES as readonly string[]).includes(value)) throw new Error("Motion job identity claim phase is invalid.");
  return value as MotionJobIdentityClaimPhase;
}

function serialize(value: object): string {
  const serialized = canonicalJson(value);
  if (Buffer.byteLength(serialized, "utf8") < 2 || Buffer.byteLength(serialized, "utf8") > MAX_CLAIM_BYTES) {
    throw new Error("Motion job identity claim exceeds its bounded size.");
  }
  return serialized;
}

function claimRunNonce(value: unknown): string {
  if (typeof value !== "string" || !isMotionJobLeaseRunNonce(value)) throw new Error("Motion job identity claim run nonce is invalid.");
  return value;
}

function assertCallerId(value: unknown): string {
  return opaqueText(value, "Motion job identity claim callerId", 1, 256, CALLER_ID);
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label} must be a non-negative integer.`);
  return Number(value);
}
