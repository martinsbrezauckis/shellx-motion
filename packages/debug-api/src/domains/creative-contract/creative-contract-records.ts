import {
  ASSET_RECORD_SCHEMA,
  CREATIVE_ASSET_LEDGER_SCHEMA,
  CREATIVE_BRIEF_SCHEMA,
  MAX_CREATIVE_ASSETS,
  MAX_CREATIVE_REVISION_ATTEMPTS,
  SHOT_PLAN_SCHEMA,
  type AssetRecord,
  type CreativeAssetLedger,
  type CreativeBrief,
  type ShotPlan,
  type ShotPlanApprovalStatus,
} from "./creative-contract-types";
import {
  exactArray,
  exactRecord,
  freeze,
  identity,
  isoTime,
  positiveInteger,
  readActor,
  readIdentity,
  sameIdentity,
  sealAssetRecord,
  sealRecord,
  sha256,
  snapshotCreativeContractData,
  sortedAssetIds,
  strictlySorted,
  verifySealedRecord,
} from "./creative-contract-data";
import {
  readApprovalActor,
  readAssetRecordDescriptor,
  readCapabilityIds,
  readCreativeBriefDescriptor,
  readAssetLedgerDescriptor,
  readAssetLineage,
  readAssetOrigin,
  readAssetRights,
  readShotPlanApproval,
  readShotPlanBudget,
  readShotPlanDescriptor,
  readShotPlanShots,
  validateShotBudget,
} from "./creative-contract-read";
import { assetAvailability, assetKind, boundedString, mediaType } from "./creative-contract-data";

export function createCreativeBrief(value: unknown): CreativeBrief {
  const descriptor = readCreativeBriefDescriptor(snapshotCreativeContractData(value));
  const parent = descriptor.parent ? readCreativeBrief(descriptor.parent) : undefined;
  return sealRecord("creative_brief", {
    schema: CREATIVE_BRIEF_SCHEMA, revision: parent ? parent.revision + 1 : 1, ...(parent ? { parentRevision: identity(parent) } : {}),
    createdAt: descriptor.createdAt, author: descriptor.author, prompt: descriptor.prompt, goals: descriptor.goals, constraints: descriptor.constraints, referenceAssetIds: descriptor.referenceAssetIds,
  }) as CreativeBrief;
}

export function readCreativeBrief(value: unknown): CreativeBrief {
  const record = exactRecord(snapshotCreativeContractData(value), ["schema", "id", "sha256", "revision", "createdAt", "author", "prompt", "goals", "constraints", "referenceAssetIds"], ["parentRevision"], "CreativeBrief");
  if (record.schema !== CREATIVE_BRIEF_SCHEMA) throw new Error(`CreativeBrief.schema must equal ${CREATIVE_BRIEF_SCHEMA}.`);
  const parentRevision = Object.hasOwn(record, "parentRevision") ? readIdentity(record.parentRevision, "CreativeBrief.parentRevision", "creative_brief") : undefined;
  const payload = {
    schema: CREATIVE_BRIEF_SCHEMA, revision: positiveInteger(record.revision, "CreativeBrief.revision", MAX_CREATIVE_REVISION_ATTEMPTS * 1_000_000), ...(parentRevision ? { parentRevision } : {}),
    createdAt: isoTime(record.createdAt, "CreativeBrief.createdAt"), author: readActor(record.author, "CreativeBrief.author"), prompt: boundedString(record.prompt, "CreativeBrief.prompt", 4_096),
    goals: readStrings(record.goals, "CreativeBrief.goals", 1, 16, 160), constraints: readStrings(record.constraints, "CreativeBrief.constraints", 0, 16, 160), referenceAssetIds: readAssetIds(record.referenceAssetIds, "CreativeBrief.referenceAssetIds", 16),
  } as const;
  return verifySealedRecord("creative_brief", record, payload) as CreativeBrief;
}

export function createShotPlan(value: unknown): ShotPlan {
  const descriptor = readShotPlanDescriptor(snapshotCreativeContractData(value)), brief = readCreativeBrief(descriptor.brief), parent = descriptor.parent ? readShotPlan(descriptor.parent) : undefined;
  if (parent && !sameIdentity(parent.brief, identity(brief))) throw new Error("ShotPlan.parent must bind the same CreativeBrief identity.");
  validateShotBudget(descriptor.shots, descriptor.budget);
  return sealRecord("shot_plan", {
    schema: SHOT_PLAN_SCHEMA, revision: parent ? parent.revision + 1 : 1, ...(parent ? { parentRevision: identity(parent) } : {}), createdAt: descriptor.createdAt,
    brief: identity(brief), capabilityIds: descriptor.capabilityIds, shots: descriptor.shots, budget: descriptor.budget, approval: { status: "proposed" as const },
  }) as ShotPlan;
}

export function readShotPlan(value: unknown): ShotPlan {
  const record = exactRecord(snapshotCreativeContractData(value), ["schema", "id", "sha256", "revision", "createdAt", "brief", "capabilityIds", "shots", "budget", "approval"], ["parentRevision"], "ShotPlan");
  if (record.schema !== SHOT_PLAN_SCHEMA) throw new Error(`ShotPlan.schema must equal ${SHOT_PLAN_SCHEMA}.`);
  const parentRevision = Object.hasOwn(record, "parentRevision") ? readIdentity(record.parentRevision, "ShotPlan.parentRevision", "shot_plan") : undefined;
  const shots = readShotPlanShots(record.shots, "ShotPlan.shots"), budget = readShotPlanBudget(record.budget, "ShotPlan.budget"); validateShotBudget(shots, budget);
  const payload = {
    schema: SHOT_PLAN_SCHEMA, revision: positiveInteger(record.revision, "ShotPlan.revision", MAX_CREATIVE_REVISION_ATTEMPTS * 1_000_000), ...(parentRevision ? { parentRevision } : {}), createdAt: isoTime(record.createdAt, "ShotPlan.createdAt"),
    brief: readIdentity(record.brief, "ShotPlan.brief", "creative_brief"), capabilityIds: readCapabilityIds(record.capabilityIds, "ShotPlan.capabilityIds"), shots, budget, approval: readShotPlanApproval(record.approval, "ShotPlan.approval"),
  } as const;
  return verifySealedRecord("shot_plan", record, payload) as ShotPlan;
}

export function approveShotPlan(value: unknown, decision: unknown): ShotPlan { return transitionShotPlanApproval(value, decision, "approved"); }
export function rejectShotPlan(value: unknown, decision: unknown): ShotPlan { return transitionShotPlanApproval(value, decision, "rejected"); }
export function isShotPlanApprovalTerminal(status: ShotPlanApprovalStatus): boolean { return status === "approved" || status === "rejected"; }

function transitionShotPlanApproval(value: unknown, decisionValue: unknown, status: "approved" | "rejected"): ShotPlan {
  const plan = readShotPlan(value);
  if (plan.approval.status !== "proposed") throw new Error(`ShotPlan ${plan.id} approval is already terminal.`);
  const decision = exactRecord(snapshotCreativeContractData(decisionValue), ["decidedBy", "decidedAt", "reason"], [], "ShotPlanApprovalDecision");
  return sealRecord("shot_plan", {
    schema: SHOT_PLAN_SCHEMA, revision: plan.revision + 1, parentRevision: identity(plan), createdAt: plan.createdAt, brief: plan.brief, capabilityIds: plan.capabilityIds, shots: plan.shots, budget: plan.budget,
    approval: { status, decidedBy: readApprovalActor(decision.decidedBy, "ShotPlanApprovalDecision.decidedBy"), decidedAt: isoTime(decision.decidedAt, "ShotPlanApprovalDecision.decidedAt"), reason: boundedString(decision.reason, "ShotPlanApprovalDecision.reason", 512) },
  }) as ShotPlan;
}

export function createAssetRecord(value: unknown): AssetRecord {
  const descriptor = readAssetRecordDescriptor(snapshotCreativeContractData(value)), lineage = descriptor.lineage ?? { parentAssetIds: [], transformation: "original" };
  return sealAssetRecord({ schema: ASSET_RECORD_SCHEMA, kind: descriptor.kind, mediaType: descriptor.mediaType, contentSha256: descriptor.contentSha256, byteLength: descriptor.byteLength, origin: descriptor.origin, rights: descriptor.rights, lineage, availability: descriptor.availability });
}

export function readAssetRecord(value: unknown): AssetRecord {
  const record = exactRecord(snapshotCreativeContractData(value), ["schema", "id", "sha256", "kind", "mediaType", "contentSha256", "byteLength", "origin", "rights", "lineage", "availability"], [], "AssetRecord");
  if (record.schema !== ASSET_RECORD_SCHEMA) throw new Error(`AssetRecord.schema must equal ${ASSET_RECORD_SCHEMA}.`);
  const payload = {
    schema: ASSET_RECORD_SCHEMA, kind: assetKind(record.kind, "AssetRecord.kind"), mediaType: mediaType(record.mediaType, "AssetRecord.mediaType"), contentSha256: sha256(record.contentSha256, "AssetRecord.contentSha256"),
    byteLength: positiveInteger(record.byteLength, "AssetRecord.byteLength", 1_073_741_824), origin: readAssetOrigin(record.origin, "AssetRecord.origin"), rights: readAssetRights(record.rights, "AssetRecord.rights"), lineage: readAssetLineage(record.lineage, "AssetRecord.lineage"), availability: assetAvailability(record.availability, "AssetRecord.availability"),
  } as const;
  const expected = sealAssetRecord(payload);
  if (record.id !== expected.id || record.sha256 !== expected.sha256) throw new Error("AssetRecord canonical id or sha256 is stale.");
  return expected;
}

export function createCreativeAssetLedger(value: unknown): CreativeAssetLedger {
  const descriptor = readAssetLedgerDescriptor(snapshotCreativeContractData(value)), brief = readCreativeBrief(descriptor.brief), parent = descriptor.parent ? readCreativeAssetLedger(descriptor.parent) : undefined;
  if (parent && !sameIdentity(parent.brief, identity(brief))) throw new Error("CreativeAssetLedger.parent must bind the same CreativeBrief identity.");
  return sealRecord("asset_ledger", { schema: CREATIVE_ASSET_LEDGER_SCHEMA, revision: parent ? parent.revision + 1 : 1, ...(parent ? { parentRevision: identity(parent) } : {}), createdAt: descriptor.createdAt, brief: identity(brief), assets: readLedgerAssets(descriptor.assets, "CreativeAssetLedger.assets") }) as CreativeAssetLedger;
}

export function readCreativeAssetLedger(value: unknown): CreativeAssetLedger {
  const record = exactRecord(snapshotCreativeContractData(value), ["schema", "id", "sha256", "revision", "createdAt", "brief", "assets"], ["parentRevision"], "CreativeAssetLedger");
  if (record.schema !== CREATIVE_ASSET_LEDGER_SCHEMA) throw new Error(`CreativeAssetLedger.schema must equal ${CREATIVE_ASSET_LEDGER_SCHEMA}.`);
  const parentRevision = Object.hasOwn(record, "parentRevision") ? readIdentity(record.parentRevision, "CreativeAssetLedger.parentRevision", "asset_ledger") : undefined;
  const payload = {
    schema: CREATIVE_ASSET_LEDGER_SCHEMA, revision: positiveInteger(record.revision, "CreativeAssetLedger.revision", MAX_CREATIVE_REVISION_ATTEMPTS * 1_000_000), ...(parentRevision ? { parentRevision } : {}),
    createdAt: isoTime(record.createdAt, "CreativeAssetLedger.createdAt"), brief: readIdentity(record.brief, "CreativeAssetLedger.brief", "creative_brief"), assets: readLedgerAssets(record.assets, "CreativeAssetLedger.assets"),
  } as const;
  return verifySealedRecord("asset_ledger", record, payload) as CreativeAssetLedger;
}

function readLedgerAssets(value: unknown, label: string): readonly AssetRecord[] {
  const entries = exactArray(value, label, MAX_CREATIVE_ASSETS, 0), assets = entries.map((entry, index) => readAssetRecord(entry));
  if (new Set(assets.map((asset) => asset.id)).size !== assets.length) throw new Error(`${label} cannot repeat one content asset id.`);
  if (!strictlySorted(assets.map((asset) => asset.id))) throw new Error(`${label} must be strict code-unit ascending by asset id.`);
  return freeze(assets);
}

function readStrings(value: unknown, label: string, minimum: number, maximum: number, itemMax: number): readonly string[] {
  const entries = exactArray(value, label, maximum, minimum).map((entry, index) => boundedString(entry, `${label}[${index}]`, itemMax));
  return freeze(entries);
}
function readAssetIds(value: unknown, label: string, maximum: number): readonly string[] {
  return sortedAssetIds(value, label, maximum);
}
