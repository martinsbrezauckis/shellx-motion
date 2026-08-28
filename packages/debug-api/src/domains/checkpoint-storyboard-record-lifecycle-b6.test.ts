import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CHECKPOINT_STORYBOARD_RECORD_COMMANDS, dispatchCheckpointStoryboardRecordLifecycleCommand } from "./checkpoint-storyboard-record-lifecycle.js";
import { initializeMaterializationStateHead } from "./checkpoint-storyboard-materialization-bindings.js";
import { initializeGeometryMorphStateHead } from "./checkpoint-storyboard-geometry-morph-resolution-journal.js";
import { checkedAuthority } from "./checkpoint-storyboard-record-store-authority.js";
import { configureCheckpointStoryboardRecordStore, issueCheckpointStoryboardRecordStoreQuiescentAdmission, recoverCheckpointStoryboardRecordStoreForQuiescentHost, type CheckpointStoryboardRecordStoreAuthority } from "./checkpoint-storyboard-record-store.js";

const roots: string[] = [];
const VIEW_BOX = { x: -100, y: -100, width: 400, height: 400 };
const START = polygon([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }]);
const END = polygon([{ x: 20, y: 20 }, { x: 120, y: 20 }, { x: 20, y: 120 }]);

afterEach(async () => { await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))); });

function polygon(points: readonly { readonly x: number; readonly y: number }[]) {
  return { schema: "shellx-motion/shape-geometry@1", kind: "polygon", viewBox: { ...VIEW_BOX }, points: points.map((point) => ({ ...point })) };
}
function scalarDescriptor() {
  return {
    seed: 1, capabilityRequirements: ["renderer.native"],
    objectCatalog: [{ objectId: "orb", rootShapeKind: "ellipse", propertyMask: ["transform.x", "transform.y", "transform.rotation", "transform.scale", "opacity"] }],
    checkpoints: [checkpoint("start", 0, 0, 0), checkpoint("finish", 1_000_000, 100, 50)],
    edges: [{ id: "start-finish", fromCheckpointId: "start", toCheckpointId: "finish", lifecycle: [{ kind: "preserve", objectId: "orb" }], recipeIds: ["scalar", "spatial"] }],
    recipes: [
      { recipeId: "scalar", seed: 2, exactBaseRequirements: [], intent: { kind: "checkpoint-keyframe", easing: "ease-in-out", targets: [{ objectId: "orb", propertyMask: ["transform.rotation", "transform.scale", "opacity"] }] } },
      { recipeId: "spatial", seed: 3, exactBaseRequirements: [], intent: { kind: "checkpoint-spatial-path", targets: [{ objectId: "orb", tangentMode: "auto" }] } },
    ],
  };
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
function checkpoint(id: string, atUs: number, x: number, y: number) {
  return { id, atUs, objects: [{ objectId: "orb", state: "present", properties: [
    { property: "transform.x", value: x }, { property: "transform.y", value: y }, { property: "transform.rotation", value: 0 }, { property: "transform.scale", value: 1 }, { property: "opacity", value: 1 },
  ] }] };
}
async function host() {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-c6c-b6-record-"));
  roots.push(root);
  return { root, authority: await configureCheckpointStoryboardRecordStore({ root, integrityKey: Buffer.alloc(32, 7) }) };
}
async function call(command: string, args: unknown, authority: CheckpointStoryboardRecordStoreAuthority) {
  return await dispatchCheckpointStoryboardRecordLifecycleCommand(command as never, args, { checkpointStoryboardRecordStore: authority });
}
function succeeded(result: Awaited<ReturnType<typeof call>>) {
  expect(result?.ok).toBe(true);
  if (!result?.ok) throw new Error("Expected success.");
  return result.result as { readonly record: { readonly identity: { readonly id: string; readonly sha256: string; readonly revision: number }; readonly admission: Record<string, unknown> }; readonly replay?: string };
}

describe("C6C B6 checkpoint storyboard geometry-morph record-store partition", () => {
  it("seals B6 admission, creates only its B6 state head, and keeps revisions partitioned", async () => {
    const { root, authority } = await host();
    const b1 = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: scalarDescriptor() }, authority));
    const b6 = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: geometryMorphDescriptor() }, authority));
    expect(b6.record.admission).toEqual({ staticProfileAdmitted: true, profile: "c6b6-geometry-morph@1" });

    const statePath = (identity: { readonly id: string }) => join(root, ".shellx-motion-c6c-record-store", "geometry-morph-resolutions", `${identity.id}.state.json`);
    expect(JSON.parse(await readFile(statePath(b6.record.identity), "utf8"))).toMatchObject({ payload: { schema: "shellx-motion/private-checkpoint-storyboard-geometry-morph-resolution-state@1", identity: b6.record.identity, state: "unbound", active: 0 } });
    await expect(readFile(statePath(b1.record.identity), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const replay = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: geometryMorphDescriptor() }, authority));
    expect(replay).toMatchObject({ replay: "same-input", record: { identity: b6.record.identity } });
    const revised = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.revise, { parent: b6.record.identity, descriptor: geometryMorphDescriptor(2) }, authority));
    expect(revised.record.admission).toEqual({ staticProfileAdmitted: true, profile: "c6b6-geometry-morph@1" });
    await expect(call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.revise, { parent: b6.record.identity, descriptor: scalarDescriptor() }, authority)).resolves.toMatchObject({ ok: false, error: { code: "record_identity_conflict" } });
  });

  it("rejects B6 evidence on every non-B6 profile and legacy B1 evidence on B6", async () => {
    const { authority } = await host();
    const b1 = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: scalarDescriptor() }, authority));
    const b6 = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: geometryMorphDescriptor() }, authority));
    const facts = checkedAuthority(authority);
    await initializeGeometryMorphStateHead(facts, b1.record.identity, b1.record.identity);
    await expect(call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.inspect, { identity: b1.record.identity }, authority)).resolves.toMatchObject({ ok: false, error: { code: "store_integrity_failed" } });
    await initializeMaterializationStateHead(facts, b6.record.identity, b6.record.identity);
    await expect(call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.inspect, { identity: b6.record.identity }, authority)).resolves.toMatchObject({ ok: false, error: { code: "store_integrity_failed" } });
  });

  it("scans the complete B6 namespace before destructive operations", async () => {
    const uuid = `${"a".repeat(8)}-${"b".repeat(4)}-${"c".repeat(4)}-${"d".repeat(4)}-${"e".repeat(12)}`;
    const removal = await host();
    const removalRecord = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: scalarDescriptor() }, removal.authority));
    await writeFile(join(removal.root, ".shellx-motion-c6c-record-store", "geometry-morph-resolutions", `orphan.${uuid}.tmp`), "foreign B6 residue", { mode: 0o600 });
    await expect(call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.remove, { identity: removalRecord.record.identity }, removal.authority)).resolves.toMatchObject({ ok: false, error: { code: "store_integrity_failed" } });

    const archive = await host();
    const archiveRecord = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: scalarDescriptor() }, archive.authority));
    await writeFile(join(archive.root, ".shellx-motion-c6c-record-store", "geometry-morph-resolutions", `orphan.${uuid}.tmp`), "foreign B6 residue", { mode: 0o600 });
    await expect(call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.archive, { identity: archiveRecord.record.identity }, archive.authority)).resolves.toMatchObject({ ok: false, error: { code: "store_integrity_failed" } });
  });

  it("recovers only B6 grammar-valid stages and refuses a replaced B6 authority child", async () => {
    const { root, authority } = await host();
    const created = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: geometryMorphDescriptor() }, authority));
    const journal = join(root, ".shellx-motion-c6c-record-store", "geometry-morph-resolutions");
    const uuid = `${"a".repeat(8)}-${"b".repeat(4)}-${"c".repeat(4)}-${"d".repeat(4)}-${"e".repeat(12)}`;
    const recognized = join(journal, `${created.record.identity.id}.state.json.${uuid}.tmp`);
    const unrelated = join(journal, `orphan.${uuid}.tmp`);
    await writeFile(recognized, "private stage", { mode: 0o600 });
    await writeFile(unrelated, "must not be selected", { mode: 0o600 });
    await expect(recoverCheckpointStoryboardRecordStoreForQuiescentHost(authority, issueCheckpointStoryboardRecordStoreQuiescentAdmission(authority))).resolves.toEqual({ removedTemporaryFiles: 1, removedStaleLocks: 0 });
    await expect(readFile(recognized, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(unrelated, "utf8")).resolves.toBe("must not be selected");

    await rename(journal, `${journal}-replaced`);
    await mkdir(journal, { mode: 0o700 });
    await expect(call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.inspect, { identity: created.record.identity }, authority)).resolves.toMatchObject({ ok: false, error: { code: "store_authority_refused" } });
  });
});
