import { listRendererCapabilityCards } from "@shellx-motion/core";
import {
  assetAvailability,
  assetId,
  assetKind,
  assetOrigin,
  assetRights,
  bindingKey,
  boundedString,
  creativeRunStatus,
  exactArray,
  exactRecord,
  findingSeverity,
  freeze,
  isoTime,
  mediaType,
  plainRecord,
  positiveInteger,
  readActor,
  reviewOutcome,
  safeId,
  safeUs,
  sha256,
  slotKey,
  sortedAssetIds,
  sortedOrigins,
  strictlySorted,
  stringArray,
  unit,
} from "./creative-contract-data";
import {
  MAX_CREATIVE_ACTIONS,
  MAX_CREATIVE_ASSET_BYTES,
  MAX_CREATIVE_ASSET_SLOTS,
  MAX_CREATIVE_REVIEW_FINDINGS,
  MAX_CREATIVE_REVISION_ATTEMPTS,
  MAX_CREATIVE_SHOT_DURATION_US,
  MAX_CREATIVE_SHOTS,
  type AssetRecordDescriptor,
  type CreativeAssetBinding,
  type CreativeAssetLineage,
  type CreativeAssetOrigin,
  type CreativeAssetRights,
  type CreativeAssetLedgerDescriptor,
  type CreativeBrief,
  type CreativeBriefDescriptor,
  type CreativeReviewFinding,
  type CreativeReviewOutcome,
  type CreativeReviewRegion,
  type CreativeRunDescriptor,
  type ReviewDecisionDescriptor,
  type ShotAssetSlot,
  type ShotPlan,
  type ShotPlanApproval,
  type ShotPlanBudget,
  type ShotPlanDescriptor,
  type ShotPlanShot,
} from "./creative-contract-types";

const CAPABILITY_IDS = new Set(listRendererCapabilityCards().map((card) => card.id));
const OPAQUE_ORIGIN_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;

export function readCreativeBriefDescriptor(value: unknown): CreativeBriefDescriptor {
  const record = exactRecord(value, ["createdAt", "author", "prompt", "goals", "constraints"], ["referenceAssetIds", "parent"], "CreativeBriefDescriptor");
  return {
    createdAt: isoTime(record.createdAt, "CreativeBriefDescriptor.createdAt"), author: readActor(record.author, "CreativeBriefDescriptor.author"),
    prompt: boundedString(record.prompt, "CreativeBriefDescriptor.prompt", 4_096), goals: stringArray(record.goals, "CreativeBriefDescriptor.goals", 1, 16, 160),
    constraints: stringArray(record.constraints, "CreativeBriefDescriptor.constraints", 0, 16, 160),
    referenceAssetIds: Object.hasOwn(record, "referenceAssetIds") ? sortedAssetIds(record.referenceAssetIds, "CreativeBriefDescriptor.referenceAssetIds", 16) : [],
    ...(Object.hasOwn(record, "parent") ? { parent: record.parent as CreativeBrief } : {}),
  };
}

export function readShotPlanDescriptor(value: unknown): ShotPlanDescriptor {
  const record = exactRecord(value, ["brief", "createdAt", "capabilityIds", "shots", "budget"], ["parent"], "ShotPlanDescriptor");
  return {
    brief: record.brief as CreativeBrief, createdAt: isoTime(record.createdAt, "ShotPlanDescriptor.createdAt"),
    capabilityIds: readCapabilityIds(record.capabilityIds, "ShotPlanDescriptor.capabilityIds"), shots: readShotPlanShots(record.shots, "ShotPlanDescriptor.shots"),
    budget: readShotPlanBudget(record.budget, "ShotPlanDescriptor.budget"), ...(Object.hasOwn(record, "parent") ? { parent: record.parent as ShotPlan } : {}),
  };
}

export function readAssetRecordDescriptor(value: unknown): AssetRecordDescriptor {
  const record = exactRecord(value, ["kind", "mediaType", "contentSha256", "byteLength", "origin", "rights", "availability"], ["lineage"], "AssetRecordDescriptor");
  return {
    kind: assetKind(record.kind, "AssetRecordDescriptor.kind"), mediaType: mediaType(record.mediaType, "AssetRecordDescriptor.mediaType"),
    contentSha256: sha256(record.contentSha256, "AssetRecordDescriptor.contentSha256"), byteLength: positiveInteger(record.byteLength, "AssetRecordDescriptor.byteLength", MAX_CREATIVE_ASSET_BYTES),
    origin: readAssetOrigin(record.origin, "AssetRecordDescriptor.origin"), rights: readAssetRights(record.rights, "AssetRecordDescriptor.rights"),
    lineage: Object.hasOwn(record, "lineage") ? readAssetLineage(record.lineage, "AssetRecordDescriptor.lineage") : { parentAssetIds: [], transformation: "original" },
    availability: assetAvailability(record.availability, "AssetRecordDescriptor.availability"),
  };
}

export function readAssetLedgerDescriptor(value: unknown): CreativeAssetLedgerDescriptor {
  const record = exactRecord(value, ["brief", "createdAt", "assets"], ["parent"], "CreativeAssetLedgerDescriptor");
  return { brief: record.brief as CreativeBrief, createdAt: isoTime(record.createdAt, "CreativeAssetLedgerDescriptor.createdAt"), assets: record.assets as never, ...(Object.hasOwn(record, "parent") ? { parent: record.parent as never } : {}) };
}

export function readCreativeRunDescriptor(value: unknown): CreativeRunDescriptor {
  const record = exactRecord(value, ["brief", "shotPlan", "assetLedger", "createdAt", "assetBindings"], [], "CreativeRunDescriptor");
  return { brief: record.brief as never, shotPlan: record.shotPlan as never, assetLedger: record.assetLedger as never, createdAt: isoTime(record.createdAt, "CreativeRunDescriptor.createdAt"), assetBindings: readAssetBindings(record.assetBindings, "CreativeRunDescriptor.assetBindings") };
}

export function readReviewDecisionDescriptor(value: unknown): ReviewDecisionDescriptor {
  const record = exactRecord(value, ["run", "shotPlan", "createdAt", "reviewer", "outcome", "findings"], [], "ReviewDecisionDescriptor");
  return { run: record.run as never, shotPlan: record.shotPlan as never, createdAt: isoTime(record.createdAt, "ReviewDecisionDescriptor.createdAt"), reviewer: readActor(record.reviewer, "ReviewDecisionDescriptor.reviewer"), outcome: reviewOutcome(record.outcome, "ReviewDecisionDescriptor.outcome"), findings: record.findings as never };
}

export function readShotPlanShots(value: unknown, label: string): readonly ShotPlanShot[] {
  const entries = exactArray(value, label, MAX_CREATIVE_SHOTS, 1), shots = entries.map((entry, index) => readShot(entry, `${label}[${index}]`));
  const ids = shots.map((shot) => shot.id), slotKeys = shots.flatMap((shot) => shot.assetSlots.map((slot) => slotKey(shot.id, slot.id)));
  if (new Set(ids).size !== ids.length) throw new Error(`${label} shot ids must be unique.`);
  if (new Set(slotKeys).size !== slotKeys.length) throw new Error(`${label} asset slot ids must be unique per shot.`);
  if (slotKeys.length > MAX_CREATIVE_ASSET_SLOTS) throw new Error(`${label} exceeds the ${MAX_CREATIVE_ASSET_SLOTS}-slot limit.`);
  return freeze(shots);
}

function readShot(value: unknown, label: string): ShotPlanShot {
  const record = exactRecord(value, ["id", "startUs", "durationUs", "purpose", "actionIds", "assetSlots"], [], label);
  const startUs = safeUs(record.startUs, `${label}.startUs`), durationUs = positiveInteger(record.durationUs, `${label}.durationUs`, MAX_CREATIVE_SHOT_DURATION_US);
  if (!Number.isSafeInteger(startUs + durationUs)) throw new Error(`${label} startUs plus durationUs exceeds safe integer range.`);
  return freeze({ id: safeId(record.id, `${label}.id`), startUs, durationUs, purpose: boundedString(record.purpose, `${label}.purpose`, 512), actionIds: readActionIds(record.actionIds, `${label}.actionIds`), assetSlots: readShotAssetSlots(record.assetSlots, `${label}.assetSlots`) });
}

function readActionIds(value: unknown, label: string): readonly string[] {
  const ids = exactArray(value, label, 16, 0).map((entry, index) => safeId(entry, `${label}[${index}]`));
  if (new Set(ids).size !== ids.length) throw new Error(`${label} must not repeat action ids.`);
  return freeze(ids);
}

function readShotAssetSlots(value: unknown, label: string): readonly ShotAssetSlot[] {
  const entries = exactArray(value, label, 8, 0), seen = new Set<string>();
  return freeze(entries.map((entry, index) => {
    const path = `${label}[${index}]`, record = exactRecord(entry, ["id", "kind", "required", "minimumRights", "allowedOrigins"], [], path), id = safeId(record.id, `${path}.id`);
    if (seen.has(id)) throw new Error(`${path}.id must be unique within its shot.`); seen.add(id);
    if (typeof record.required !== "boolean") throw new Error(`${path}.required must be boolean.`);
    if (record.minimumRights !== "asserted" && record.minimumRights !== "cleared") throw new Error(`${path}.minimumRights must be asserted or cleared.`);
    return freeze({ id, kind: assetKind(record.kind, `${path}.kind`), required: record.required, minimumRights: record.minimumRights, allowedOrigins: sortedOrigins(record.allowedOrigins, `${path}.allowedOrigins`) });
  }));
}

export function readShotPlanBudget(value: unknown, label: string): ShotPlanBudget {
  const record = exactRecord(value, ["actionLimit", "revisionLimit"], [], label);
  return freeze({ actionLimit: positiveInteger(record.actionLimit, `${label}.actionLimit`, MAX_CREATIVE_ACTIONS), revisionLimit: positiveInteger(record.revisionLimit, `${label}.revisionLimit`, MAX_CREATIVE_REVISION_ATTEMPTS) });
}
export function validateShotBudget(shots: readonly ShotPlanShot[], budget: ShotPlanBudget): void {
  const actions = shots.reduce((count, shot) => count + shot.actionIds.length, 0);
  if (actions > budget.actionLimit) throw new Error(`ShotPlan has ${actions} actions, exceeding its actionLimit of ${budget.actionLimit}.`);
  if (actions > MAX_CREATIVE_ACTIONS) throw new Error(`ShotPlan exceeds the ${MAX_CREATIVE_ACTIONS}-action limit.`);
}
export function readCapabilityIds(value: unknown, label: string): readonly string[] {
  const ids = exactArray(value, label, 16, 0).map((entry, index) => boundedString(entry, `${label}[${index}]`, 96));
  if (!strictlySorted(ids)) throw new Error(`${label} must be strict code-unit ascending and unique.`);
  if (ids.some((id) => !CAPABILITY_IDS.has(id))) throw new Error(`${label} must contain canonical renderer capability-card ids.`);
  return freeze(ids);
}
export function readShotPlanApproval(value: unknown, label: string): ShotPlanApproval {
  const initial = plainRecord(value, label);
  if (initial.status === "proposed") { exactRecord(initial, ["status"], [], label); return freeze({ status: "proposed" }); }
  const record = exactRecord(initial, ["status", "decidedBy", "decidedAt", "reason"], [], label);
  if (record.status !== "approved" && record.status !== "rejected") throw new Error(`${label}.status must be proposed, approved, or rejected.`);
  return freeze({ status: record.status, decidedBy: readApprovalActor(record.decidedBy, `${label}.decidedBy`), decidedAt: isoTime(record.decidedAt, `${label}.decidedAt`), reason: boundedString(record.reason, `${label}.reason`, 512) });
}
export function readApprovalActor(value: unknown, label: string) {
  const actor = readActor(value, label);
  if (actor.kind === "ai") throw new Error(`${label}.kind must be human or policy; AI may only propose.`);
  return actor;
}

export function readAssetOrigin(value: unknown, label: string): CreativeAssetOrigin {
  const record = exactRecord(value, ["kind", "reference", "capturedAt"], [], label), reference = boundedString(record.reference, `${label}.reference`, 256);
  if (!OPAQUE_ORIGIN_REFERENCE.test(reference)) throw new Error(`${label}.reference must be an opaque non-path handle.`);
  return freeze({ kind: assetOrigin(record.kind, `${label}.kind`), reference, capturedAt: isoTime(record.capturedAt, `${label}.capturedAt`) });
}
export function readAssetRights(value: unknown, label: string): CreativeAssetRights {
  const record = exactRecord(value, ["status", "statement"], ["evidenceSha256"], label);
  return freeze({ status: assetRights(record.status, `${label}.status`), statement: boundedString(record.statement, `${label}.statement`, 512), ...(Object.hasOwn(record, "evidenceSha256") ? { evidenceSha256: sha256(record.evidenceSha256, `${label}.evidenceSha256`) } : {}) });
}
export function readAssetLineage(value: unknown, label: string): CreativeAssetLineage {
  const record = exactRecord(value, ["parentAssetIds", "transformation"], [], label);
  return freeze({ parentAssetIds: sortedAssetIds(record.parentAssetIds, `${label}.parentAssetIds`, 8), transformation: boundedString(record.transformation, `${label}.transformation`, 256) });
}
export function readAssetBindings(value: unknown, label: string): readonly CreativeAssetBinding[] {
  const entries = exactArray(value, label, MAX_CREATIVE_ASSET_SLOTS, 0), seen = new Set<string>();
  const bindings = entries.map((entry, index) => {
    const path = `${label}[${index}]`, record = exactRecord(entry, ["shotId", "slotId", "assetId", "assetRecordSha256"], [], path), shotId = safeId(record.shotId, `${path}.shotId`), slotId = safeId(record.slotId, `${path}.slotId`), key = slotKey(shotId, slotId);
    if (seen.has(key)) throw new Error(`${path} duplicates asset slot ${key}.`); seen.add(key);
    return freeze({ shotId, slotId, assetId: assetId(record.assetId, `${path}.assetId`), assetRecordSha256: sha256(record.assetRecordSha256, `${path}.assetRecordSha256`) });
  });
  if (!strictlySorted(bindings.map(bindingKey))) throw new Error(`${label} must be strict code-unit ascending by shotId and slotId.`);
  return freeze(bindings);
}
export function readReviewFindings(value: unknown, label: string, plan?: ShotPlan): readonly CreativeReviewFinding[] {
  const entries = exactArray(value, label, MAX_CREATIVE_REVIEW_FINDINGS, 0), seen = new Set<string>(), shotIds = plan ? new Set(plan.shots.map((shot) => shot.id)) : undefined;
  const findings = entries.map((entry, index) => {
    const path = `${label}[${index}]`, record = exactRecord(entry, ["id", "severity", "code", "message"], ["shotId", "atUs", "region"], path), id = safeId(record.id, `${path}.id`);
    if (seen.has(id)) throw new Error(`${path}.id must be unique.`); seen.add(id);
    const shotId = Object.hasOwn(record, "shotId") ? safeId(record.shotId, `${path}.shotId`) : undefined;
    if (shotIds && shotId && !shotIds.has(shotId)) throw new Error(`${path}.shotId must name a ShotPlan shot.`);
    const atUs = Object.hasOwn(record, "atUs") ? safeUs(record.atUs, `${path}.atUs`) : undefined, region = Object.hasOwn(record, "region") ? readReviewRegion(record.region, `${path}.region`) : undefined;
    if ((atUs !== undefined || region !== undefined) && !shotId) throw new Error(`${path} frame or region findings require shotId.`);
    return freeze({ id, severity: findingSeverity(record.severity, `${path}.severity`), code: safeId(record.code, `${path}.code`), message: boundedString(record.message, `${path}.message`, 1_024), ...(shotId ? { shotId } : {}), ...(atUs === undefined ? {} : { atUs }), ...(region ? { region } : {}) });
  });
  if (!strictlySorted(findings.map((finding) => finding.id))) throw new Error(`${label} must be strict code-unit ascending by id.`);
  return freeze(findings);
}
function readReviewRegion(value: unknown, label: string): CreativeReviewRegion {
  const record = exactRecord(value, ["x", "y", "width", "height"], [], label), x = unit(record.x, `${label}.x`), y = unit(record.y, `${label}.y`), width = unit(record.width, `${label}.width`), height = unit(record.height, `${label}.height`);
  if (width === 0 || height === 0 || x + width > 1 || y + height > 1) throw new Error(`${label} must be a non-empty normalized region within [0,1].`);
  return freeze({ x, y, width, height });
}
export function validateReviewOutcome(outcome: CreativeReviewOutcome, findings: readonly CreativeReviewFinding[]): void {
  if (outcome === "accepted" && findings.some((finding) => finding.severity === "error")) throw new Error("ReviewDecision accepted outcome cannot retain error findings.");
  if (outcome === "changes_requested" && !findings.some((finding) => finding.severity === "warning" || finding.severity === "error")) throw new Error("ReviewDecision changes_requested outcome requires a warning or error finding.");
}

export function readCreativeRunStatus(value: unknown, label: string) { return creativeRunStatus(value, label); }
