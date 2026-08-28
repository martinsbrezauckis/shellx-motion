import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { dispatchDebugCommand } from "../index.js";
import { configureCheckpointStoryboardLifecycleResolutionAuthority } from "./checkpoint-storyboard-lifecycle-resolution-authority.js";
import { initializeGeometryMorphStateHead } from "./checkpoint-storyboard-geometry-morph-resolution-journal.js";
import { CHECKPOINT_STORYBOARD_RECORD_COMMANDS } from "./checkpoint-storyboard-record-lifecycle.js";
import { checkedAuthority } from "./checkpoint-storyboard-record-store-authority.js";
import { configureCheckpointStoryboardRecordStore } from "./checkpoint-storyboard-record-store.js";
import { detachCheckpointStoryboardLifecycleStoredRecord, resolveCheckpointStoryboardLifecycleStoredRecord, setCheckpointStoryboardLifecycleResolutionFaultHooksForTest } from "./checkpoint-storyboard-lifecycle-resolution.js";

const roots: string[] = [];
const itLinux = process.platform === "linux" ? it : it.skip;
afterEach(async () => await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))));

function lifecycleDescriptor() {
  const absent = (objectId: string) => ({ objectId, state: "absent", properties: [] });
  const present = (objectId: string, x: number, y: number, rotation: number, scale: number, opacity: number) => ({ objectId, state: "present", properties: [
    { property: "transform.x", value: x }, { property: "transform.y", value: y }, { property: "transform.rotation", value: rotation }, { property: "transform.scale", value: scale }, { property: "opacity", value: opacity },
  ] });
  const alpha = present("alpha", 12, 24, 15, 1.25, 0.75), zeta = present("zeta", -10, 40, 0, 1, 1);
  return {
    seed: 1, capabilityRequirements: ["renderer.native"],
    objectCatalog: [
      { objectId: "alpha", rootShapeKind: "ellipse", propertyMask: ["transform.x", "transform.y", "transform.rotation", "transform.scale", "opacity"], creation: { schema: "shellx-motion/private-checkpoint-storyboard-shape-creation@1", fill: "#4e8cff", width: 120, height: 80 } },
      { objectId: "zeta", rootShapeKind: "rect", propertyMask: ["transform.x", "transform.y", "transform.rotation", "transform.scale", "opacity"], creation: { schema: "shellx-motion/private-checkpoint-storyboard-shape-creation@1", fill: "#f3c547", width: 60, height: 40 } },
    ],
    checkpoints: [
      { id: "start", atUs: 0, objects: [absent("alpha"), absent("zeta")] },
      { id: "zeta-create", atUs: 100_000, objects: [absent("alpha"), zeta] },
      { id: "alpha-create", atUs: 300_000, objects: [alpha, zeta] },
      { id: "zeta-remove", atUs: 700_000, objects: [alpha, absent("zeta")] },
      { id: "finish", atUs: 1_000_000, objects: [alpha, absent("zeta")] },
    ],
    edges: [
      { id: "a-zeta-create", fromCheckpointId: "start", toCheckpointId: "zeta-create", lifecycle: [{ kind: "preserve", objectId: "alpha" }, { kind: "create", objectId: "zeta" }], recipeIds: [] },
      { id: "b-alpha-create", fromCheckpointId: "zeta-create", toCheckpointId: "alpha-create", lifecycle: [{ kind: "create", objectId: "alpha" }, { kind: "preserve", objectId: "zeta" }], recipeIds: [] },
      { id: "c-zeta-remove", fromCheckpointId: "alpha-create", toCheckpointId: "zeta-remove", lifecycle: [{ kind: "preserve", objectId: "alpha" }, { kind: "remove", objectId: "zeta" }], recipeIds: [] },
      { id: "d-finish", fromCheckpointId: "zeta-remove", toCheckpointId: "finish", lifecycle: [{ kind: "preserve", objectId: "alpha" }, { kind: "preserve", objectId: "zeta" }], recipeIds: [] },
    ], recipes: [],
  };
}

async function fixture() {
  const root = await mkdtemp(join(process.cwd(), ".c6c-b5-resolution-")); roots.push(root);
  const workspace = join(root, "workspace"), source = join(workspace, "source"), output = join(workspace, "output");
  await mkdir(join(source, "assets"), { recursive: true }); await mkdir(join(source, "receipts"), { recursive: true });
  await writeFile(join(source, "manifest.json"), JSON.stringify({ schema: "shellx-motion/package-manifest@1", id: "package-b5", name: "B5", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["native"], hosts: [] } }));
  await writeFile(join(source, "motion.json"), JSON.stringify({ schema: "shellx-motion/motion@1", id: "motion-b5", name: "B5", durationMs: 1_000, fps: 30, width: 1280, height: 720, layers: [{ id: "title", type: "text", text: "prefix", startMs: 0, durationMs: 1_000 }], assets: [], provenance: { sourceApp: "test", createdBy: "test" } }));
  const store = await configureCheckpointStoryboardRecordStore({ root, integrityKey: Buffer.alloc(32, 51) }), anchor = await createTrustedWorkspaceAnchor(workspace);
  const authority = await configureCheckpointStoryboardLifecycleResolutionAuthority({ recordStore: store, sourcePackageRoot: source, outputPackageRoot: output, packageWorkspaceRoot: workspace, packageWorkspaceAuthority: anchor });
  const created = await dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: lifecycleDescriptor() }, { tier: "write_local", checkpointStoryboardRecordStore: store });
  if (!created.ok) throw new Error(`Expected C6B5 record creation: ${created.error.code}`);
  const identity = (created.result as { record: { identity: { id: string; sha256: string; revision: number } } }).record.identity;
  return { root, workspace, source, output, store, authority, identity };
}
function services(value: Awaited<ReturnType<typeof fixture>>) { return { tier: "write_local" as const, checkpointStoryboardRecordStore: value.store, checkpointStoryboardLifecycleResolutionAuthority: value.authority }; }

describe("C6C B5 private lifecycle resolution", () => {
  it("rejects B6 geometry-morph residue before output mutation", async () => {
    const value = await fixture();
    await initializeGeometryMorphStateHead(checkedAuthority(value.store), value.identity, value.identity);
    await expect(resolveCheckpointStoryboardLifecycleStoredRecord(value.authority, value.identity)).rejects.toMatchObject({ code: "store_integrity_failed" });
    await expect(lstat(value.output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  itLinux("is identity-only, binds exact output, replays after source loss, and permanently detaches without deleting output", async () => {
    const value = await fixture();
    await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.lifecycleResolve, { identity: value.identity, outputPackageRoot: value.output }, services(value))).resolves.toMatchObject({ ok: false, error: { code: "invalid_args" } });
    const first = await dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.lifecycleResolve, { identity: value.identity }, services(value));
    expect(first).toMatchObject({ ok: true, result: { binding: { state: "bound", active: 1 }, renderer: { invoked: false, pixels: false } } }); expect(JSON.stringify(first)).not.toContain(value.workspace);
    await rm(value.source, { recursive: true, force: true });
    await expect(resolveCheckpointStoryboardLifecycleStoredRecord(value.authority, value.identity)).resolves.toMatchObject({ replayed: true, binding: { state: "bound" } });
    await expect(detachCheckpointStoryboardLifecycleStoredRecord(value.authority, value.identity)).resolves.toMatchObject({ binding: { state: "detached", active: 0 } });
    await expect(detachCheckpointStoryboardLifecycleStoredRecord(value.authority, value.identity)).resolves.toMatchObject({ replayed: true, binding: { state: "detached" } });
    await expect(resolveCheckpointStoryboardLifecycleStoredRecord(value.authority, value.identity)).rejects.toMatchObject({ code: "materialization_detached" });
    await expect(lstat(value.output)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
    await expect(readFile(join(value.output, "receipts", "checkpoint-storyboard-lifecycle-materialization.v1.json"), "utf8")).resolves.toContain("checkpoint-storyboard.lifecycle.materialize");
  }, 30_000);

  itLinux("repairs one head lag, refuses a second uncertain COW, and rejects complete-tree empty-directory drift", async () => {
    const lag = await fixture();
    setCheckpointStoryboardLifecycleResolutionFaultHooksForTest(lag.authority, { "after-intent-before-state-head": () => { throw new Error("intent lag"); } });
    await expect(resolveCheckpointStoryboardLifecycleStoredRecord(lag.authority, lag.identity)).rejects.toMatchObject({ code: "materialization_binding_uncertain" });
    setCheckpointStoryboardLifecycleResolutionFaultHooksForTest(lag.authority, undefined);
    await expect(resolveCheckpointStoryboardLifecycleStoredRecord(lag.authority, lag.identity)).resolves.toMatchObject({ binding: { state: "bound" } });

    const uncertain = await fixture(); let cows = 0;
    setCheckpointStoryboardLifecycleResolutionFaultHooksForTest(uncertain.authority, { "after-cow-start-before-state-head": () => { throw new Error("COW start lag"); }, "before-c6b5b": () => { cows += 1; } });
    await expect(resolveCheckpointStoryboardLifecycleStoredRecord(uncertain.authority, uncertain.identity)).rejects.toMatchObject({ code: "materialization_binding_uncertain" });
    setCheckpointStoryboardLifecycleResolutionFaultHooksForTest(uncertain.authority, { "before-c6b5b": () => { cows += 1; } });
    await expect(resolveCheckpointStoryboardLifecycleStoredRecord(uncertain.authority, uncertain.identity)).rejects.toMatchObject({ code: "materialization_binding_uncertain" }); expect(cows).toBe(0);

    const tampered = await fixture(); await resolveCheckpointStoryboardLifecycleStoredRecord(tampered.authority, tampered.identity); await mkdir(join(tampered.output, "assets", "late-empty"));
    await expect(detachCheckpointStoryboardLifecycleStoredRecord(tampered.authority, tampered.identity)).rejects.toMatchObject({ code: expect.stringMatching(/^(?:materialization_binding_conflict|materialization_binding_uncertain)$/u) });
  }, 30_000);
});
