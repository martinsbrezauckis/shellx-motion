/** Strict parser for immutable B1c final binding bytes. */
import { createHash } from "node:crypto";
import { canonicalJson } from "@shellx-motion/core";
import { SHA256, type AuthenticatedActor, type CreativeIdentity, type StoredBinding } from "./checkpoint-storyboard-creative-review-types.js";
import { exact, readIdentity, storeError } from "./checkpoint-storyboard-record-store-types.js";

export function readBinding(value: unknown): StoredBinding {
  const record = exact(value, ["schema", "id", "sha256", "identity", "root", "c6", "b1a", "preview", "creative", "host", "outcome", "derivedRunId", "scope"], "Checkpoint storyboard creative-review binding");
  if ((record.schema !== "shellx-motion/private-checkpoint-storyboard-creative-review@1" && record.schema !== "shellx-motion/private-checkpoint-storyboard-creative-review@2") || typeof record.id !== "string" || !/^checkpoint_storyboard_creative_review_[a-f0-9]{32}$/u.test(record.id) || typeof record.sha256 !== "string" || !SHA256.test(record.sha256))
    throw storeError("store_integrity_failed", "Checkpoint storyboard creative-review binding identity is invalid.");
  const identity = readIdentity(record.identity, "Checkpoint storyboard creative-review identity");
  const root = readIdentity(record.root, "Checkpoint storyboard creative-review root");
  const c6 = exact(record.c6, ["fingerprint"], "Checkpoint storyboard creative-review C6 evidence");
  const b1a = exact(record.b1a, ["bindingId", "bindingSha256", "c6bReceiptFingerprint"], "Checkpoint storyboard creative-review B1a evidence");
  const isV2 = record.schema === "shellx-motion/private-checkpoint-storyboard-creative-review@2";
  const preview = exact(record.preview, isV2
    ? ["targetSha256", "receiptSha256", "pngSha256", "snapshotSha256", "samplingSha256", "width", "height", "runtimeEvidence"]
    : ["targetSha256", "receiptSha256", "pngSha256", "snapshotSha256", "width", "height", "runtimeEvidence"], "Checkpoint storyboard creative-review preview evidence");
  const creative = exact(record.creative, ["brief", "shotPlan", "assetLedger", "run", "reviewDecision"], "Checkpoint storyboard creative-review identities");
  const host = exact(record.host, ["shotPlanApprover", "reviewDecisionReviewer", "authenticationDigest", "handleDigest"], "Checkpoint storyboard creative-review host authentication evidence");
  const scope = exact(record.scope, ["shotId", "atMs"], "Checkpoint storyboard creative-review scope");
  if (typeof c6.fingerprint !== "string" || c6.fingerprint !== identity.sha256 || typeof b1a.bindingId !== "string" || !/^checkpoint_storyboard_materialization_binding_[a-f0-9]{32}$/u.test(b1a.bindingId) || typeof b1a.bindingSha256 !== "string" || !SHA256.test(b1a.bindingSha256) || typeof b1a.c6bReceiptFingerprint !== "string" || !SHA256.test(b1a.c6bReceiptFingerprint) || typeof preview.targetSha256 !== "string" || !SHA256.test(preview.targetSha256) || typeof preview.receiptSha256 !== "string" || !SHA256.test(preview.receiptSha256) || typeof preview.pngSha256 !== "string" || !SHA256.test(preview.pngSha256) || typeof preview.snapshotSha256 !== "string" || !SHA256.test(preview.snapshotSha256) || (isV2 && (typeof preview.samplingSha256 !== "string" || !SHA256.test(preview.samplingSha256))) || typeof host.authenticationDigest !== "string" || !SHA256.test(host.authenticationDigest) || typeof host.handleDigest !== "string" || !SHA256.test(host.handleDigest) || !Number.isSafeInteger(preview.width) || (preview.width as number) < 1 || !Number.isSafeInteger(preview.height) || (preview.height as number) < 1 || (preview.runtimeEvidence !== "host-browser" && preview.runtimeEvidence !== "source-test") || (record.outcome !== "accepted" && record.outcome !== "changes_requested" && record.outcome !== "rejected") || typeof record.derivedRunId !== "string" || !/^creative_run_[a-f0-9]{32}$/u.test(record.derivedRunId) || typeof scope.shotId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(scope.shotId) || !Number.isSafeInteger(scope.atMs) || (scope.atMs as number) < 0)
    throw storeError("store_integrity_failed", "Checkpoint storyboard creative-review binding evidence is invalid.");
  const result = {
    schema: record.schema,
    identity, root,
    c6: Object.freeze({ fingerprint: c6.fingerprint }),
    b1a: Object.freeze({ bindingId: b1a.bindingId, bindingSha256: b1a.bindingSha256, c6bReceiptFingerprint: b1a.c6bReceiptFingerprint }),
    preview: Object.freeze({ targetSha256: preview.targetSha256, receiptSha256: preview.receiptSha256, pngSha256: preview.pngSha256, snapshotSha256: preview.snapshotSha256, ...(isV2 ? { samplingSha256: preview.samplingSha256 as string } : {}), width: preview.width as number, height: preview.height as number, runtimeEvidence: preview.runtimeEvidence }),
    creative: Object.freeze({ brief: readCreativeIdentity(creative.brief, "Checkpoint storyboard creative-review brief"), shotPlan: readCreativeIdentity(creative.shotPlan, "Checkpoint storyboard creative-review ShotPlan"), assetLedger: readCreativeIdentity(creative.assetLedger, "Checkpoint storyboard creative-review ledger"), run: readCreativeIdentity(creative.run, "Checkpoint storyboard creative-review run"), reviewDecision: readCreativeIdentity(creative.reviewDecision, "Checkpoint storyboard creative-review decision") }),
    host: Object.freeze({ shotPlanApprover: readAuthenticatedActor(host.shotPlanApprover, "Checkpoint storyboard creative-review ShotPlan approver authentication"), reviewDecisionReviewer: readAuthenticatedActor(host.reviewDecisionReviewer, "Checkpoint storyboard creative-review decision reviewer authentication"), authenticationDigest: host.authenticationDigest, handleDigest: host.handleDigest }),
    outcome: record.outcome,
    derivedRunId: record.derivedRunId,
    scope: Object.freeze({ shotId: scope.shotId, atMs: scope.atMs as number }),
  } as const;
  const sha256 = createHash("sha256").update(canonicalJson(result)).digest("hex");
  if (record.sha256 !== sha256 || record.id !== `checkpoint_storyboard_creative_review_${sha256.slice(0, 32)}`)
    throw storeError("store_integrity_failed", "Checkpoint storyboard creative-review binding canonical identity is stale.");
  return Object.freeze({ ...result, id: record.id, sha256 });
}

function readCreativeIdentity(value: unknown, label: string): CreativeIdentity {
  const record = exact(value, ["id", "sha256"], label);
  if (typeof record.id !== "string" || !/^(?:creative_brief|shot_plan|asset_ledger|creative_run|review)_[a-f0-9]{32}$/u.test(record.id) || typeof record.sha256 !== "string" || !SHA256.test(record.sha256))
    throw storeError("store_integrity_failed", `${label} is invalid.`);
  return Object.freeze({ id: record.id, sha256: record.sha256 });
}

function readAuthenticatedActor(value: unknown, label: string): AuthenticatedActor {
  const record = exact(value, ["kind", "id"], label);
  if ((record.kind !== "human" && record.kind !== "policy") || typeof record.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(record.id))
    throw storeError("store_integrity_failed", `${label} is invalid.`);
  return Object.freeze({ kind: record.kind, id: record.id });
}
