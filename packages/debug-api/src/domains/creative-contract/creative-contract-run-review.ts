import {
  CREATIVE_RUN_SCHEMA,
  MAX_CREATIVE_REVISION_ATTEMPTS,
  REVIEW_DECISION_SCHEMA,
  type CreativeAssetLedger,
  type CreativeBrief,
  type CreativeIdentity,
  type CreativeRun,
  type CreativeRunStatus,
  type ReviewDecision,
  type ShotPlan,
} from "./creative-contract-types";
import {
  exactRecord,
  freeze,
  identity,
  isoTime,
  positiveInteger,
  readActor,
  readIdentity,
  sameIdentity,
  sealRecord,
  snapshotCreativeContractData,
  verifySealedRecord,
} from "./creative-contract-data";
import {
  readAssetBindings,
  readCreativeRunDescriptor,
  readCreativeRunStatus,
  readReviewDecisionDescriptor,
  readReviewFindings,
  readShotPlanApproval,
  validateReviewOutcome,
} from "./creative-contract-read";
import { readCreativeAssetLedger, readCreativeBrief, readShotPlan } from "./creative-contract-records";

export function createCreativeRun(value: unknown): CreativeRun {
  const descriptor = readCreativeRunDescriptor(snapshotCreativeContractData(value));
  const brief = readCreativeBrief(descriptor.brief), shotPlan = readShotPlan(descriptor.shotPlan), assetLedger = readCreativeAssetLedger(descriptor.assetLedger);
  assertCreativeJoin(brief, shotPlan, assetLedger, "CreativeRun");
  return sealRecord("creative_run", {
    schema: CREATIVE_RUN_SCHEMA, revision: 1, attempt: 1, createdAt: descriptor.createdAt,
    brief: identity(brief), shotPlan: identity(shotPlan), assetLedger: identity(assetLedger), assetBindings: descriptor.assetBindings, status: "planned" as const,
  }) as CreativeRun;
}

export function readCreativeRun(value: unknown): CreativeRun {
  const record = exactRecord(snapshotCreativeContractData(value), ["schema", "id", "sha256", "revision", "attempt", "createdAt", "brief", "shotPlan", "assetLedger", "assetBindings", "status"], ["parentRevision"], "CreativeRun");
  if (record.schema !== CREATIVE_RUN_SCHEMA) throw new Error(`CreativeRun.schema must equal ${CREATIVE_RUN_SCHEMA}.`);
  const parentRevision = Object.hasOwn(record, "parentRevision") ? readIdentity(record.parentRevision, "CreativeRun.parentRevision", "creative_run") : undefined;
  const payload = {
    schema: CREATIVE_RUN_SCHEMA, revision: positiveInteger(record.revision, "CreativeRun.revision", MAX_CREATIVE_REVISION_ATTEMPTS * 1_000_000), ...(parentRevision ? { parentRevision } : {}),
    attempt: positiveInteger(record.attempt, "CreativeRun.attempt", MAX_CREATIVE_REVISION_ATTEMPTS), createdAt: isoTime(record.createdAt, "CreativeRun.createdAt"),
    brief: readIdentity(record.brief, "CreativeRun.brief", "creative_brief"), shotPlan: readIdentity(record.shotPlan, "CreativeRun.shotPlan", "shot_plan"), assetLedger: readIdentity(record.assetLedger, "CreativeRun.assetLedger", "asset_ledger"),
    assetBindings: readAssetBindings(record.assetBindings, "CreativeRun.assetBindings"), status: readCreativeRunStatus(record.status, "CreativeRun.status"),
  } as const;
  return verifySealedRecord("creative_run", record, payload) as CreativeRun;
}

export function createReviewDecision(value: unknown): ReviewDecision {
  const descriptor = readReviewDecisionDescriptor(snapshotCreativeContractData(value)), run = readCreativeRun(descriptor.run), plan = readShotPlan(descriptor.shotPlan);
  if (!sameIdentity(run.shotPlan, identity(plan))) throw new Error("ReviewDecision.shotPlan must bind CreativeRun.shotPlan.");
  const findings = readReviewFindings(descriptor.findings, "ReviewDecision.findings", plan); validateReviewOutcome(descriptor.outcome, findings);
  return sealRecord("review", { schema: REVIEW_DECISION_SCHEMA, createdAt: descriptor.createdAt, run: identity(run), reviewer: descriptor.reviewer, outcome: descriptor.outcome, findings }) as ReviewDecision;
}

export function readReviewDecision(value: unknown): ReviewDecision {
  const record = exactRecord(snapshotCreativeContractData(value), ["schema", "id", "sha256", "createdAt", "run", "reviewer", "outcome", "findings"], [], "ReviewDecision");
  if (record.schema !== REVIEW_DECISION_SCHEMA) throw new Error(`ReviewDecision.schema must equal ${REVIEW_DECISION_SCHEMA}.`);
  const findings = readReviewFindings(record.findings, "ReviewDecision.findings"), outcome = record.outcome;
  if (outcome !== "accepted" && outcome !== "changes_requested" && outcome !== "rejected") throw new Error("ReviewDecision.outcome must be accepted, changes_requested, or rejected.");
  validateReviewOutcome(outcome, findings);
  const payload = { schema: REVIEW_DECISION_SCHEMA, createdAt: isoTime(record.createdAt, "ReviewDecision.createdAt"), run: readIdentity(record.run, "ReviewDecision.run", "creative_run"), reviewer: readActor(record.reviewer, "ReviewDecision.reviewer"), outcome, findings } as const;
  return verifySealedRecord("review", record, payload) as ReviewDecision;
}

/** Applies one immutable review decision; no model, job, renderer, or package mutation happens here. */
export function applyReviewDecisionToCreativeRun(runValue: unknown, decisionValue: unknown): CreativeRun {
  const run = readCreativeRun(runValue), decision = readReviewDecision(decisionValue);
  if (run.status !== "planned") throw new Error(`CreativeRun ${run.id} is ${run.status} and cannot accept another review decision.`);
  if (!sameIdentity(identity(run), decision.run)) throw new Error("ReviewDecision does not bind this exact CreativeRun identity.");
  const status: CreativeRunStatus = decision.outcome === "accepted" ? "accepted" : decision.outcome === "rejected" ? "rejected" : "revision_required";
  return sealRecord("creative_run", {
    schema: CREATIVE_RUN_SCHEMA, revision: run.revision + 1, parentRevision: identity(run), attempt: run.attempt, createdAt: decision.createdAt,
    brief: run.brief, shotPlan: run.shotPlan, assetLedger: run.assetLedger, assetBindings: run.assetBindings, status,
  }) as CreativeRun;
}

/**
 * A revision names the exact reviewed base and may retain each identity or use its
 * direct immutable successor. This prevents a review from being replayed onto another project.
 */
export function createCreativeRunRevision(value: unknown): CreativeRun {
  const descriptor = exactRecord(snapshotCreativeContractData(value), ["priorRun", "reviewDecision", "expectedBase", "brief", "shotPlan", "assetLedger", "createdAt", "assetBindings"], [], "CreativeRunRevision");
  const priorRun = readCreativeRun(descriptor.priorRun), reviewDecision = readReviewDecision(descriptor.reviewDecision);
  const brief = readCreativeBrief(descriptor.brief), shotPlan = readShotPlan(descriptor.shotPlan), assetLedger = readCreativeAssetLedger(descriptor.assetLedger);
  const expected = readExpectedBase(descriptor.expectedBase);
  if (priorRun.status !== "revision_required") throw new Error("CreativeRunRevision.priorRun must be in revision_required state.");
  if (reviewDecision.outcome !== "changes_requested" || !priorRun.parentRevision || !sameIdentity(reviewDecision.run, priorRun.parentRevision)) throw new Error("CreativeRunRevision.reviewDecision must bind the reviewed predecessor of priorRun.");
  if (!sameIdentity(expected.brief, priorRun.brief) || !sameIdentity(expected.shotPlan, priorRun.shotPlan) || !sameIdentity(expected.assetLedger, priorRun.assetLedger)) throw new Error("CreativeRunRevision.expectedBase must bind all three reviewed priorRun identities.");
  if (!sameOrSuccessor(brief, expected.brief) || !sameOrSuccessor(shotPlan, expected.shotPlan) || !sameOrSuccessor(assetLedger, expected.assetLedger)) throw new Error("CreativeRunRevision must retain or directly succeed every reviewed brief, plan, and ledger identity.");
  assertCreativeJoin(brief, shotPlan, assetLedger, "CreativeRunRevision");
  if (priorRun.attempt >= shotPlan.budget.revisionLimit) throw new Error(`CreativeRunRevision exceeds the ShotPlan revision limit of ${shotPlan.budget.revisionLimit}.`);
  return sealRecord("creative_run", {
    schema: CREATIVE_RUN_SCHEMA, revision: priorRun.revision + 1, parentRevision: identity(priorRun), attempt: priorRun.attempt + 1,
    createdAt: isoTime(descriptor.createdAt, "CreativeRunRevision.createdAt"), brief: identity(brief), shotPlan: identity(shotPlan), assetLedger: identity(assetLedger), assetBindings: readAssetBindings(descriptor.assetBindings, "CreativeRunRevision.assetBindings"), status: "planned" as const,
  }) as CreativeRun;
}

export function isCreativeRunTerminal(status: CreativeRunStatus): boolean { return status === "accepted" || status === "rejected" || status === "cancelled"; }

function readExpectedBase(value: unknown): { brief: CreativeIdentity; shotPlan: CreativeIdentity; assetLedger: CreativeIdentity } {
  const record = exactRecord(value, ["brief", "shotPlan", "assetLedger"], [], "CreativeRunRevision.expectedBase");
  return freeze({ brief: readIdentity(record.brief, "CreativeRunRevision.expectedBase.brief", "creative_brief"), shotPlan: readIdentity(record.shotPlan, "CreativeRunRevision.expectedBase.shotPlan", "shot_plan"), assetLedger: readIdentity(record.assetLedger, "CreativeRunRevision.expectedBase.assetLedger", "asset_ledger") });
}
function sameOrSuccessor(value: { id: string; sha256: string; parentRevision?: CreativeIdentity }, expected: CreativeIdentity): boolean {
  return sameIdentity(identity(value), expected) || (value.parentRevision !== undefined && sameIdentity(value.parentRevision, expected));
}
function assertCreativeJoin(brief: CreativeBrief, shotPlan: ShotPlan, assetLedger: CreativeAssetLedger, label: string): void {
  if (!sameIdentity(shotPlan.brief, identity(brief))) throw new Error(`${label}.shotPlan must bind the supplied CreativeBrief identity.`);
  if (!sameIdentity(assetLedger.brief, identity(brief))) throw new Error(`${label}.assetLedger must bind the supplied CreativeBrief identity.`);
}
