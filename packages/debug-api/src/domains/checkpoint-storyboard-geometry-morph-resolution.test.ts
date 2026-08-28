import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCheckpointStoryboard, createTransitionRecipe } from "@shellx-motion/core/internal/checkpoint-storyboard-lifecycle-profile";
import { createTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { dispatchDebugCommand } from "../index.js";
import { configureCheckpointStoryboardGeometryMorphResolutionAuthority } from "./checkpoint-storyboard-geometry-morph-resolution-authority.js";
import { CHECKPOINT_STORYBOARD_RECORD_COMMANDS } from "./checkpoint-storyboard-record-lifecycle.js";
import { archiveCheckpointStoryboardStoredLineage, configureCheckpointStoryboardRecordStore, createCheckpointStoryboardStoredRecord, tombstoneCheckpointStoryboardStoredRecord } from "./checkpoint-storyboard-record-store.js";
import { detachCheckpointStoryboardGeometryMorphStoredRecord, resolveCheckpointStoryboardGeometryMorphStoredRecord, setCheckpointStoryboardGeometryMorphResolutionFaultHooksForTest } from "./checkpoint-storyboard-geometry-morph-resolution.js";
import { C6B6B_RECEIPT_PATH } from "./checkpoint-storyboard-geometry-morph-materialize-private/checkpoint-storyboard-geometry-morph-materialize-receipt-private.js";

const roots: string[] = [];
const itLinux = process.platform === "linux" ? it : it.skip;
const geometryJournal = (root: string, id: string, suffix = "state") => join(root, ".shellx-motion-c6c-record-store", "geometry-morph-resolutions", `${id}.${suffix}.json`);
const VIEW_BOX = { x: -100, y: -100, width: 400, height: 400 };
const START = polygon([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }]);
const END = polygon([{ x: 20, y: 20 }, { x: 120, y: 20 }, { x: 20, y: 120 }]);

afterEach(async () => await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))));

function polygon(points: readonly { readonly x: number; readonly y: number }[]) {
  return { schema: "shellx-motion/shape-geometry@1" as const, kind: "polygon" as const, viewBox: { ...VIEW_BOX }, points: points.map((point) => ({ ...point })) };
}

function geometryStoryboard() {
  const recipe = createTransitionRecipe({ recipeId: "triangle-morph", seed: 2, exactBaseRequirements: [], intent: { kind: "checkpoint-geometry-morph", targets: [{ objectId: "triangle", easing: "linear" }] } });
  return createCheckpointStoryboard({
    seed: 1, capabilityRequirements: ["renderer.gpu"], objectCatalog: [{ objectId: "triangle", rootShapeKind: "geometry", propertyMask: [] }], recipes: [recipe],
    checkpoints: [
      { id: "start", atUs: 0, objects: [{ objectId: "triangle", state: "present", properties: [], geometry: START }] },
      { id: "finish", atUs: 1_000_000, objects: [{ objectId: "triangle", state: "present", properties: [], geometry: END }] },
    ],
    edges: [{ id: "start-finish", fromCheckpointId: "start", toCheckpointId: "finish", lifecycle: [{ kind: "preserve", objectId: "triangle" }], recipeIds: ["triangle-morph"] }],
  });
}

function geometryMorphDescriptor(seed = 1) {
  return {
    seed, capabilityRequirements: ["renderer.gpu"], objectCatalog: [{ objectId: "triangle", rootShapeKind: "geometry", propertyMask: [] }],
    checkpoints: [
      { id: "start", atUs: 0, objects: [{ objectId: "triangle", state: "present", properties: [], geometry: START }] },
      { id: "finish", atUs: 1_000_000, objects: [{ objectId: "triangle", state: "present", properties: [], geometry: END }] },
    ],
    edges: [{ id: "start-finish", fromCheckpointId: "start", toCheckpointId: "finish", lifecycle: [{ kind: "preserve", objectId: "triangle" }], recipeIds: ["triangle-morph"] }],
    recipes: [{ recipeId: "triangle-morph", seed: 2, exactBaseRequirements: [], intent: { kind: "checkpoint-geometry-morph", targets: [{ objectId: "triangle", easing: "linear" }] } }],
  };
}

function b1Descriptor() {
  return {
    seed: 9, capabilityRequirements: ["renderer.native"], objectCatalog: [{ objectId: "legacy", rootShapeKind: "rect", propertyMask: ["transform.x", "transform.y", "transform.rotation", "transform.scale", "opacity"] }],
    checkpoints: [{ id: "start", atUs: 0, objects: [{ objectId: "legacy", state: "present", properties: [{ property: "transform.x", value: 0 }, { property: "transform.y", value: 0 }, { property: "transform.rotation", value: 0 }, { property: "transform.scale", value: 1 }, { property: "opacity", value: 1 }] }] }, { id: "end", atUs: 1_000_000, objects: [{ objectId: "legacy", state: "present", properties: [{ property: "transform.x", value: 1 }, { property: "transform.y", value: 1 }, { property: "transform.rotation", value: 0 }, { property: "transform.scale", value: 1 }, { property: "opacity", value: 1 }] }] }],
    edges: [{ id: "edge", fromCheckpointId: "start", toCheckpointId: "end", lifecycle: [{ kind: "preserve", objectId: "legacy" }], recipeIds: ["keyframes", "path"] }],
    recipes: [{ recipeId: "keyframes", seed: 10, exactBaseRequirements: [], intent: { kind: "checkpoint-keyframe", easing: "linear", targets: [{ objectId: "legacy", propertyMask: ["transform.rotation", "transform.scale", "opacity"] }] } }, { recipeId: "path", seed: 11, exactBaseRequirements: [], intent: { kind: "checkpoint-spatial-path", targets: [{ objectId: "legacy", tangentMode: "linear" }] } }],
  };
}

async function fixture() {
  const root = await mkdtemp(join(process.cwd(), ".c6c-b6-resolution-")); roots.push(root);
  const workspace = join(root, "workspace"), source = join(workspace, "source"), output = join(workspace, "output");
  await mkdir(join(source, "assets", "nested"), { recursive: true }); await mkdir(join(source, "assets", "empty"), { recursive: true }); await mkdir(join(source, "receipts"), { recursive: true });
  await writeJson(join(source, "manifest.json"), { schema: "shellx-motion/package-manifest@1", id: "package-b6", name: "B6", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["gpu"], hosts: [] } });
  await writeJson(join(source, "motion.json"), { schema: "shellx-motion/motion@1", id: "motion-b6", name: "B6 triangle", durationMs: 1_000, fps: 30, width: 1280, height: 720, layers: [{ id: "triangle", type: "shape", fill: "#4e8cff", startMs: 0, durationMs: 1_000, geometry: START }], assets: [], provenance: { sourceApp: "test", createdBy: "test" } });
  await writeFile(join(source, "assets", "nested", "retained.txt"), "retained\n", "utf8");
  const store = await configureCheckpointStoryboardRecordStore({ root, integrityKey: Buffer.alloc(32, 61) }), anchor = await createTrustedWorkspaceAnchor(workspace);
  const authority = await configureCheckpointStoryboardGeometryMorphResolutionAuthority({ recordStore: store, sourcePackageRoot: source, outputPackageRoot: output, packageWorkspaceRoot: workspace, packageWorkspaceAuthority: anchor });
  const created = await createCheckpointStoryboardStoredRecord(store, geometryStoryboard());
  return { root, workspace, source, output, store, anchor, authority, created };
}

function services(value: Awaited<ReturnType<typeof fixture>>) { return { tier: "write_local" as const, checkpointStoryboardRecordStore: value.store, checkpointStoryboardGeometryMorphResolutionAuthority: value.authority }; }

describe("C6C B6 private geometry-morph resolution", () => {
  itLinux("resolves one exact two-keyframe output through the identity-only command, replays once, survives source loss, and detaches without deletion", async () => {
    const value = await fixture(), identity = value.created.record.identity; let cows = 0;
    expect(value.created.record.admission).toEqual({ staticProfileAdmitted: true, profile: "c6b6-geometry-morph@1" });
    setCheckpointStoryboardGeometryMorphResolutionFaultHooksForTest(value.authority, { "before-c6b6b": () => { cows += 1; } });
    await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.geometryMorphResolve, { identity, outputPackageRoot: value.output }, services(value))).resolves.toMatchObject({ ok: false, error: { code: "invalid_args" } });
    await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.geometryMorphResolve, { identity }, { tier: "write_local", checkpointStoryboardRecordStore: value.store })).resolves.toMatchObject({ ok: false, error: { code: "capability_unavailable" } });
    const first = await dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.geometryMorphResolve, { identity }, services(value));
    expect(first).toMatchObject({ ok: true, result: { binding: { state: "bound", active: 1 }, renderer: { invoked: false, pixels: false } } }); expect(JSON.stringify(first)).not.toContain(value.workspace);
    const output = JSON.parse(await readFile(join(value.output, "motion.json"), "utf8")) as {
      layers: Array<{
        geometry: unknown;
        geometryKeyframes?: { readonly schema?: string; readonly keyframes: Array<{ readonly atUs: number; readonly easing?: string; readonly geometry: unknown }> };
      }>;
    };
    expect(output.layers[0]?.geometry).toEqual(START); expect(output.layers[0]?.geometryKeyframes).toEqual({ schema: "shellx-motion/shape-geometry-keyframes@1", keyframes: [{ atUs: 0, geometry: START, easing: "linear" }, { atUs: 1_000_000, geometry: END }] });
    expect(cows).toBe(1);
    await expect(resolveCheckpointStoryboardGeometryMorphStoredRecord(value.authority, identity)).resolves.toMatchObject({ replayed: true, binding: { state: "bound" } }); expect(cows).toBe(1);
    const beforeDetach = await readFile(join(value.output, "motion.json"), "utf8"); await rm(value.source, { recursive: true, force: true });
    await expect(resolveCheckpointStoryboardGeometryMorphStoredRecord(value.authority, identity)).resolves.toMatchObject({ replayed: true, binding: { state: "bound" } });
    await expect(detachCheckpointStoryboardGeometryMorphStoredRecord(value.authority, identity)).resolves.toMatchObject({ binding: { state: "detached", active: 0 } });
    await expect(detachCheckpointStoryboardGeometryMorphStoredRecord(value.authority, identity)).resolves.toMatchObject({ replayed: true, binding: { state: "detached" } });
    await expect(resolveCheckpointStoryboardGeometryMorphStoredRecord(value.authority, identity)).rejects.toMatchObject({ code: "materialization_detached" });
    expect(await readFile(join(value.output, "motion.json"), "utf8")).toBe(beforeDetach); await expect(lstat(value.output)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  }, 45_000);

  it("fails before COW for wrong profile/authority, occupied output, extra command data, and a source own geometryKeyframes authority", async () => {
    const value = await fixture(), identity = value.created.record.identity; let cows = 0;
    setCheckpointStoryboardGeometryMorphResolutionFaultHooksForTest(value.authority, { "before-c6b6b": () => { cows += 1; } });
    const legacy = await dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: b1Descriptor() }, { tier: "write_local", checkpointStoryboardRecordStore: value.store });
    if (!legacy.ok) throw new Error("Expected a B1 record for profile-refusal coverage.");
    const legacyIdentity = (legacy.result as { readonly record: { readonly identity: typeof identity } }).record.identity;
    await expect(resolveCheckpointStoryboardGeometryMorphStoredRecord(value.authority, legacyIdentity)).rejects.toMatchObject({ code: "materialization_profile_refused" });
    await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.geometryMorphResolve, { identity, sourcePackageRoot: value.source }, services(value))).resolves.toMatchObject({ ok: false, error: { code: "invalid_args" } });
    const foreignAuthority = await fixture();
    await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.geometryMorphResolve, { identity }, { tier: "write_local", checkpointStoryboardRecordStore: value.store, checkpointStoryboardGeometryMorphResolutionAuthority: foreignAuthority.authority })).resolves.toMatchObject({ ok: false, error: { code: "materialization_authority_refused" } });
    expect(cows).toBe(0);

    const occupied = await fixture(); await mkdir(occupied.output); let occupiedCows = 0;
    setCheckpointStoryboardGeometryMorphResolutionFaultHooksForTest(occupied.authority, { "before-c6b6b": () => { occupiedCows += 1; } });
    await expect(resolveCheckpointStoryboardGeometryMorphStoredRecord(occupied.authority, occupied.created.record.identity)).rejects.toMatchObject({ code: "materialization_binding_uncertain" }); expect(occupiedCows).toBe(0); await expect(lstat(geometryJournal(occupied.root, occupied.created.record.identity.id, "intent"))).rejects.toMatchObject({ code: "ENOENT" });

    const sourceOwned = await fixture(); const source = JSON.parse(await readFile(join(sourceOwned.source, "motion.json"), "utf8")); source.layers[0].geometryKeyframes = null; await writeJson(join(sourceOwned.source, "motion.json"), source); let sourceCows = 0;
    setCheckpointStoryboardGeometryMorphResolutionFaultHooksForTest(sourceOwned.authority, { "before-c6b6b": () => { sourceCows += 1; } });
    await expect(resolveCheckpointStoryboardGeometryMorphStoredRecord(sourceOwned.authority, sourceOwned.created.record.identity)).rejects.toMatchObject({ code: "materialization_binding_uncertain" }); expect(sourceCows).toBe(0); await expect(lstat(sourceOwned.output)).rejects.toMatchObject({ code: "ENOENT" });
  }, 45_000);

  itLinux("rejects geometry, receipt, inventory, and empty-directory output tampering while retaining the output", async () => {
    const staticGeometry = await fixture(), receipt = await fixture(), inventory = await fixture(), emptyDirectory = await fixture();
    try {
      await Promise.all([resolveCheckpointStoryboardGeometryMorphStoredRecord(staticGeometry.authority, staticGeometry.created.record.identity), resolveCheckpointStoryboardGeometryMorphStoredRecord(receipt.authority, receipt.created.record.identity), resolveCheckpointStoryboardGeometryMorphStoredRecord(inventory.authority, inventory.created.record.identity), resolveCheckpointStoryboardGeometryMorphStoredRecord(emptyDirectory.authority, emptyDirectory.created.record.identity)]);
      const document = JSON.parse(await readFile(join(staticGeometry.output, "motion.json"), "utf8")); document.layers[0].geometry.points[0].x = 1; await writeJson(join(staticGeometry.output, "motion.json"), document);
      await writeFile(join(receipt.output, C6B6B_RECEIPT_PATH), "{}\n", "utf8");
      await writeFile(join(inventory.output, "unexpected.txt"), "drift\n", "utf8");
      await mkdir(join(emptyDirectory.output, "assets", "late-empty"));
      for (const value of [staticGeometry, receipt, inventory, emptyDirectory]) {
        await expect(detachCheckpointStoryboardGeometryMorphStoredRecord(value.authority, value.created.record.identity)).rejects.toMatchObject({ code: expect.stringMatching(/^(?:store_integrity_failed|materialization_binding_(?:conflict|uncertain))$/u) });
        await expect(lstat(value.output)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
      }
    } finally {
      setCheckpointStoryboardGeometryMorphResolutionFaultHooksForTest(staticGeometry.authority, undefined); setCheckpointStoryboardGeometryMorphResolutionFaultHooksForTest(receipt.authority, undefined); setCheckpointStoryboardGeometryMorphResolutionFaultHooksForTest(inventory.authority, undefined); setCheckpointStoryboardGeometryMorphResolutionFaultHooksForTest(emptyDirectory.authority, undefined);
    }
  }, 45_000);

  itLinux("does not repeat COW after durable start uncertainty and recovers a post-install ambiguity from the exact output", async () => {
    const started = await fixture(), startedIdentity = started.created.record.identity; let startedCows = 0;
    setCheckpointStoryboardGeometryMorphResolutionFaultHooksForTest(started.authority, { "after-cow-start": () => { throw new Error("durable COW start"); }, "before-c6b6b": () => { startedCows += 1; } });
    await expect(resolveCheckpointStoryboardGeometryMorphStoredRecord(started.authority, startedIdentity)).rejects.toMatchObject({ code: "materialization_binding_uncertain" });
    setCheckpointStoryboardGeometryMorphResolutionFaultHooksForTest(started.authority, { "before-c6b6b": () => { startedCows += 1; } });
    await expect(resolveCheckpointStoryboardGeometryMorphStoredRecord(started.authority, startedIdentity)).rejects.toMatchObject({ code: "materialization_binding_uncertain" }); expect(startedCows).toBe(0); await expect(lstat(started.output)).rejects.toMatchObject({ code: "ENOENT" });

    const committed = await fixture(), committedIdentity = committed.created.record.identity; let committedCows = 0;
    setCheckpointStoryboardGeometryMorphResolutionFaultHooksForTest(committed.authority, { "before-c6b6b": () => { committedCows += 1; }, "after-c6b6b-commit": () => { throw new Error("post-install ambiguity"); } });
    await expect(resolveCheckpointStoryboardGeometryMorphStoredRecord(committed.authority, committedIdentity)).rejects.toMatchObject({ code: "materialization_binding_uncertain" }); await expect(lstat(committed.output)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
    setCheckpointStoryboardGeometryMorphResolutionFaultHooksForTest(committed.authority, { "before-c6b6b": () => { committedCows += 1; } });
    await expect(resolveCheckpointStoryboardGeometryMorphStoredRecord(committed.authority, committedIdentity)).resolves.toMatchObject({ replayed: true, binding: { state: "bound" } }); expect(committedCows).toBe(1);
  }, 45_000);

  itLinux("forward-recovers each legal publication lag, terminally abandons a proved pre-install failure, and abandons a pre-COW detach before tombstone", async () => {
    const intent = await fixture(), intentIdentity = intent.created.record.identity;
    setCheckpointStoryboardGeometryMorphResolutionFaultHooksForTest(intent.authority, { "after-intent-before-state-head": () => { throw new Error("intent lag"); } });
    await expect(resolveCheckpointStoryboardGeometryMorphStoredRecord(intent.authority, intentIdentity)).rejects.toMatchObject({ code: "materialization_binding_uncertain" });
    setCheckpointStoryboardGeometryMorphResolutionFaultHooksForTest(intent.authority, undefined);
    await expect(resolveCheckpointStoryboardGeometryMorphStoredRecord(intent.authority, intentIdentity)).resolves.toMatchObject({ binding: { state: "bound" } });

    const binding = await fixture(), bindingIdentity = binding.created.record.identity;
    setCheckpointStoryboardGeometryMorphResolutionFaultHooksForTest(binding.authority, { "after-binding": () => { throw new Error("binding lag"); } });
    await expect(resolveCheckpointStoryboardGeometryMorphStoredRecord(binding.authority, bindingIdentity)).rejects.toMatchObject({ code: "materialization_binding_uncertain" });
    setCheckpointStoryboardGeometryMorphResolutionFaultHooksForTest(binding.authority, undefined);
    await expect(resolveCheckpointStoryboardGeometryMorphStoredRecord(binding.authority, bindingIdentity)).resolves.toMatchObject({ replayed: true, binding: { state: "bound" } });
    setCheckpointStoryboardGeometryMorphResolutionFaultHooksForTest(binding.authority, { "after-detach": () => { throw new Error("detach lag"); } });
    await expect(detachCheckpointStoryboardGeometryMorphStoredRecord(binding.authority, bindingIdentity)).rejects.toMatchObject({ code: "materialization_binding_uncertain" });
    setCheckpointStoryboardGeometryMorphResolutionFaultHooksForTest(binding.authority, undefined);
    await expect(detachCheckpointStoryboardGeometryMorphStoredRecord(binding.authority, bindingIdentity)).resolves.toMatchObject({ replayed: true, binding: { state: "detached" } });

    const head = await fixture(), headIdentity = head.created.record.identity;
    setCheckpointStoryboardGeometryMorphResolutionFaultHooksForTest(head.authority, { "after-bound-state-head-rename": () => { throw new Error("bound head lag"); } });
    await expect(resolveCheckpointStoryboardGeometryMorphStoredRecord(head.authority, headIdentity)).rejects.toMatchObject({ code: "record_commit_uncertain" });
    setCheckpointStoryboardGeometryMorphResolutionFaultHooksForTest(head.authority, undefined);
    await expect(resolveCheckpointStoryboardGeometryMorphStoredRecord(head.authority, headIdentity)).resolves.toMatchObject({ replayed: true, binding: { state: "bound" } });
    setCheckpointStoryboardGeometryMorphResolutionFaultHooksForTest(head.authority, { "after-detached-state-head-rename": () => { throw new Error("detached head lag"); } });
    await expect(detachCheckpointStoryboardGeometryMorphStoredRecord(head.authority, headIdentity)).rejects.toMatchObject({ code: "record_commit_uncertain" });
    setCheckpointStoryboardGeometryMorphResolutionFaultHooksForTest(head.authority, undefined);
    await expect(detachCheckpointStoryboardGeometryMorphStoredRecord(head.authority, headIdentity)).resolves.toMatchObject({ replayed: true, binding: { state: "detached" } });

    const abandoned = await fixture(), abandonedIdentity = abandoned.created.record.identity; let attempts = 0;
    setCheckpointStoryboardGeometryMorphResolutionFaultHooksForTest(abandoned.authority, { "before-c6b6b": () => { attempts += 1; throw new Error("proved pre-install failure"); }, "after-abandon": () => { throw new Error("abandon head lag"); } });
    await expect(resolveCheckpointStoryboardGeometryMorphStoredRecord(abandoned.authority, abandonedIdentity)).rejects.toMatchObject({ code: "materialization_binding_uncertain" });
    await expect(lstat(abandoned.output)).rejects.toMatchObject({ code: "ENOENT" });
    setCheckpointStoryboardGeometryMorphResolutionFaultHooksForTest(abandoned.authority, undefined);
    await expect(resolveCheckpointStoryboardGeometryMorphStoredRecord(abandoned.authority, abandonedIdentity)).rejects.toMatchObject({ code: "materialization_binding_conflict" });
    expect(attempts).toBe(1); await expect(lstat(abandoned.output)).rejects.toMatchObject({ code: "ENOENT" });

    const preCowDetach = await fixture(), preCowDetachIdentity = preCowDetach.created.record.identity;
    setCheckpointStoryboardGeometryMorphResolutionFaultHooksForTest(preCowDetach.authority, { "after-intent": () => { throw new Error("pre-COW intent"); } });
    await expect(resolveCheckpointStoryboardGeometryMorphStoredRecord(preCowDetach.authority, preCowDetachIdentity)).rejects.toMatchObject({ code: "materialization_binding_uncertain" });
    setCheckpointStoryboardGeometryMorphResolutionFaultHooksForTest(preCowDetach.authority, undefined);
    await expect(detachCheckpointStoryboardGeometryMorphStoredRecord(preCowDetach.authority, preCowDetachIdentity)).rejects.toMatchObject({ code: "materialization_not_bound" });
    await expect(tombstoneCheckpointStoryboardStoredRecord(preCowDetach.store, preCowDetachIdentity)).resolves.toMatchObject({ record: { target: { state: "tombstoned" } } });
  }, 45_000);

  itLinux("rejects B1-B5/B7 residue and blocks remove/archive while B6 is preparing or bound", async () => {
    const residue = await fixture(), residueIdentity = residue.created.record.identity; let cows = 0;
    setCheckpointStoryboardGeometryMorphResolutionFaultHooksForTest(residue.authority, { "before-c6b6b": () => { cows += 1; } });
    for (const directory of ["bindings", "behavior-resolutions", "relation-resolutions", "relation-action-resolutions", "lifecycle-resolutions", "retained-trace-resolutions"]) {
      const state = join(residue.root, ".shellx-motion-c6c-record-store", directory, `${residueIdentity.id}.state.json`); await writeFile(state, "{}\n", "utf8");
      await expect(resolveCheckpointStoryboardGeometryMorphStoredRecord(residue.authority, residueIdentity)).rejects.toMatchObject({ code: "store_integrity_failed" }); await rm(state);
    }
    expect(cows).toBe(0);

    const bound = await fixture(), boundIdentity = bound.created.record.identity; await resolveCheckpointStoryboardGeometryMorphStoredRecord(bound.authority, boundIdentity);
    await expect(tombstoneCheckpointStoryboardStoredRecord(bound.store, boundIdentity)).rejects.toMatchObject({ code: "materialization_binding_conflict" }); await expect(archiveCheckpointStoryboardStoredLineage(bound.store, boundIdentity)).rejects.toMatchObject({ code: "materialization_binding_conflict" });
    await detachCheckpointStoryboardGeometryMorphStoredRecord(bound.authority, boundIdentity); await expect(tombstoneCheckpointStoryboardStoredRecord(bound.store, boundIdentity)).resolves.toMatchObject({ record: { target: { state: "tombstoned" } } });

    const preparing = await fixture(), preparingIdentity = preparing.created.record.identity;
    setCheckpointStoryboardGeometryMorphResolutionFaultHooksForTest(preparing.authority, { "after-intent": () => { throw new Error("preparing"); } });
    await expect(resolveCheckpointStoryboardGeometryMorphStoredRecord(preparing.authority, preparingIdentity)).rejects.toMatchObject({ code: "materialization_binding_uncertain" });
    await expect(tombstoneCheckpointStoryboardStoredRecord(preparing.store, preparingIdentity)).rejects.toMatchObject({ code: "materialization_binding_conflict" }); await expect(archiveCheckpointStoryboardStoredLineage(preparing.store, preparingIdentity)).rejects.toMatchObject({ code: "materialization_binding_conflict" });
  }, 45_000);

  itLinux("blocks archive through a different B6 revision while either lineage member is bound", async () => {
    const value = await fixture(), rootIdentity = value.created.record.identity;
    const revised = await dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.revise, { parent: rootIdentity, descriptor: geometryMorphDescriptor(2) }, { tier: "write_local", checkpointStoryboardRecordStore: value.store });
    if (!revised.ok) throw new Error("Expected a second sealed B6 revision for archive coverage.");
    const revisionIdentity = (revised.result as { readonly record: { readonly identity: typeof rootIdentity } }).record.identity;
    await expect(resolveCheckpointStoryboardGeometryMorphStoredRecord(value.authority, rootIdentity)).resolves.toMatchObject({ binding: { state: "bound" } });
    await expect(archiveCheckpointStoryboardStoredLineage(value.store, revisionIdentity)).rejects.toMatchObject({ code: "materialization_binding_conflict" });
    await expect(detachCheckpointStoryboardGeometryMorphStoredRecord(value.authority, rootIdentity)).resolves.toMatchObject({ binding: { state: "detached" } });
    await expect(archiveCheckpointStoryboardStoredLineage(value.store, revisionIdentity)).resolves.toMatchObject({ record: { archive: { terminal: true } } });
  }, 45_000);

  itLinux("serializes duplicate resolution to one COW", async () => {
    const value = await fixture(), identity = value.created.record.identity; let entered!: () => void, release!: () => void, cows = 0;
    const heldLock = new Promise<void>((resolve) => { entered = resolve; }), releaseLock = new Promise<void>((resolve) => { release = resolve; });
    setCheckpointStoryboardGeometryMorphResolutionFaultHooksForTest(value.authority, { "while-lineage-lock-held": async () => { entered(); await releaseLock; }, "before-c6b6b": () => { cows += 1; } });
    const first = resolveCheckpointStoryboardGeometryMorphStoredRecord(value.authority, identity); await heldLock;
    await expect(resolveCheckpointStoryboardGeometryMorphStoredRecord(value.authority, identity)).rejects.toMatchObject({ code: "store_busy" }); release();
    await expect(first).resolves.toMatchObject({ replayed: false, binding: { state: "bound" } }); setCheckpointStoryboardGeometryMorphResolutionFaultHooksForTest(value.authority, undefined);
    await expect(resolveCheckpointStoryboardGeometryMorphStoredRecord(value.authority, identity)).resolves.toMatchObject({ replayed: true, binding: { state: "bound" } }); expect(cows).toBe(1);
  }, 45_000);
});

async function writeJson(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8"); }
