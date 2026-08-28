import { describe, expect, it } from "vitest";
import {
  approveShotPlan,
  applyReviewDecisionToCreativeRun,
  createAssetRecord,
  createCreativeAssetLedger,
  createCreativeBrief,
  createCreativeRun,
  createCreativeRunRevision,
  createReviewDecision,
  createShotPlan,
  readCreativeBrief,
  readShotPlan,
  snapshotCreativeContractData,
  validateCreativeCompileReadiness,
} from "./creative-contract";

const T0 = "2026-08-19T10:00:00.000Z";
const T1 = "2026-08-19T10:01:00.000Z";
const T2 = "2026-08-19T10:02:00.000Z";
const HASH_A = "a".repeat(64);

function brief() {
  return createCreativeBrief({
    createdAt: T0, author: { kind: "ai", id: "planner" }, prompt: "Describe a clear, accessible short animation.",
    goals: ["clarity"], constraints: ["no unlicensed material"],
  });
}

function asset(overrides: Record<string, unknown> = {}) {
  return createAssetRecord({
    kind: "image", mediaType: "image/png", contentSha256: HASH_A, byteLength: 1024,
    origin: { kind: "generated", reference: "source_asset_001", capturedAt: T0 },
    rights: { status: "cleared", statement: "Approved for this run." }, availability: "available",
    ...overrides,
  });
}

function plan(input: { brief?: ReturnType<typeof brief>; actions?: string[]; minimumRights?: "asserted" | "cleared"; parent?: ReturnType<typeof createShotPlan> } = {}) {
  return createShotPlan({
    brief: input.brief ?? brief(), createdAt: T0, capabilityIds: [], budget: { actionLimit: 8, revisionLimit: 2 },
    shots: [{ id: "opening", startUs: 0, durationUs: 1_000_000, purpose: "Establish the message.", actionIds: input.actions ?? [], assetSlots: [{ id: "hero", kind: "image", required: true, minimumRights: input.minimumRights ?? "cleared", allowedOrigins: ["generated"] }] }],
    ...(input.parent ? { parent: input.parent } : {}),
  });
}

function approved(value = plan()) {
  return approveShotPlan(value, { decidedBy: { kind: "human", id: "reviewer" }, decidedAt: T1, reason: "Creative plan accepted." });
}

function ledger(source: ReturnType<typeof brief>, item = asset()) {
  return createCreativeAssetLedger({ brief: source, createdAt: T0, assets: [item] });
}

function run(source: ReturnType<typeof brief>, shotPlan: ReturnType<typeof createShotPlan>, assetLedger: ReturnType<typeof createCreativeAssetLedger>, item = asset()) {
  return createCreativeRun({
    brief: source, shotPlan, assetLedger, createdAt: T0,
    assetBindings: [{ shotId: "opening", slotId: "hero", assetId: item.id, assetRecordSha256: item.sha256 }],
  });
}

describe("private creative contract foundation", () => {
  it("seals immutable canonical records and refuses stale identities", () => {
    const first = brief(), replay = brief();
    expect(replay).toEqual(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.goals)).toBe(true);
    expect(readCreativeBrief(JSON.parse(JSON.stringify(first)))).toEqual(first);
    expect(() => readCreativeBrief({ ...first, prompt: "A different prompt." })).toThrow("stale");

    const candidate = plan({ brief: first });
    expect(() => readShotPlan({ ...candidate, budget: { ...candidate.budget, actionLimit: 2 } })).toThrow("stale");
  });

  it("uses descriptor-first bounded admission before getters or unbounded reflection", () => {
    let ownKeys = 0, descriptors = 0, gets = 0;
    const hostile = new Proxy({}, {
      ownKeys: () => { ownKeys += 1; return Array.from({ length: 10_000 }, (_, index) => `bad${index}`); },
      getOwnPropertyDescriptor: () => { descriptors += 1; return undefined; }, get: () => { gets += 1; return undefined; },
    });
    expect(() => snapshotCreativeContractData(hostile)).toThrow("16-field record limit");
    expect({ ownKeys, descriptors, gets }).toEqual({ ownKeys: 1, descriptors: 0, gets: 0 });

    const accessor: Record<string, unknown> = { createdAt: T0, author: { kind: "ai", id: "planner" }, goals: ["clarity"], constraints: [] };
    let reads = 0;
    Object.defineProperty(accessor, "prompt", { enumerable: true, get() { reads += 1; return "should not read"; } });
    expect(() => createCreativeBrief(accessor)).toThrow("enumerable data field");
    expect(reads).toBe(0);
    expect(() => snapshotCreativeContractData({ values: Array(1) })).toThrow("dense");
  });

  it("caps plans and binds capability requirements to current capability cards", () => {
    const source = brief();
    const shots = Array.from({ length: 17 }, (_, index) => ({ id: `s${index}`, startUs: index, durationUs: 1, purpose: "bounded", actionIds: [], assetSlots: [] }));
    expect(() => createShotPlan({ brief: source, createdAt: T0, capabilityIds: [], budget: { actionLimit: 64, revisionLimit: 1 }, shots })).toThrow("1..16");
    expect(() => createShotPlan({ brief: source, createdAt: T0, capabilityIds: ["not-a-capability-card"], budget: { actionLimit: 1, revisionLimit: 1 }, shots: [shots[0]] })).toThrow("canonical renderer capability-card ids");
    expect(() => createCreativeBrief({ createdAt: T0, author: { kind: "human", id: "author" }, prompt: "brief", goals: ["goal"], constraints: [], referenceAssetIds: ["asset_not_a_hash"] })).toThrow("canonical asset id");
  });

  it("allows only human or policy approval and records the immutable approval successor", () => {
    const proposed = plan();
    expect(() => approveShotPlan(proposed, { decidedBy: { kind: "ai", id: "planner" }, decidedAt: T1, reason: "Looks good." })).toThrow("human or policy");
    const accepted = approved(proposed);
    expect(accepted.approval.status).toBe("approved");
    expect(accepted.parentRevision).toEqual({ id: proposed.id, sha256: proposed.sha256 });
    expect(() => approveShotPlan(accepted, { decidedBy: { kind: "policy", id: "gate" }, decidedAt: T2, reason: "duplicate" })).toThrow("terminal");
  });

  it("makes readiness pure and requires approved plans, compatible current assets, and no unresolved actions", () => {
    const source = brief(), item = asset(), accepted = approved(plan({ brief: source })), assets = ledger(source, item), planned = run(source, accepted, assets, item);
    const readiness = validateCreativeCompileReadiness({ brief: source, shotPlan: accepted, assetLedger: assets, run: planned });
    expect(readiness).toMatchObject({ ok: true, readiness: { schema: "shellx-motion/creative-compile-readiness@1", run: { id: planned.id } } });
    if (readiness.ok) expect(Object.isFrozen(readiness.readiness.bindings)).toBe(true);

    const proposed = plan({ brief: source });
    const pending = run(source, proposed, assets, item);
    expect(validateCreativeCompileReadiness({ brief: source, shotPlan: proposed, assetLedger: assets, run: pending })).toMatchObject({ ok: false, issues: [expect.objectContaining({ code: "plan.approval" })] });

    const actionPlan = approved(plan({ brief: source, actions: ["motion.action.fade"] }));
    const actionRun = run(source, actionPlan, assets, item);
    expect(validateCreativeCompileReadiness({ brief: source, shotPlan: actionPlan, assetLedger: assets, run: actionRun })).toMatchObject({ ok: false, issues: [expect.objectContaining({ code: "action.lifecycle_unavailable" })] });
  });

  it("rejects revoked, stale, wrong-rights, and missing slot bindings without mutation", () => {
    const source = brief(), accepted = approved(plan({ brief: source })), current = asset(), validLedger = ledger(source, current);
    const revoked = asset({ availability: "revoked" }), revokedLedger = ledger(source, revoked), revokedRun = run(source, accepted, revokedLedger, revoked);
    expect(validateCreativeCompileReadiness({ brief: source, shotPlan: accepted, assetLedger: revokedLedger, run: revokedRun })).toMatchObject({ ok: false, issues: [expect.objectContaining({ code: "asset.revoked" })] });

    const replaced = asset({ rights: { status: "cleared", statement: "Replacement rights assertion." } }), replacementLedger = ledger(source, replaced);
    const staleRun = run(source, accepted, replacementLedger, current);
    expect(validateCreativeCompileReadiness({ brief: source, shotPlan: accepted, assetLedger: replacementLedger, run: staleRun })).toMatchObject({ ok: false, issues: [expect.objectContaining({ code: "asset.stale_identity" })] });

    const asserted = asset({ rights: { status: "asserted", statement: "Not cleared." } }), assertedLedger = ledger(source, asserted), assertedRun = run(source, accepted, assertedLedger, asserted);
    expect(validateCreativeCompileReadiness({ brief: source, shotPlan: accepted, assetLedger: assertedLedger, run: assertedRun })).toMatchObject({ ok: false, issues: [expect.objectContaining({ code: "asset.rights" })] });

    const missing = createCreativeRun({ brief: source, shotPlan: accepted, assetLedger: validLedger, createdAt: T0, assetBindings: [] });
    expect(validateCreativeCompileReadiness({ brief: source, shotPlan: accepted, assetLedger: validLedger, run: missing })).toMatchObject({ ok: false, issues: [expect.objectContaining({ code: "slot.unsatisfied" })] });
    expect(() => createCreativeRun({ brief: source, shotPlan: accepted, assetLedger: validLedger, createdAt: T0, assetBindings: [{ shotId: "opening", slotId: "hero", assetId: "asset_not_a_hash", assetRecordSha256: current.sha256 }] })).toThrow("canonical asset id");
  });

  it("refuses path-like provenance references and bounds typed revisions to reviewed base identities", () => {
    for (const reference of ["/tmp/input.png", "C:\\asset.png", "provider://remote/item", "../asset"]) {
      expect(() => asset({ origin: { kind: "generated", reference, capturedAt: T0 } })).toThrow("opaque non-path");
    }
    const source = brief(), item = asset(), accepted = approved(plan({ brief: source })), assets = ledger(source, item), initial = run(source, accepted, assets, item);
    const review = createReviewDecision({ run: initial, shotPlan: accepted, createdAt: T1, reviewer: { kind: "ai", id: "critic" }, outcome: "changes_requested", findings: [{ id: "finding", severity: "warning", code: "contrast", message: "Improve contrast.", shotId: "opening", atUs: 0, region: { x: 0, y: 0, width: 1, height: 1 } }] });
    const reviewed = applyReviewDecisionToCreativeRun(initial, review);
    const expectedBase = { brief: { id: source.id, sha256: source.sha256 }, shotPlan: { id: accepted.id, sha256: accepted.sha256 }, assetLedger: { id: assets.id, sha256: assets.sha256 } };
    const next = createCreativeRunRevision({ priorRun: reviewed, reviewDecision: review, expectedBase, brief: source, shotPlan: accepted, assetLedger: assets, createdAt: T2, assetBindings: [{ shotId: "opening", slotId: "hero", assetId: item.id, assetRecordSha256: item.sha256 }] });
    expect(next).toMatchObject({ attempt: 2, parentRevision: { id: reviewed.id } });

    const otherBrief = createCreativeBrief({ createdAt: T0, author: { kind: "human", id: "other" }, prompt: "Other", goals: ["other"], constraints: [] });
    const otherPlan = approved(plan({ brief: otherBrief })), otherAsset = asset({ contentSha256: "b".repeat(64) }), otherLedger = ledger(otherBrief, otherAsset);
    expect(() => createCreativeRunRevision({ priorRun: reviewed, reviewDecision: review, expectedBase, brief: otherBrief, shotPlan: otherPlan, assetLedger: otherLedger, createdAt: T2, assetBindings: [{ shotId: "opening", slotId: "hero", assetId: otherAsset.id, assetRecordSha256: otherAsset.sha256 }] })).toThrow("retain or directly succeed");
  });
});
