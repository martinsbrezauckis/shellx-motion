import { copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { createCheckpointStoryboard, createTransitionRecipe } from "@shellx-motion/core/internal/checkpoint-storyboard-relation-profile";
import { createCheckpointStoryboard as createBehaviorStoryboard, createTransitionRecipe as createBehaviorRecipe } from "@shellx-motion/core/internal/checkpoint-storyboard-behavior-profile";
import { configureCheckpointStoryboardRelationResolutionAuthority, dispatchDebugCommand } from "../index.js";
import { resolveCheckpointStoryboardRelationStoredRecord, setCheckpointStoryboardRelationResolutionFaultHooksForTest } from "./checkpoint-storyboard-relation-resolution.js";
import { configureCheckpointStoryboardMaterializationAuthority } from "./checkpoint-storyboard-materialization-authority.js";
import { detachCheckpointStoryboardStoredRecord, materializeCheckpointStoryboardStoredRecord } from "./checkpoint-storyboard-materialization.js";
import { CHECKPOINT_STORYBOARD_RECORD_COMMANDS } from "./checkpoint-storyboard-record-lifecycle.js";
import { archiveCheckpointStoryboardStoredLineage, configureCheckpointStoryboardRecordStore, createCheckpointStoryboardStoredRecord, inspectCheckpointStoryboardStoredRecordAuditView, issueCheckpointStoryboardRecordStoreQuiescentAdmission, recoverCheckpointStoryboardRecordStoreForQuiescentHost, tombstoneCheckpointStoryboardStoredRecord } from "./checkpoint-storyboard-record-store.js";

const roots: string[] = [];
const itLinux = process.platform === "linux" ? it : it.skip;
const journal = (root: string, id: string, suffix: string) => join(root, ".shellx-motion-c6c-record-store", "relation-resolutions", `${id}.${suffix}.json`);
const b1State = (root: string, id: string) => join(root, ".shellx-motion-c6c-record-store", "bindings", `${id}.state.json`);
const b2State = (root: string, id: string) => join(root, ".shellx-motion-c6c-record-store", "behavior-resolutions", `${id}.state.json`);
afterEach(async () => await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))));

function state(objectId: "guide" | "orb", x: number, y: number) { return { objectId, state: "present" as const, properties: [{ property: "transform.x" as const, value: x }, { property: "transform.y" as const, value: y }] }; }
function relationStoryboard() {
  return createCheckpointStoryboard({
    seed: 1, capabilityRequirements: ["renderer.gpu"],
    objectCatalog: [{ objectId: "guide", rootShapeKind: "rect", propertyMask: ["transform.x", "transform.y"] }, { objectId: "orb", rootShapeKind: "ellipse", propertyMask: ["transform.x", "transform.y"] }],
    checkpoints: [{ id: "start", atUs: 0, objects: [state("guide", 100, 50), state("orb", 125, 50)] }, { id: "finish", atUs: 1_000_000, objects: [state("guide", 100, 50), state("orb", 125, 50)] }],
    edges: [{ id: "follow-edge", fromCheckpointId: "start", toCheckpointId: "finish", lifecycle: [{ kind: "preserve", objectId: "guide" }, { kind: "preserve", objectId: "orb" }], recipeIds: ["follow-guide"] }],
    recipes: [createTransitionRecipe({ recipeId: "follow-guide", seed: 2, exactBaseRequirements: [], intent: { kind: "relation", relationKind: "follow", sourceObjectId: "guide", targetObjectId: "orb", sourceAnchor: { x: 10, y: 10 }, targetAnchor: { x: 5, y: 5 }, offset: { space: "world", x: 20, y: -5, rotationDeg: 0, scale: 1 } } })],
  });
}
function b1Descriptor() { return { seed: 9, capabilityRequirements: ["renderer.native"], objectCatalog: [{ objectId: "legacy", rootShapeKind: "rect", propertyMask: ["transform.x", "transform.y", "transform.rotation", "transform.scale", "opacity"] }], checkpoints: [{ id: "start", atUs: 0, objects: [{ objectId: "legacy", state: "present", properties: [{ property: "transform.x", value: 0 }, { property: "transform.y", value: 0 }, { property: "transform.rotation", value: 0 }, { property: "transform.scale", value: 1 }, { property: "opacity", value: 1 }] }] }, { id: "end", atUs: 1_000_000, objects: [{ objectId: "legacy", state: "present", properties: [{ property: "transform.x", value: 1 }, { property: "transform.y", value: 1 }, { property: "transform.rotation", value: 0 }, { property: "transform.scale", value: 1 }, { property: "opacity", value: 1 }] }] }], edges: [{ id: "edge", fromCheckpointId: "start", toCheckpointId: "end", lifecycle: [{ kind: "preserve", objectId: "legacy" }], recipeIds: ["keyframes", "path"] }], recipes: [{ recipeId: "keyframes", seed: 10, exactBaseRequirements: [], intent: { kind: "checkpoint-keyframe", easing: "linear", targets: [{ objectId: "legacy", propertyMask: ["transform.rotation", "transform.scale", "opacity"] }] } }, { recipeId: "path", seed: 11, exactBaseRequirements: [], intent: { kind: "checkpoint-spatial-path", targets: [{ objectId: "legacy", tangentMode: "linear" }] } }] }; }
function behaviorStoryboard() { return createBehaviorStoryboard({ seed: 3, capabilityRequirements: ["renderer.gpu"], objectCatalog: [{ objectId: "orb", rootShapeKind: "ellipse", propertyMask: ["transform.x", "transform.y"] }], checkpoints: [{ id: "start", atUs: 0, objects: [{ objectId: "orb", state: "present", properties: [{ property: "transform.x", value: 0 }, { property: "transform.y", value: 0 }] }] }, { id: "end", atUs: 1_000_000, objects: [{ objectId: "orb", state: "present", properties: [{ property: "transform.x", value: 30 }, { property: "transform.y", value: 20 }] }] }], edges: [{ id: "edge", fromCheckpointId: "start", toCheckpointId: "end", lifecycle: [{ kind: "preserve", objectId: "orb" }], recipeIds: ["gravity"] }], recipes: [createBehaviorRecipe({ recipeId: "gravity", seed: 4, exactBaseRequirements: [], intent: { kind: "transform-behavior", targetObjectId: "orb", behavior: { kind: "gravity", velocityX: 1, velocityY: 2, gravityY: 3 } } })] }); }

async function fixture() {
  const root = await mkdtemp(join(process.cwd(), ".c6c-b3a-resolution-")); roots.push(root);
  const workspace = join(root, "workspace"), source = join(workspace, "source"), output = join(workspace, "output");
  await mkdir(join(source, "assets"), { recursive: true });
  await writeFile(join(source, "manifest.json"), JSON.stringify({ schema: "shellx-motion/package-manifest@1", id: "package-b3", name: "B3", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["gpu"], hosts: [] } }));
  await writeFile(join(source, "motion.json"), JSON.stringify({ schema: "shellx-motion/motion@1", id: "motion-b3", name: "B3", durationMs: 1000, fps: 30, width: 1280, height: 720, layers: [{ id: "guide", type: "shape", shape: "rect", startMs: 0, durationMs: 1000, transform: { x: 100, y: 50 } }, { id: "orb", type: "shape", shape: "ellipse", startMs: 0, durationMs: 1000, transform: { x: 125, y: 50 } }], assets: [], provenance: { sourceApp: "test", createdBy: "test" } }));
  await writeFile(join(source, "assets", "retained.txt"), "retained\n");
  const store = await configureCheckpointStoryboardRecordStore({ root, integrityKey: Buffer.alloc(32, 37) });
  const anchor = await createTrustedWorkspaceAnchor(workspace);
  const authority = await configureCheckpointStoryboardRelationResolutionAuthority({ recordStore: store, sourcePackageRoot: source, outputPackageRoot: output, packageWorkspaceRoot: workspace, packageWorkspaceAuthority: anchor, objectLayerBindings: [{ objectId: "guide", layerId: "guide" }, { objectId: "orb", layerId: "orb" }] });
  const created = await createCheckpointStoryboardStoredRecord(store, relationStoryboard());
  return { root, workspace, source, output, store, anchor, authority, created };
}
function services(value: Awaited<ReturnType<typeof fixture>>) { return { tier: "write_local" as const, checkpointStoryboardRecordStore: value.store, checkpointStoryboardRelationResolutionAuthority: value.authority }; }

describe("C6C B3a private relation resolution", () => {
  itLinux("resolves, replays, detaches, and replays identity-only without renderer work or output deletion", async () => {
    const value = await fixture(), identity = value.created.record.identity;
    expect(value.created.record.admission).toEqual({ staticProfileAdmitted: true, profile: "c6b3-relation@1" });
    await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.relationResolve, { identity, outputPackageRoot: value.output }, services(value))).resolves.toMatchObject({ ok: false, error: { code: "invalid_args" } });
    await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.relationResolve, { identity }, { tier: "write_local", checkpointStoryboardRecordStore: value.store })).resolves.toMatchObject({ ok: false, error: { code: "capability_unavailable" } });
    const first = await dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.relationResolve, { identity }, services(value));
    expect(first).toMatchObject({ ok: true, result: { renderer: { invoked: false, pixels: false }, binding: { state: "bound", active: 1 } } });
    expect(JSON.stringify(first)).not.toContain(value.workspace);
    await expect(resolveCheckpointStoryboardRelationStoredRecord(value.authority, identity)).resolves.toMatchObject({ replayed: true, binding: { state: "bound" } });
    const detached = await dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.relationDetach, { identity }, services(value));
    const replay = await dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.relationDetach, { identity }, services(value));
    expect(detached).toMatchObject({ ok: true, result: { binding: { state: "detached", active: 0 } } });
    expect(replay).toMatchObject({ ok: true, result: { replay: "same-input", binding: { state: "detached" } } });
    await expect(lstat(value.output)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
    await expect(readFile(join(value.output, "receipts", "checkpoint-storyboard-relation-materialization.v1.json"), "utf8")).resolves.toContain("checkpoint-storyboard.relation.materialize");
  }, 30_000);

  itLinux("recovers only legal intent, binding, and detach publication lags; COW-start uncertainty never repeats COW", async () => {
    const intent = await fixture(), intentIdentity = intent.created.record.identity;
    setCheckpointStoryboardRelationResolutionFaultHooksForTest(intent.authority, { "after-intent-before-state-head": () => { throw new Error("intent lag"); } });
    await expect(resolveCheckpointStoryboardRelationStoredRecord(intent.authority, intentIdentity)).rejects.toMatchObject({ code: "materialization_binding_uncertain" });
    await expect(inspectCheckpointStoryboardStoredRecordAuditView(intent.store, intentIdentity)).rejects.toMatchObject({ code: "record_commit_uncertain" });
    setCheckpointStoryboardRelationResolutionFaultHooksForTest(intent.authority, undefined);
    await expect(resolveCheckpointStoryboardRelationStoredRecord(intent.authority, intentIdentity)).resolves.toMatchObject({ binding: { state: "bound" } });

    const binding = await fixture(), bindingIdentity = binding.created.record.identity;
    setCheckpointStoryboardRelationResolutionFaultHooksForTest(binding.authority, { "after-binding": () => { throw new Error("binding lag"); } });
    await expect(resolveCheckpointStoryboardRelationStoredRecord(binding.authority, bindingIdentity)).rejects.toMatchObject({ code: "materialization_binding_uncertain" });
    setCheckpointStoryboardRelationResolutionFaultHooksForTest(binding.authority, undefined);
    await expect(resolveCheckpointStoryboardRelationStoredRecord(binding.authority, bindingIdentity)).resolves.toMatchObject({ replayed: true, binding: { state: "bound" } });
    setCheckpointStoryboardRelationResolutionFaultHooksForTest(binding.authority, { "after-detach": () => { throw new Error("detach lag"); } });
    await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.relationDetach, { identity: bindingIdentity }, services(binding))).resolves.toMatchObject({ ok: false, error: { code: "materialization_binding_uncertain" } });
    setCheckpointStoryboardRelationResolutionFaultHooksForTest(binding.authority, undefined);
    await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.relationDetach, { identity: bindingIdentity }, services(binding))).resolves.toMatchObject({ ok: true, result: { binding: { state: "detached" } } });

    const uncertain = await fixture(), uncertainIdentity = uncertain.created.record.identity;
    setCheckpointStoryboardRelationResolutionFaultHooksForTest(uncertain.authority, { "after-cow-start-before-state-head": () => { throw new Error("COW start lag"); } });
    await expect(resolveCheckpointStoryboardRelationStoredRecord(uncertain.authority, uncertainIdentity)).rejects.toMatchObject({ code: "materialization_binding_uncertain" });
    setCheckpointStoryboardRelationResolutionFaultHooksForTest(uncertain.authority, undefined);
    await expect(resolveCheckpointStoryboardRelationStoredRecord(uncertain.authority, uncertainIdentity)).rejects.toMatchObject({ code: "materialization_binding_uncertain" });
    await expect(lstat(uncertain.output)).rejects.toMatchObject({ code: "ENOENT" });
  }, 45_000);

  it("refuses intermediate output aliases before intent and retains an occupied output without replacement", async () => {
    const alias = await fixture(), identity = alias.created.record.identity, outside = join(alias.root, "outside"), linked = join(alias.workspace, "link"), output = join(linked, "output");
    await mkdir(outside); await symlink(outside, linked);
    const unsafe = await configureCheckpointStoryboardRelationResolutionAuthority({ recordStore: alias.store, sourcePackageRoot: alias.source, outputPackageRoot: output, packageWorkspaceRoot: alias.workspace, packageWorkspaceAuthority: alias.anchor, objectLayerBindings: [{ objectId: "guide", layerId: "guide" }, { objectId: "orb", layerId: "orb" }] });
    await expect(resolveCheckpointStoryboardRelationStoredRecord(unsafe, identity)).rejects.toMatchObject({ code: "materialization_binding_uncertain" });
    await expect(lstat(journal(alias.root, identity.id, "intent"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(outside, "output"))).rejects.toMatchObject({ code: "ENOENT" });

    const occupied = await fixture(), occupiedIdentity = occupied.created.record.identity;
    await mkdir(occupied.output);
    await expect(resolveCheckpointStoryboardRelationStoredRecord(occupied.authority, occupiedIdentity)).rejects.toMatchObject({ code: "materialization_binding_uncertain" });
    await expect(lstat(journal(occupied.root, occupiedIdentity.id, "intent"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  itLinux("fails detach on output, receipt, inventory, motion, and journal tampering without deleting output", async () => {
    for (const tamper of ["motion", "receipt", "inventory", "journal"] as const) {
      const value = await fixture(), identity = value.created.record.identity;
      await resolveCheckpointStoryboardRelationStoredRecord(value.authority, identity);
      if (tamper === "motion") await writeFile(join(value.output, "motion.json"), "{}");
      if (tamper === "receipt") await writeFile(join(value.output, "receipts", "checkpoint-storyboard-relation-materialization.v1.json"), "{}");
      if (tamper === "inventory") await writeFile(join(value.output, "unexpected.txt"), "drift");
      if (tamper === "journal") await writeFile(journal(value.root, identity.id, "binding"), "{}");
      await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.relationDetach, { identity }, services(value))).resolves.toMatchObject({ ok: false, error: { code: expect.stringMatching(/^(?:store_integrity_failed|materialization_binding_(?:conflict|uncertain))$/u) } });
      await expect(lstat(value.output)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
    }
  }, 45_000);

  it("keeps B1, B2, and B3 journals partitioned across resolve, lifecycle, and revision", async () => {
    const value = await fixture(), identity = value.created.record.identity;
    const b1 = await dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: b1Descriptor() }, { tier: "write_local", checkpointStoryboardRecordStore: value.store });
    if (!b1.ok) throw new Error("Expected B1 record.");
    const b1Identity = (b1.result as { record: { identity: typeof identity } }).record.identity;
    await copyFile(b1State(value.root, b1Identity.id), b1State(value.root, identity.id));
    await expect(resolveCheckpointStoryboardRelationStoredRecord(value.authority, identity)).rejects.toMatchObject({ code: "store_integrity_failed" });
    const b1Authority = await configureCheckpointStoryboardMaterializationAuthority({ recordStore: value.store, sourcePackageRoot: value.source, outputPackageRoot: join(value.workspace, "b1-output"), packageWorkspaceRoot: value.workspace, packageWorkspaceAuthority: value.anchor, objectLayerBindings: [{ objectId: "legacy", layerId: "legacy" }] });
    await copyFile(journal(value.root, identity.id, "state"), journal(value.root, b1Identity.id, "state"));
    await expect(materializeCheckpointStoryboardStoredRecord(b1Authority, b1Identity)).rejects.toMatchObject({ code: "store_integrity_failed" });
    await expect(detachCheckpointStoryboardStoredRecord(b1Authority, b1Identity)).rejects.toMatchObject({ code: "store_integrity_failed" });

    const b2 = await fixture(), b2Identity = b2.created.record.identity, behavior = await createCheckpointStoryboardStoredRecord(b2.store, behaviorStoryboard());
    await copyFile(b2State(b2.root, behavior.record.identity.id), b2State(b2.root, b2Identity.id));
    await expect(resolveCheckpointStoryboardRelationStoredRecord(b2.authority, b2Identity)).rejects.toMatchObject({ code: "store_integrity_failed" });

    const clean = await fixture(), cleanIdentity = clean.created.record.identity;
    await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.revise, { parent: cleanIdentity, descriptor: b1Descriptor() }, { tier: "write_local", checkpointStoryboardRecordStore: clean.store })).resolves.toMatchObject({ ok: false, error: { code: "record_identity_conflict" } });
    await tombstoneCheckpointStoryboardStoredRecord(clean.store, cleanIdentity);
    await expect(resolveCheckpointStoryboardRelationStoredRecord(clean.authority, cleanIdentity)).rejects.toMatchObject({ code: "record_tombstoned" });
    const archived = await fixture(), archivedIdentity = archived.created.record.identity;
    await archiveCheckpointStoryboardStoredLineage(archived.store, archivedIdentity);
    await expect(resolveCheckpointStoryboardRelationStoredRecord(archived.authority, archivedIdentity)).rejects.toMatchObject({ code: "lineage_archived" });
  }, 30_000);

  itLinux("scans the full relation namespace and blocks remove while a B3 link is bound or preparing", async () => {
    const bound = await fixture(), boundIdentity = bound.created.record.identity;
    await resolveCheckpointStoryboardRelationStoredRecord(bound.authority, boundIdentity);
    await expect(tombstoneCheckpointStoryboardStoredRecord(bound.store, boundIdentity)).rejects.toMatchObject({ code: "materialization_binding_conflict" });
    await dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.relationDetach, { identity: boundIdentity }, services(bound));
    await expect(tombstoneCheckpointStoryboardStoredRecord(bound.store, boundIdentity)).resolves.toMatchObject({ record: { target: { state: "tombstoned" } } });

    const preparing = await fixture(), preparingIdentity = preparing.created.record.identity;
    setCheckpointStoryboardRelationResolutionFaultHooksForTest(preparing.authority, { "after-intent": () => { throw new Error("preparing"); } });
    await expect(resolveCheckpointStoryboardRelationStoredRecord(preparing.authority, preparingIdentity)).rejects.toMatchObject({ code: "materialization_binding_uncertain" });
    setCheckpointStoryboardRelationResolutionFaultHooksForTest(preparing.authority, undefined);
    await expect(tombstoneCheckpointStoryboardStoredRecord(preparing.store, preparingIdentity)).rejects.toMatchObject({ code: "materialization_binding_conflict" });
    await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.relationDetach, { identity: preparingIdentity }, services(preparing))).resolves.toMatchObject({ ok: false, error: { code: "materialization_not_bound" } });
    await expect(tombstoneCheckpointStoryboardStoredRecord(preparing.store, preparingIdentity)).resolves.toMatchObject({ record: { target: { state: "tombstoned" } } });

    for (const kind of ["hidden", "symlink", "residual"] as const) {
      const value = await fixture(), identity = value.created.record.identity, directory = join(value.root, ".shellx-motion-c6c-record-store", "relation-resolutions");
      if (kind === "hidden") await writeFile(join(directory, ".hidden"), "nope");
      else if (kind === "symlink") await symlink(journal(value.root, identity.id, "state"), join(directory, "linked"));
      else await writeFile(join(directory, `${identity.id}.state.json.00000000-0000-0000-0000-000000000000.tmp`), "residue");
      await expect(archiveCheckpointStoryboardStoredLineage(value.store, identity)).rejects.toMatchObject({ code: "store_integrity_failed" });
    }

    const copied = await fixture(), copiedIdentity = copied.created.record.identity;
    const b1 = await dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: b1Descriptor() }, { tier: "write_local", checkpointStoryboardRecordStore: copied.store });
    if (!b1.ok) throw new Error("Expected B1 record.");
    const b1Identity = (b1.result as { record: { identity: typeof copiedIdentity } }).record.identity;
    const b2 = await createCheckpointStoryboardStoredRecord(copied.store, behaviorStoryboard());
    await copyFile(journal(copied.root, copiedIdentity.id, "state"), journal(copied.root, b1Identity.id, "state"));
    await expect(archiveCheckpointStoryboardStoredLineage(copied.store, b1Identity)).rejects.toMatchObject({ code: "store_integrity_failed" });
    await rm(journal(copied.root, b1Identity.id, "state"));
    await copyFile(journal(copied.root, copiedIdentity.id, "state"), journal(copied.root, b2.record.identity.id, "state"));
    await expect(archiveCheckpointStoryboardStoredLineage(copied.store, b2.record.identity)).rejects.toMatchObject({ code: "store_integrity_failed" });
  }, 45_000);

  it("refuses a replaced B3 journal child and quiescently cleans only a recognized relation stage", async () => {
    const replaced = await fixture(), replacedIdentity = replaced.created.record.identity;
    const relationRoot = join(replaced.root, ".shellx-motion-c6c-record-store", "relation-resolutions"), held = `${relationRoot}.held`;
    await rename(relationRoot, held);
    await mkdir(relationRoot, { mode: 0o700 });
    await expect(resolveCheckpointStoryboardRelationStoredRecord(replaced.authority, replacedIdentity)).rejects.toMatchObject({ code: "materialization_authority_refused" });

    const recoverable = await fixture(), recoverableIdentity = recoverable.created.record.identity;
    const uuid = `${"a".repeat(8)}-${"b".repeat(4)}-${"c".repeat(4)}-${"d".repeat(4)}-${"e".repeat(12)}`;
    const stage = join(recoverable.root, ".shellx-motion-c6c-record-store", "relation-resolutions", `${recoverableIdentity.id}.state.json.${uuid}.tmp`);
    await writeFile(stage, "recoverable private relation stage", { mode: 0o600 });
    await expect(recoverCheckpointStoryboardRecordStoreForQuiescentHost(recoverable.store, issueCheckpointStoryboardRecordStoreQuiescentAdmission(recoverable.store))).resolves.toEqual({ removedTemporaryFiles: 1, removedStaleLocks: 0 });
    await expect(lstat(stage)).rejects.toMatchObject({ code: "ENOENT" });
  });

  itLinux("serializes concurrent resolves to one COW and keeps raw materialization outside command surfaces", async () => {
    const value = await fixture(), identity = value.created.record.identity;
    let enteredLock!: () => void, releaseLock!: () => void, cows = 0;
    const lockHeld = new Promise<void>((resolve) => { enteredLock = resolve; });
    const release = new Promise<void>((resolve) => { releaseLock = resolve; });
    setCheckpointStoryboardRelationResolutionFaultHooksForTest(value.authority, {
      "while-lineage-lock-held": async () => { enteredLock(); await release; },
      "before-c6b3b": () => { cows += 1; },
    });
    const first = resolveCheckpointStoryboardRelationStoredRecord(value.authority, identity);
    await lockHeld;
    await expect(resolveCheckpointStoryboardRelationStoredRecord(value.authority, identity)).rejects.toMatchObject({ code: "store_busy" });
    releaseLock();
    await expect(first).resolves.toMatchObject({ replayed: false, binding: { state: "bound" } });
    setCheckpointStoryboardRelationResolutionFaultHooksForTest(value.authority, undefined);
    await expect(resolveCheckpointStoryboardRelationStoredRecord(value.authority, identity)).resolves.toMatchObject({ replayed: true, binding: { state: "bound" } });
    expect(cows).toBe(1);
    const files = ["../index.ts", "../command-registry.ts", "../command-metadata.ts", "../../../core/src/index.ts", "../../../cli/src/main.ts", "../../../sdk/src/index.ts", "../../../actions/src/catalog.ts", "../../../connectors/src/index.ts", "../../../renderer-browser/src/index.ts", "../../../renderer-native/src/index.ts"];
    const contents = await Promise.all(files.map(async (file) => await readFile(new URL(file, import.meta.url), "utf8")));
    expect(contents.every((text) => !text.includes("checkpoint-storyboard.relation.materialize"))).toBe(true);
    expect(contents.slice(3).every((text) => !text.includes("checkpoint-storyboard-relation-materializer"))).toBe(true);
  }, 30_000);
});
