/** Host-only C6C B1e authority. Endpoint witnesses are registrations, never caller-authored facts. */
import { createHmac } from "node:crypto";
import { canonicalJson } from "@shellx-motion/core";
import { assertAuthorityLive, checkedAuthority } from "./checkpoint-storyboard-record-store-authority.js";
import {
  assertCheckpointStoryboardCreativeReviewAuthorityStore,
  checkedCheckpointStoryboardCreativeReviewAuthority,
  resolveCheckpointStoryboardCreativeReviewHandle,
  type CheckpointStoryboardCreativeReviewAuthority,
  type ResolvedHostCreativeReview,
} from "./checkpoint-storyboard-creative-review-authority.js";
import {
  assertCheckpointStoryboardMaterializationAuthorityStore,
  type CheckpointStoryboardMaterializationAuthority,
} from "./checkpoint-storyboard-materialization-authority.js";
import {
  assertCheckpointStoryboardPreviewAuthorityMaterialization,
  assertCheckpointStoryboardPreviewAuthorityStore,
  type CheckpointStoryboardPreviewAuthority,
} from "./checkpoint-storyboard-preview-authority.js";
import { readIdentity, sameIdentity, storeError, type CheckpointStoryboardRecordIdentity, type CheckpointStoryboardRecordStoreAuthority } from "./checkpoint-storyboard-record-store-types.js";

const qualityReviewAuthorityBrand: unique symbol = Symbol("checkpoint-storyboard-quality-review-authority");
const endpointWitnessFacts = new WeakMap<CheckpointStoryboardQualityReviewAuthority, QualityReviewAuthorityFacts>();
const ENDPOINT_WITNESS_HANDLE = /^checkpoint_storyboard_endpoint_witness_handle_[a-f0-9]{32}$/u;
const PREVIEW_HANDLE = /^checkpoint_storyboard_preview_[a-f0-9]{32}$/u;
const RECEIPT_HANDLE = /^checkpoint_storyboard_preview_receipt_[a-f0-9]{32}$/u;
const MAX_ENDPOINT_WITNESSES = 128;

export type HostEndpointWitnessRegistration = Readonly<{
  record: Readonly<{ identity: CheckpointStoryboardRecordIdentity; root: CheckpointStoryboardRecordIdentity }>;
  /** Existing opaque B1c handle; it remains host-only and is never persisted by B1e. */
  creativeReviewHandle: string;
  /** Exact B1b v2 terminal pair to be reopened by B1e. */
  terminalPreview: Readonly<{ previewHandle: string; receiptHandle: string }>;
  endpoint: Readonly<{ atUs: number }>;
}>;
export type ResolvedEndpointWitness = Readonly<{
  record: Readonly<{ identity: CheckpointStoryboardRecordIdentity; root: CheckpointStoryboardRecordIdentity }>;
  creativeReviewHandle: string;
  creative: ResolvedHostCreativeReview;
  terminalPreview: Readonly<{ previewHandle: string; receiptHandle: string }>;
  endpoint: Readonly<{ atUs: number }>;
  handleDigest: string;
}>;

export interface CheckpointStoryboardQualityReviewAuthority {
  readonly [qualityReviewAuthorityBrand]: "host-configured-c6c-b1e-quality-review";
}
export interface QualityReviewAuthorityFacts {
  readonly store: CheckpointStoryboardRecordStoreAuthority;
  readonly materialization: CheckpointStoryboardMaterializationAuthority;
  readonly preview: CheckpointStoryboardPreviewAuthority;
  readonly creativeReview: CheckpointStoryboardCreativeReviewAuthority;
  readonly endpointWitnessRegistry: ReadonlyMap<string, ResolvedEndpointWitness>;
}

/**
 * This is the sole endpoint-witness registration surface. It snapshots a bounded host registry;
 * no Debug command can create, enumerate, inspect, or supply its raw witness record.
 */
export function configureCheckpointStoryboardQualityReviewAuthority(input: {
  readonly recordStore: CheckpointStoryboardRecordStoreAuthority;
  readonly materializationAuthority: CheckpointStoryboardMaterializationAuthority;
  readonly previewAuthority: CheckpointStoryboardPreviewAuthority;
  readonly creativeReviewAuthority: CheckpointStoryboardCreativeReviewAuthority;
  readonly endpointWitnessRegistry: ReadonlyMap<string, HostEndpointWitnessRegistration>;
}): CheckpointStoryboardQualityReviewAuthority {
  if (!input?.recordStore || !input.materializationAuthority || !input.previewAuthority || !input.creativeReviewAuthority || !input.endpointWitnessRegistry || typeof input.endpointWitnessRegistry.entries !== "function")
    throw new Error("Checkpoint storyboard quality review requires host-configured B1a, B1b, B1c, and endpoint-witness authorities.");
  const storeFacts = checkedAuthority(input.recordStore);
  assertCheckpointStoryboardMaterializationAuthorityStore(input.materializationAuthority, input.recordStore);
  assertCheckpointStoryboardPreviewAuthorityStore(input.previewAuthority, input.recordStore);
  assertCheckpointStoryboardPreviewAuthorityMaterialization(input.previewAuthority, input.materializationAuthority);
  assertCheckpointStoryboardCreativeReviewAuthorityStore(input.creativeReviewAuthority, input.recordStore);
  const creativeFacts = checkedCheckpointStoryboardCreativeReviewAuthority(input.creativeReviewAuthority);
  const registry = new Map<string, ResolvedEndpointWitness>();
  for (const [handle, value] of input.endpointWitnessRegistry.entries()) {
    if (registry.size >= MAX_ENDPOINT_WITNESSES) throw new Error("Checkpoint storyboard endpoint-witness host registry exceeds its bounded handle limit.");
    if (typeof handle !== "string" || !ENDPOINT_WITNESS_HANDLE.test(handle) || registry.has(handle)) throw new Error("Checkpoint storyboard endpoint-witness handle is invalid.");
    const record = exact(value, ["record", "creativeReviewHandle", "terminalPreview", "endpoint"]);
    const recordFacts = exact(record.record, ["identity", "root"]);
    const identity = readIdentity(recordFacts.identity, "Checkpoint storyboard endpoint-witness identity");
    const root = readIdentity(recordFacts.root, "Checkpoint storyboard endpoint-witness root");
    const terminalPreview = exact(record.terminalPreview, ["previewHandle", "receiptHandle"]);
    if (typeof record.creativeReviewHandle !== "string" || typeof terminalPreview.previewHandle !== "string" || !PREVIEW_HANDLE.test(terminalPreview.previewHandle) || typeof terminalPreview.receiptHandle !== "string" || !RECEIPT_HANDLE.test(terminalPreview.receiptHandle)) throw new Error("Checkpoint storyboard endpoint-witness registration handles are invalid.");
    const endpoint = exact(record.endpoint, ["atUs"]);
    if (!Number.isSafeInteger(endpoint.atUs) || (endpoint.atUs as number) < 1_000) throw new Error("Checkpoint storyboard endpoint-witness endpoint must be a positive exact microsecond boundary.");
    const creative = resolveCheckpointStoryboardCreativeReviewHandle(creativeFacts, record.creativeReviewHandle);
    if (!sameIdentity(creative.record.identity, identity) || !sameIdentity(creative.record.root, root)) throw new Error("Checkpoint storyboard endpoint-witness and B1c host registration identities must match.");
    registry.set(handle, Object.freeze({ record: Object.freeze({ identity, root }), creativeReviewHandle: record.creativeReviewHandle, creative, terminalPreview: Object.freeze({ previewHandle: terminalPreview.previewHandle, receiptHandle: terminalPreview.receiptHandle }), endpoint: Object.freeze({ atUs: endpoint.atUs as number }), handleDigest: digest(storeFacts.integrityKey, storeFacts.storeBinding, handle) }));
  }
  const authority = Object.freeze({ [qualityReviewAuthorityBrand]: "host-configured-c6c-b1e-quality-review" as const });
  endpointWitnessFacts.set(authority, Object.freeze({ store: input.recordStore, materialization: input.materializationAuthority, preview: input.previewAuthority, creativeReview: input.creativeReviewAuthority, endpointWitnessRegistry: registry }));
  return authority;
}

export function checkedCheckpointStoryboardQualityReviewAuthority(authority: CheckpointStoryboardQualityReviewAuthority): QualityReviewAuthorityFacts {
  const facts = endpointWitnessFacts.get(authority);
  if (!facts || authority[qualityReviewAuthorityBrand] !== "host-configured-c6c-b1e-quality-review") throw storeError("quality_review_authority_refused", "Checkpoint storyboard quality-review authority is not host-minted.");
  return facts;
}
export function assertCheckpointStoryboardQualityReviewAuthorityStore(authority: CheckpointStoryboardQualityReviewAuthority, store: CheckpointStoryboardRecordStoreAuthority): void {
  if (checkedCheckpointStoryboardQualityReviewAuthority(authority).store !== store) throw storeError("quality_review_authority_refused", "Checkpoint storyboard quality-review authority is not bound to this lifecycle record store.");
}
export function resolveCheckpointStoryboardEndpointWitnessHandle(facts: QualityReviewAuthorityFacts, handle: string): ResolvedEndpointWitness {
  if (!ENDPOINT_WITNESS_HANDLE.test(handle)) throw storeError("quality_review_evidence_refused", "Checkpoint storyboard terminal quality review requires one exact opaque endpoint-witness handle.");
  const witness = facts.endpointWitnessRegistry.get(handle);
  if (!witness) throw storeError("quality_review_evidence_refused", "Checkpoint storyboard endpoint witness is unknown, stale, or not host-minted.");
  return witness;
}
export async function withCheckpointStoryboardQualityReviewAuthority<T>(authority: CheckpointStoryboardQualityReviewAuthority, run: (facts: QualityReviewAuthorityFacts) => Promise<T>): Promise<T> {
  const facts = checkedCheckpointStoryboardQualityReviewAuthority(authority);
  try {
    await assertAuthorityLive(checkedAuthority(facts.store));
    assertCheckpointStoryboardMaterializationAuthorityStore(facts.materialization, facts.store);
    assertCheckpointStoryboardPreviewAuthorityStore(facts.preview, facts.store);
    assertCheckpointStoryboardPreviewAuthorityMaterialization(facts.preview, facts.materialization);
    assertCheckpointStoryboardCreativeReviewAuthorityStore(facts.creativeReview, facts.store);
  } catch (error) {
    if (error instanceof Error && error.name === "CheckpointStoryboardRecordStoreError") throw error;
    throw storeError("quality_review_authority_refused", "Checkpoint storyboard quality-review authority is no longer live.");
  }
  return await run(facts);
}

function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Checkpoint storyboard endpoint-witness registration must be a plain object.");
  const record = value as Record<string, unknown>, keys = Object.keys(record);
  if (keys.length !== fields.length || fields.some((field) => !Object.hasOwn(record, field)) || keys.some((field) => !fields.includes(field))) throw new Error("Checkpoint storyboard endpoint-witness registration fields are invalid.");
  return record;
}
function digest(key: Uint8Array, storeBinding: string, handle: string): string {
  return createHmac("sha256", key).update("checkpoint-storyboard-endpoint-witness-handle@1\0").update(storeBinding).update("\0").update(canonicalJson({ handle })).digest("hex");
}
