import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { createCheckpointStoryboard, createTransitionRecipe } from "@shellx-motion/core/internal/checkpoint-storyboard-behavior-profile";
import { configureCheckpointStoryboardBehaviorResolutionAuthority, dispatchDebugCommand } from "../index.js";
import { resolveCheckpointStoryboardBehaviorStoredRecord, setCheckpointStoryboardBehaviorResolutionFaultHooksForTest } from "./checkpoint-storyboard-behavior-resolution.js";
import { configureCheckpointStoryboardMaterializationAuthority } from "./checkpoint-storyboard-materialization-authority.js";
import { detachCheckpointStoryboardStoredRecord, materializeCheckpointStoryboardStoredRecord } from "./checkpoint-storyboard-materialization.js";
import { CHECKPOINT_STORYBOARD_RECORD_COMMANDS } from "./checkpoint-storyboard-record-lifecycle.js";
import { archiveCheckpointStoryboardStoredLineage, configureCheckpointStoryboardRecordStore, createCheckpointStoryboardStoredRecord, inspectCheckpointStoryboardStoredRecordAuditView, tombstoneCheckpointStoryboardStoredRecord } from "./checkpoint-storyboard-record-store.js";

const behaviorJournal = (root: string, id: string, suffix: string) => join(root, ".shellx-motion-c6c-record-store", "behavior-resolutions", `${id}.${suffix}.json`);
const b1Descriptor = () => ({
  seed: 1, capabilityRequirements: ["renderer.native"], objectCatalog: [{ objectId: "orb", rootShapeKind: "ellipse", propertyMask: ["transform.x", "transform.y", "transform.rotation", "transform.scale", "opacity"] }],
  checkpoints: [
    { id: "start", atUs: 0, objects: [{ objectId: "orb", state: "present", properties: [{ property: "transform.x", value: 0 }, { property: "transform.y", value: 0 }, { property: "transform.rotation", value: 0 }, { property: "transform.scale", value: 1 }, { property: "opacity", value: 1 }] }] },
    { id: "finish", atUs: 1_000_000, objects: [{ objectId: "orb", state: "present", properties: [{ property: "transform.x", value: 100 }, { property: "transform.y", value: 50 }, { property: "transform.rotation", value: 90 }, { property: "transform.scale", value: 2 }, { property: "opacity", value: 0.5 }] }] },
  ],
  edges: [{ id: "edge", fromCheckpointId: "start", toCheckpointId: "finish", lifecycle: [{ kind: "preserve", objectId: "orb" }], recipeIds: ["scalar", "spatial"] }],
  recipes: [{ recipeId: "scalar", seed: 2, exactBaseRequirements: [], intent: { kind: "checkpoint-keyframe", easing: "ease-in-out", targets: [{ objectId: "orb", propertyMask: ["transform.rotation", "transform.scale", "opacity"] }] } }, { recipeId: "spatial", seed: 3, exactBaseRequirements: [], intent: { kind: "checkpoint-spatial-path", targets: [{ objectId: "orb", tangentMode: "auto" }] } }],
});

const roots: string[] = [];
const itLinux = process.platform === "linux" ? it : it.skip;
afterEach(async () => await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))));

async function fixture(kind: "gravity" | "bounce" = "gravity") {
  const root = await mkdtemp(join(process.cwd(), ".c6c-b2-resolution-")); roots.push(root);
  const workspace = join(root, "workspace"), source = join(workspace, "source"), output = join(workspace, "output");
  const baseY = kind === "gravity" ? 20 : 0, endY = kind === "gravity" ? 40 : 5;
  await mkdir(join(source, "assets"), { recursive: true });
  await writeFile(join(source, "manifest.json"), JSON.stringify({ schema: "shellx-motion/package-manifest@1", id: "package-b2", name: "B2", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["gpu"], hosts: [] } }));
  await writeFile(join(source, "motion.json"), JSON.stringify({ schema: "shellx-motion/motion@1", id: "motion-b2", name: "B2", durationMs: 1000, fps: 30, width: 1280, height: 720, layers: [{ id: "orb", type: "shape", shape: "ellipse", startMs: 0, durationMs: 1000, transform: { x: 10, y: baseY } }], assets: [], provenance: { sourceApp: "test", createdBy: "test" } }));
  await writeFile(join(source, "assets", "retained.txt"), "retained\n");
  const store = await configureCheckpointStoryboardRecordStore({ root, integrityKey: Buffer.alloc(32, 23) });
  const anchor = await createTrustedWorkspaceAnchor(workspace);
  const authority = await configureCheckpointStoryboardBehaviorResolutionAuthority({ recordStore: store, sourcePackageRoot: source, outputPackageRoot: output, packageWorkspaceRoot: workspace, packageWorkspaceAuthority: anchor, objectLayerBinding: { objectId: "orb", layerId: "orb" } });
  const behavior = kind === "gravity" ? { kind: "gravity" as const, velocityX: 30, velocityY: 10, gravityY: 20 } : { kind: "bounce" as const, floorY: 5, velocityY: 0, gravityY: 10, restitution: 0 };
  const storyboard = createCheckpointStoryboard({
    seed: 1, capabilityRequirements: ["renderer.gpu"], objectCatalog: [{ objectId: "orb", rootShapeKind: "ellipse", propertyMask: kind === "gravity" ? ["transform.x", "transform.y"] : ["transform.y"] }],
    checkpoints: [
      { id: "start", atUs: 0, objects: [{ objectId: "orb", state: "present", properties: kind === "gravity" ? [{ property: "transform.x", value: 10 }, { property: "transform.y", value: baseY }] : [{ property: "transform.y", value: baseY }] }] },
      { id: "finish", atUs: 1_000_000, objects: [{ objectId: "orb", state: "present", properties: kind === "gravity" ? [{ property: "transform.x", value: 40 }, { property: "transform.y", value: endY }] : [{ property: "transform.y", value: endY }] }] },
    ], edges: [{ id: "edge", fromCheckpointId: "start", toCheckpointId: "finish", lifecycle: [{ kind: "preserve", objectId: "orb" }], recipeIds: ["behavior"] }], recipes: [createTransitionRecipe({ recipeId: "behavior", seed: 2, exactBaseRequirements: [], intent: { kind: "transform-behavior", targetObjectId: "orb", behavior } })],
  });
  const created = await createCheckpointStoryboardStoredRecord(store, storyboard);
  return { root, workspace, source, output, store, authority, created };
}

describe("C6C B2 private behavior resolution", () => {
  itLinux.each(["gravity", "bounce"] as const)("resolves %s exactly once, replays a sealed link, and detaches without output deletion", async (kind) => {
    const value = await fixture(kind), identity = value.created.record.identity;
    expect(value.created.record.admission).toEqual({ staticProfileAdmitted: true, profile: "c6b2-behavior@1" });
    const first = await dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.behaviorResolve, { identity }, { tier: "write_local", checkpointStoryboardRecordStore: value.store, checkpointStoryboardBehaviorResolutionAuthority: value.authority });
    expect(first).toMatchObject({ ok: true, result: { renderer: { invoked: false, pixels: false }, binding: { state: "bound", active: 1 } } });
    if (!first.ok) throw new Error("Expected behavior resolve success.");
    expect(JSON.stringify(first)).not.toContain(value.workspace);
    const replay = await resolveCheckpointStoryboardBehaviorStoredRecord(value.authority, identity);
    expect(replay).toMatchObject({ replayed: true, binding: { state: "bound" } });
    await rm(value.source, { recursive: true });
    const detached = await dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.behaviorDetach, { identity }, { tier: "write_local", checkpointStoryboardRecordStore: value.store, checkpointStoryboardBehaviorResolutionAuthority: value.authority });
    expect(detached).toMatchObject({ ok: true, result: { binding: { state: "detached", active: 0 }, renderer: { invoked: false, pixels: false } } });
    await expect(lstat(value.output)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
    await expect(readFile(join(value.output, "receipts", "checkpoint-storyboard-behavior-materialization.v1.json"), "utf8")).resolves.toContain("checkpoint-storyboard.behavior.materialize");
  });

  itLinux("uses exact identity-only transport, refuses missing authority, and completes a binding-head interruption without a second COW", async () => {
    const value = await fixture(), identity = value.created.record.identity;
    await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.behaviorResolve, { identity, outputPackageRoot: value.output }, { tier: "write_local", checkpointStoryboardRecordStore: value.store, checkpointStoryboardBehaviorResolutionAuthority: value.authority })).resolves.toMatchObject({ ok: false, error: { code: "invalid_args" } });
    await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.behaviorResolve, { identity }, { tier: "write_local", checkpointStoryboardRecordStore: value.store })).resolves.toMatchObject({ ok: false, error: { code: "capability_unavailable" } });
    setCheckpointStoryboardBehaviorResolutionFaultHooksForTest(value.authority, { "after-binding": () => { throw new Error(`${value.output}/do-not-leak`); } });
    await expect(resolveCheckpointStoryboardBehaviorStoredRecord(value.authority, identity)).rejects.toMatchObject({ code: "materialization_binding_uncertain" });
    setCheckpointStoryboardBehaviorResolutionFaultHooksForTest(value.authority, undefined);
    const recovered = await resolveCheckpointStoryboardBehaviorStoredRecord(value.authority, identity);
    expect(recovered).toMatchObject({ replayed: true, binding: { state: "bound", active: 1 } });
  });

  it("keeps the B1 and B2 partitions disjoint before resolution side effects", async () => {
    const value = await fixture(), b1 = await dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: b1Descriptor() }, { tier: "write_local", checkpointStoryboardRecordStore: value.store });
    expect(b1).toMatchObject({ ok: true, result: { record: { admission: { staticProfileAdmitted: true } } } });
    if (!b1.ok) throw new Error("Expected B1 record.");
    const b1Identity = (b1.result as { record: { identity: typeof value.created.record.identity } }).record.identity;
    await expect(resolveCheckpointStoryboardBehaviorStoredRecord(value.authority, b1Identity)).rejects.toMatchObject({ code: "materialization_profile_refused" });
    await expect(lstat(value.output)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.revise, { parent: value.created.record.identity, descriptor: b1Descriptor() }, { tier: "write_local", checkpointStoryboardRecordStore: value.store })).resolves.toMatchObject({ ok: false, error: { code: "record_identity_conflict" } });
    // A valid signed B1 head copied into the B2 namespace is still forbidden, even while unbound.
    await copyFile(join(value.root, ".shellx-motion-c6c-record-store", "bindings", `${b1Identity.id}.state.json`), join(value.root, ".shellx-motion-c6c-record-store", "bindings", `${value.created.record.identity.id}.state.json`));
    await expect(resolveCheckpointStoryboardBehaviorStoredRecord(value.authority, value.created.record.identity)).rejects.toMatchObject({ code: "store_integrity_failed" });
    await expect(lstat(value.output)).rejects.toMatchObject({ code: "ENOENT" });
    await copyFile(behaviorJournal(value.root, value.created.record.identity.id, "state"), behaviorJournal(value.root, b1Identity.id, "state"));
    await expect(inspectCheckpointStoryboardStoredRecordAuditView(value.store, b1Identity)).rejects.toMatchObject({ code: "store_integrity_failed" });
  });

  it("refuses legacy B1 materialize and detach on B2 before any B1 journal or output work", async () => {
    const value = await fixture(), identity = value.created.record.identity;
    const materialization = await configureCheckpointStoryboardMaterializationAuthority({ recordStore: value.store, sourcePackageRoot: value.source, outputPackageRoot: value.output, packageWorkspaceRoot: value.workspace, packageWorkspaceAuthority: await createTrustedWorkspaceAnchor(value.workspace), objectLayerBindings: [{ objectId: "orb", layerId: "orb" }] });
    await expect(materializeCheckpointStoryboardStoredRecord(materialization, identity)).rejects.toMatchObject({ code: "materialization_profile_refused" });
    await expect(detachCheckpointStoryboardStoredRecord(materialization, identity)).rejects.toMatchObject({ code: "materialization_profile_refused" });
    await expect(lstat(value.output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  itLinux("refuses B2 detach on a bound record carrying copied valid B1 state evidence without mutating its link or output", async () => {
    const value = await fixture(), identity = value.created.record.identity;
    await resolveCheckpointStoryboardBehaviorStoredRecord(value.authority, identity);
    const b1 = await dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: b1Descriptor() }, { tier: "write_local", checkpointStoryboardRecordStore: value.store });
    if (!b1.ok) throw new Error("Expected B1 record.");
    const b1Identity = (b1.result as { record: { identity: typeof identity } }).record.identity;
    const beforeState = await readFile(behaviorJournal(value.root, identity.id, "state"), "utf8");
    const beforeMotion = await readFile(join(value.output, "motion.json"), "utf8");
    const beforeReceipt = await readFile(join(value.output, "receipts", "checkpoint-storyboard-behavior-materialization.v1.json"), "utf8");
    await copyFile(join(value.root, ".shellx-motion-c6c-record-store", "bindings", `${b1Identity.id}.state.json`), join(value.root, ".shellx-motion-c6c-record-store", "bindings", `${identity.id}.state.json`));
    await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.behaviorDetach, { identity }, { tier: "write_local", checkpointStoryboardRecordStore: value.store, checkpointStoryboardBehaviorResolutionAuthority: value.authority })).resolves.toMatchObject({ ok: false, error: { code: "store_integrity_failed" } });
    await expect(readFile(behaviorJournal(value.root, identity.id, "state"), "utf8")).resolves.toBe(beforeState);
    await expect(readFile(join(value.output, "motion.json"), "utf8")).resolves.toBe(beforeMotion);
    await expect(readFile(join(value.output, "receipts", "checkpoint-storyboard-behavior-materialization.v1.json"), "utf8")).resolves.toBe(beforeReceipt);
  });

  it("refuses an absent intermediate-symlink output during prepare before B2 intent or COW", async () => {
    const value = await fixture(), identity = value.created.record.identity;
    const outside = join(value.root, "outside"), alias = join(value.workspace, "link"), output = join(alias, "output");
    await mkdir(outside); await symlink(outside, alias);
    const authority = await configureCheckpointStoryboardBehaviorResolutionAuthority({ recordStore: value.store, sourcePackageRoot: value.source, outputPackageRoot: output, packageWorkspaceRoot: value.workspace, packageWorkspaceAuthority: await createTrustedWorkspaceAnchor(value.workspace), objectLayerBinding: { objectId: "orb", layerId: "orb" } });
    const beforeState = await readFile(behaviorJournal(value.root, identity.id, "state"), "utf8");
    const result = await dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.behaviorResolve, { identity }, { tier: "write_local", checkpointStoryboardRecordStore: value.store, checkpointStoryboardBehaviorResolutionAuthority: authority });
    expect(result).toMatchObject({ ok: false, error: { code: "materialization_binding_uncertain" } });
    expect(JSON.stringify(result)).not.toContain(value.workspace); expect(JSON.stringify(result)).not.toContain(outside);
    await expect(readFile(behaviorJournal(value.root, identity.id, "state"), "utf8")).resolves.toBe(beforeState);
    await expect(lstat(behaviorJournal(value.root, identity.id, "intent"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(behaviorJournal(value.root, identity.id, "cow-start"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(outside, "output"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed for a missing B2 head and for B2 tombstone or archive targets", async () => {
    const missing = await fixture(), missingIdentity = missing.created.record.identity;
    await rm(behaviorJournal(missing.root, missingIdentity.id, "state"));
    await expect(inspectCheckpointStoryboardStoredRecordAuditView(missing.store, missingIdentity)).rejects.toMatchObject({ code: "store_integrity_failed" });
    await expect(resolveCheckpointStoryboardBehaviorStoredRecord(missing.authority, missingIdentity)).rejects.toMatchObject({ code: "store_integrity_failed" });

    const tombstoned = await fixture(), tombstoneIdentity = tombstoned.created.record.identity;
    await tombstoneCheckpointStoryboardStoredRecord(tombstoned.store, tombstoneIdentity);
    await expect(resolveCheckpointStoryboardBehaviorStoredRecord(tombstoned.authority, tombstoneIdentity)).rejects.toMatchObject({ code: "record_tombstoned" });

    const archived = await fixture(), archiveIdentity = archived.created.record.identity;
    await archiveCheckpointStoryboardStoredLineage(archived.store, archiveIdentity);
    await expect(resolveCheckpointStoryboardBehaviorStoredRecord(archived.authority, archiveIdentity)).rejects.toMatchObject({ code: "lineage_archived" });
  });

  itLinux("recovers exactly one legal intent, binding, detach, and abandonment publication lag while audit remains read-only", async () => {
    const intent = await fixture(), intentIdentity = intent.created.record.identity;
    setCheckpointStoryboardBehaviorResolutionFaultHooksForTest(intent.authority, { "after-intent-before-state-head": () => { throw new Error("intent publication interruption"); } });
    await expect(resolveCheckpointStoryboardBehaviorStoredRecord(intent.authority, intentIdentity)).rejects.toMatchObject({ code: "materialization_binding_uncertain" });
    await expect(inspectCheckpointStoryboardStoredRecordAuditView(intent.store, intentIdentity)).rejects.toMatchObject({ code: "record_commit_uncertain" });
    setCheckpointStoryboardBehaviorResolutionFaultHooksForTest(intent.authority, undefined);
    await expect(resolveCheckpointStoryboardBehaviorStoredRecord(intent.authority, intentIdentity)).resolves.toMatchObject({ binding: { state: "bound" } });

    const binding = await fixture(), bindingIdentity = binding.created.record.identity;
    setCheckpointStoryboardBehaviorResolutionFaultHooksForTest(binding.authority, { "after-binding": () => { throw new Error("binding publication interruption"); } });
    await expect(resolveCheckpointStoryboardBehaviorStoredRecord(binding.authority, bindingIdentity)).rejects.toMatchObject({ code: "materialization_binding_uncertain" });
    await expect(inspectCheckpointStoryboardStoredRecordAuditView(binding.store, bindingIdentity)).rejects.toMatchObject({ code: "record_commit_uncertain" });
    setCheckpointStoryboardBehaviorResolutionFaultHooksForTest(binding.authority, undefined);
    await expect(resolveCheckpointStoryboardBehaviorStoredRecord(binding.authority, bindingIdentity)).resolves.toMatchObject({ replayed: true, binding: { state: "bound" } });

    const detached = await fixture(), detachedIdentity = detached.created.record.identity;
    await resolveCheckpointStoryboardBehaviorStoredRecord(detached.authority, detachedIdentity);
    setCheckpointStoryboardBehaviorResolutionFaultHooksForTest(detached.authority, { "after-detach": () => { throw new Error("detach publication interruption"); } });
    await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.behaviorDetach, { identity: detachedIdentity }, { tier: "write_local", checkpointStoryboardRecordStore: detached.store, checkpointStoryboardBehaviorResolutionAuthority: detached.authority })).resolves.toMatchObject({ ok: false, error: { code: "materialization_binding_uncertain" } });
    await expect(inspectCheckpointStoryboardStoredRecordAuditView(detached.store, detachedIdentity)).rejects.toMatchObject({ code: "record_commit_uncertain" });
    setCheckpointStoryboardBehaviorResolutionFaultHooksForTest(detached.authority, undefined);
    await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.behaviorDetach, { identity: detachedIdentity }, { tier: "write_local", checkpointStoryboardRecordStore: detached.store, checkpointStoryboardBehaviorResolutionAuthority: detached.authority })).resolves.toMatchObject({ ok: true, result: { binding: { state: "detached" } } });

    const abandoned = await fixture(), abandonedIdentity = abandoned.created.record.identity;
    setCheckpointStoryboardBehaviorResolutionFaultHooksForTest(abandoned.authority, { "before-c6b2": () => { throw new Error("proved no install"); }, "after-abandon": () => { throw new Error("abandon publication interruption"); } });
    await expect(resolveCheckpointStoryboardBehaviorStoredRecord(abandoned.authority, abandonedIdentity)).rejects.toMatchObject({ code: "materialization_binding_uncertain" });
    await expect(inspectCheckpointStoryboardStoredRecordAuditView(abandoned.store, abandonedIdentity)).rejects.toMatchObject({ code: "record_commit_uncertain" });
    setCheckpointStoryboardBehaviorResolutionFaultHooksForTest(abandoned.authority, undefined);
    await expect(resolveCheckpointStoryboardBehaviorStoredRecord(abandoned.authority, abandonedIdentity)).rejects.toMatchObject({ code: "materialization_binding_conflict" });
  }, 30_000);

  itLinux("does not retry COW after a cow-start/head lag with no recognized output", async () => {
    const value = await fixture(), identity = value.created.record.identity;
    setCheckpointStoryboardBehaviorResolutionFaultHooksForTest(value.authority, { "after-cow-start-before-state-head": () => { throw new Error("cow-start publication interruption"); } });
    await expect(resolveCheckpointStoryboardBehaviorStoredRecord(value.authority, identity)).rejects.toMatchObject({ code: "materialization_binding_uncertain" });
    await expect(inspectCheckpointStoryboardStoredRecordAuditView(value.store, identity)).rejects.toMatchObject({ code: "record_commit_uncertain" });
    setCheckpointStoryboardBehaviorResolutionFaultHooksForTest(value.authority, undefined);
    await expect(resolveCheckpointStoryboardBehaviorStoredRecord(value.authority, identity)).rejects.toMatchObject({ code: "materialization_binding_uncertain" });
    await expect(lstat(value.output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("blocks archive on hidden, symlink, and residual behavior-journal entries", async () => {
    for (const kind of ["hidden", "symlink", "residual"] as const) {
      const value = await fixture(), identity = value.created.record.identity, journalRoot = join(value.root, ".shellx-motion-c6c-record-store", "behavior-resolutions");
      if (kind === "hidden") await writeFile(join(journalRoot, ".hidden"), "nope");
      else if (kind === "symlink") await symlink(behaviorJournal(value.root, identity.id, "state"), join(journalRoot, "linked"));
      else await writeFile(join(journalRoot, `${identity.id}.state.json.00000000-0000-0000-0000-000000000000.tmp`), "residue");
      await expect(archiveCheckpointStoryboardStoredLineage(value.store, identity)).rejects.toMatchObject({ code: "store_integrity_failed" });
    }
  });

  it("refuses a copied B2 behavior state in a B1 member namespace during archive audit", async () => {
    const value = await fixture(), b1 = await dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: b1Descriptor() }, { tier: "write_local", checkpointStoryboardRecordStore: value.store });
    if (!b1.ok) throw new Error("Expected B1 record.");
    const b1Identity = (b1.result as { record: { identity: typeof value.created.record.identity } }).record.identity;
    await copyFile(behaviorJournal(value.root, value.created.record.identity.id, "state"), behaviorJournal(value.root, b1Identity.id, "state"));
    await expect(archiveCheckpointStoryboardStoredLineage(value.store, b1Identity)).rejects.toMatchObject({ code: "store_integrity_failed" });
  });

  itLinux("requires a complete untampered installed output and keeps detached output intact", async () => {
    for (const tamper of ["motion", "receipt", "inventory"] as const) {
      const value = await fixture(), identity = value.created.record.identity;
      await resolveCheckpointStoryboardBehaviorStoredRecord(value.authority, identity);
      if (tamper === "motion") await writeFile(join(value.output, "motion.json"), "{}");
      if (tamper === "receipt") await writeFile(join(value.output, "receipts", "checkpoint-storyboard-behavior-materialization.v1.json"), "{}");
      if (tamper === "inventory") await writeFile(join(value.output, "unexpected.txt"), "inventory drift");
      await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.behaviorDetach, { identity }, { tier: "write_local", checkpointStoryboardRecordStore: value.store, checkpointStoryboardBehaviorResolutionAuthority: value.authority })).resolves.toMatchObject({ ok: false, error: { code: expect.stringMatching(/^materialization_binding_(?:conflict|uncertain)$/u) } });
    }
    const detached = await fixture(), identity = detached.created.record.identity;
    await resolveCheckpointStoryboardBehaviorStoredRecord(detached.authority, identity);
    const first = await dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.behaviorDetach, { identity }, { tier: "write_local", checkpointStoryboardRecordStore: detached.store, checkpointStoryboardBehaviorResolutionAuthority: detached.authority });
    const replay = await dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.behaviorDetach, { identity }, { tier: "write_local", checkpointStoryboardRecordStore: detached.store, checkpointStoryboardBehaviorResolutionAuthority: detached.authority });
    expect(first).toMatchObject({ ok: true, result: { binding: { state: "detached" } } });
    expect(replay).toMatchObject({ ok: true, result: { binding: { state: "detached" } } });
    await expect(lstat(detached.output)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  }, 30_000);
});
