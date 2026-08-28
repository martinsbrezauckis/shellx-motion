import {
  CREATIVE_COMPILE_READINESS_SCHEMA,
  type CreativeAssetBinding,
  type CreativeAssetLedger,
  type CreativeBrief,
  type CreativeCompileIssue,
  type CreativeCompileReadiness,
  type CreativeCompileReadinessResult,
  type CreativeRun,
  type ShotPlan,
} from "./creative-contract-types";
import { exactRecord, freeze, identity, issue, rightsSatisfy, sameIdentity, sealRecord, slotKey, snapshotCreativeContractData } from "./creative-contract-data";
import { readCreativeAssetLedger, readCreativeBrief, readShotPlan } from "./creative-contract-records";
import { readCreativeRun } from "./creative-contract-run-review";

/**
 * Pure plan admission. It emits only a sealed identity/binding plan and cannot author
 * a package, invoke an action, submit a job, contact a provider, or render media.
 */
export function validateCreativeCompileReadiness(value: unknown): CreativeCompileReadinessResult {
  try {
    const input = exactRecord(snapshotCreativeContractData(value), ["brief", "shotPlan", "assetLedger", "run"], [], "CreativeCompileReadiness");
    const brief = readCreativeBrief(input.brief), shotPlan = readShotPlan(input.shotPlan), assetLedger = readCreativeAssetLedger(input.assetLedger), run = readCreativeRun(input.run);
    const issues: CreativeCompileIssue[] = [];
    validateJoin(brief, shotPlan, assetLedger, run, issues);
    if (shotPlan.approval.status !== "approved") issues.push(issue("/shotPlan/approval", "plan.approval", "must be approved before plan-only compilation readiness"));
    if (run.status !== "planned") issues.push(issue("/run/status", "run.status", "must be planned before plan-only compilation readiness"));
    validateUnresolvedActions(shotPlan, issues);
    validateAssetBindings(shotPlan, assetLedger, run, issues);
    if (issues.length) return { ok: false, issues: freeze(issues) };
    const bindings = orderedBindings(shotPlan, run.assetBindings);
    return { ok: true, readiness: sealRecord("creative_compile", { schema: CREATIVE_COMPILE_READINESS_SCHEMA, run: identity(run), shotPlan: identity(shotPlan), assetLedger: identity(assetLedger), bindings }) as CreativeCompileReadiness };
  } catch (error) {
    return { ok: false, issues: freeze([issue("/", "contract.invalid", error instanceof Error ? error.message : "Creative contract validation failed.")]) };
  }
}

function validateJoin(brief: CreativeBrief, plan: ShotPlan, ledger: CreativeAssetLedger, run: CreativeRun, issues: CreativeCompileIssue[]): void {
  if (!sameIdentity(plan.brief, identity(brief))) issues.push(issue("/shotPlan/brief", "brief.identity", "does not bind the supplied CreativeBrief identity"));
  if (!sameIdentity(ledger.brief, identity(brief))) issues.push(issue("/assetLedger/brief", "brief.identity", "does not bind the supplied CreativeBrief identity"));
  if (!sameIdentity(run.brief, identity(brief)) || !sameIdentity(run.shotPlan, identity(plan)) || !sameIdentity(run.assetLedger, identity(ledger))) issues.push(issue("/run", "run.identity", "does not bind the exact supplied brief, shot plan, and asset ledger identities"));
}

function validateUnresolvedActions(plan: ShotPlan, issues: CreativeCompileIssue[]): void {
  plan.shots.forEach((shot, shotIndex) => shot.actionIds.forEach((actionId, actionIndex) => {
    issues.push(issue(`/shotPlan/shots/${shotIndex}/actionIds/${actionIndex}`, "action.lifecycle_unavailable", `action '${actionId}' is not compile-ready until the C4 action registry and materialization lifecycle exist`));
  }));
}

function validateAssetBindings(plan: ShotPlan, ledger: CreativeAssetLedger, run: CreativeRun, issues: CreativeCompileIssue[]): void {
  const slots = new Map<string, { path: string; slot: ShotPlan["shots"][number]["assetSlots"][number] }>();
  plan.shots.forEach((shot, shotIndex) => shot.assetSlots.forEach((slot, slotIndex) => slots.set(slotKey(shot.id, slot.id), { path: `/shotPlan/shots/${shotIndex}/assetSlots/${slotIndex}`, slot })));
  const assets = new Map(ledger.assets.map((asset) => [asset.id, asset]));
  const bindings = new Map(run.assetBindings.map((binding) => [slotKey(binding.shotId, binding.slotId), binding]));
  for (const [key, binding] of bindings) {
    const slot = slots.get(key);
    if (!slot) { issues.push(issue(`/run/assetBindings/${key}`, "slot.unknown", "does not name a ShotPlan asset slot")); continue; }
    const asset = assets.get(binding.assetId);
    if (!asset) { issues.push(issue(`/run/assetBindings/${key}`, "asset.missing", "does not name an AssetRecord in the supplied ledger")); continue; }
    if (asset.sha256 !== binding.assetRecordSha256) issues.push(issue(`/run/assetBindings/${key}`, "asset.stale_identity", "does not bind the current immutable AssetRecord hash"));
    if (asset.availability !== "available") issues.push(issue(`/run/assetBindings/${key}`, "asset.revoked", "binds a revoked asset"));
    if (asset.kind !== slot.slot.kind) issues.push(issue(`/run/assetBindings/${key}`, "asset.kind", `requires ${slot.slot.kind}, received ${asset.kind}`));
    if (!slot.slot.allowedOrigins.includes(asset.origin.kind)) issues.push(issue(`/run/assetBindings/${key}`, "asset.origin", "origin is not compatible with the asset slot"));
    if (!rightsSatisfy(slot.slot.minimumRights, asset.rights.status)) issues.push(issue(`/run/assetBindings/${key}`, "asset.rights", "rights assertion does not satisfy the asset slot"));
  }
  for (const [key, slot] of slots) if (slot.slot.required && !bindings.has(key)) issues.push(issue(slot.path, "slot.unsatisfied", "required asset slot has no immutable ledger binding"));
}

function orderedBindings(plan: ShotPlan, bindings: readonly CreativeAssetBinding[]): readonly CreativeAssetBinding[] {
  const bySlot = new Map(bindings.map((binding) => [slotKey(binding.shotId, binding.slotId), binding]));
  const ordered: CreativeAssetBinding[] = [];
  for (const shot of plan.shots) for (const slot of shot.assetSlots) {
    const binding = bySlot.get(slotKey(shot.id, slot.id));
    if (binding) ordered.push(binding);
  }
  return freeze(ordered);
}
