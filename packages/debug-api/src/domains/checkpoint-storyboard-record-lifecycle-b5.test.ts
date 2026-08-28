import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { debugCommandDefinition } from "../command-registry.js";
import { debugCommandContract } from "../command-metadata.js";
import { CHECKPOINT_STORYBOARD_RECORD_COMMAND_METADATA } from "../command-metadata-checkpoint-storyboard.js";
import { CHECKPOINT_STORYBOARD_RECORD_COMMANDS, dispatchCheckpointStoryboardRecordLifecycleCommand } from "./checkpoint-storyboard-record-lifecycle.js";
import { checkedAuthority } from "./checkpoint-storyboard-record-store-authority.js";
import { configureCheckpointStoryboardRecordStore, issueCheckpointStoryboardRecordStoreQuiescentAdmission, recoverCheckpointStoryboardRecordStoreForQuiescentHost, type CheckpointStoryboardRecordStoreAuthority } from "./checkpoint-storyboard-record-store.js";
import { initializeMaterializationStateHead } from "./checkpoint-storyboard-materialization-bindings.js";
import { initializeLifecycleStateHead } from "./checkpoint-storyboard-lifecycle-resolution-journal.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))); });

function descriptor() {
  return {
    seed: 1,
    capabilityRequirements: ["renderer.native"],
    objectCatalog: [{ objectId: "orb", rootShapeKind: "ellipse", propertyMask: ["transform.x", "transform.y", "transform.rotation", "transform.scale", "opacity"] }],
    checkpoints: [checkpoint("start", 0, 0, 0, 0, 1, 1), checkpoint("finish", 1_000_000, 100, 50, 90, 2, 0.5)],
    edges: [{ id: "start-finish", fromCheckpointId: "start", toCheckpointId: "finish", lifecycle: [{ kind: "preserve", objectId: "orb" }], recipeIds: ["scalar", "spatial"] }],
    recipes: [
      { recipeId: "scalar", seed: 2, exactBaseRequirements: [], intent: { kind: "checkpoint-keyframe", easing: "ease-in-out", targets: [{ objectId: "orb", propertyMask: ["transform.rotation", "transform.scale", "opacity"] }] } },
      { recipeId: "spatial", seed: 3, exactBaseRequirements: [], intent: { kind: "checkpoint-spatial-path", targets: [{ objectId: "orb", tangentMode: "auto" }] } },
    ],
  };
}
function lifecycleDescriptor(seed = 1) {
  const absent = (objectId: string) => ({ objectId, state: "absent", properties: [] });
  const present = (objectId: string, x: number, y: number, rotation: number, scale: number, opacity: number) => ({ objectId, state: "present", properties: [
    { property: "transform.x", value: x }, { property: "transform.y", value: y }, { property: "transform.rotation", value: rotation }, { property: "transform.scale", value: scale }, { property: "opacity", value: opacity },
  ] });
  const alpha = present("alpha", 12, 24, 15, 1.25, 0.75), zeta = present("zeta", -10, 40, 0, 1, 1);
  return {
    seed,
    capabilityRequirements: ["renderer.native"],
    objectCatalog: [
      { objectId: "alpha", rootShapeKind: "ellipse", propertyMask: ["transform.x", "transform.y", "transform.rotation", "transform.scale", "opacity"], creation: { schema: "shellx-motion/private-checkpoint-storyboard-shape-creation@1", fill: "#4e8cff", width: 120, height: 80 } },
      { objectId: "zeta", rootShapeKind: "rect", propertyMask: ["transform.x", "transform.y", "transform.rotation", "transform.scale", "opacity"], creation: { schema: "shellx-motion/private-checkpoint-storyboard-shape-creation@1", fill: "#f3c547", width: 60, height: 40 } },
    ],
    checkpoints: [
      { id: "start", atUs: 0, objects: [absent("alpha"), absent("zeta")] }, { id: "zeta-create", atUs: 100_000, objects: [absent("alpha"), zeta] },
      { id: "alpha-create", atUs: 300_000, objects: [alpha, zeta] }, { id: "zeta-remove", atUs: 700_000, objects: [alpha, absent("zeta")] }, { id: "finish", atUs: 1_000_000, objects: [alpha, absent("zeta")] },
    ],
    edges: [
      { id: "a-zeta-create", fromCheckpointId: "start", toCheckpointId: "zeta-create", lifecycle: [{ kind: "preserve", objectId: "alpha" }, { kind: "create", objectId: "zeta" }], recipeIds: [] },
      { id: "b-alpha-create", fromCheckpointId: "zeta-create", toCheckpointId: "alpha-create", lifecycle: [{ kind: "create", objectId: "alpha" }, { kind: "preserve", objectId: "zeta" }], recipeIds: [] },
      { id: "c-zeta-remove", fromCheckpointId: "alpha-create", toCheckpointId: "zeta-remove", lifecycle: [{ kind: "preserve", objectId: "alpha" }, { kind: "remove", objectId: "zeta" }], recipeIds: [] },
      { id: "d-finish", fromCheckpointId: "zeta-remove", toCheckpointId: "finish", lifecycle: [{ kind: "preserve", objectId: "alpha" }, { kind: "preserve", objectId: "zeta" }], recipeIds: [] },
    ],
    recipes: [],
  };
}
function checkpoint(id: string, atUs: number, x: number, y: number, rotation: number, scale: number, opacity: number) {
  return { id, atUs, objects: [{ objectId: "orb", state: "present", properties: [
    { property: "transform.x", value: x }, { property: "transform.y", value: y }, { property: "transform.rotation", value: rotation }, { property: "transform.scale", value: scale }, { property: "opacity", value: opacity },
  ] }] };
}
async function host() {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-c6c-record-"));
  roots.push(root);
  const authority = await configureCheckpointStoryboardRecordStore({ root, integrityKey: Buffer.alloc(32, 7) });
  return { root, authority };
}
async function call(command: string, args: unknown, authority: CheckpointStoryboardRecordStoreAuthority) {
  return await dispatchCheckpointStoryboardRecordLifecycleCommand(command as never, args, { checkpointStoryboardRecordStore: authority });
}
function succeeded(result: Awaited<ReturnType<typeof call>>) {
  expect(result?.ok).toBe(true);
  if (!result?.ok) throw new Error("Expected success.");
  return result.result as { record: { identity: { id: string; sha256: string; revision: number }; storyboard?: unknown; admission: { staticProfileAdmitted: boolean }; }; evidence?: { id: string }; replay?: string };
}
function receiptPath(root: string, evidenceId: string): string { return join(root, ".shellx-motion-c6c-record-store", "receipts", `${evidenceId}.json`); }

describe("C6C B5 checkpoint storyboard lifecycle boundary", () => {
  it("seals B5 lifecycle admission and evidence without widening B1 bytes or cross-partition revisions", async () => {
    const { root, authority } = await host();
    const b1 = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: descriptor() }, authority));
    const b5 = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: lifecycleDescriptor() }, authority));
    expect(b5.record.admission).toEqual({ staticProfileAdmitted: true, profile: "c6b5-lifecycle@1" });

    const b1Stored = JSON.parse(await readFile(join(root, ".shellx-motion-c6c-record-store", "records", `${b1.record.identity.id}.json`), "utf8")) as { payload: { admission: Record<string, unknown> } };
    const b5Stored = JSON.parse(await readFile(join(root, ".shellx-motion-c6c-record-store", "records", `${b5.record.identity.id}.json`), "utf8")) as { payload: { admission: Record<string, unknown> } };
    const b5Evidence = JSON.parse(await readFile(receiptPath(root, b5.evidence!.id), "utf8")) as { payload: { admission: Record<string, unknown> } };
    const b5State = JSON.parse(await readFile(join(root, ".shellx-motion-c6c-record-store", "lifecycle-resolutions", `${b5.record.identity.id}.state.json`), "utf8")) as { payload: Record<string, unknown> };
    expect(Object.hasOwn(b1Stored.payload.admission, "profile")).toBe(false);
    expect(b5Stored.payload.admission).toEqual({ staticProfileAdmitted: true, profile: "c6b5-lifecycle@1" });
    expect(b5Evidence.payload.admission).toEqual({ staticProfileAdmitted: true, profile: "c6b5-lifecycle@1" });
    expect(b5State.payload).toMatchObject({ schema: "shellx-motion/private-checkpoint-storyboard-lifecycle-resolution-state@1", identity: b5.record.identity, state: "unbound", active: 0 });
    await expect(readFile(join(root, ".shellx-motion-c6c-record-store", "lifecycle-resolutions", `${b1.record.identity.id}.state.json`), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const replay = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: lifecycleDescriptor() }, authority));
    expect(replay.replay).toBe("same-input");
    expect(replay.record.identity).toEqual(b5.record.identity);
    const revised = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.revise, { parent: b5.record.identity, descriptor: lifecycleDescriptor(2) }, authority));
    expect(revised.record).toMatchObject({ admission: { staticProfileAdmitted: true, profile: "c6b5-lifecycle@1" }, storyboard: { parentRevision: { id: b5.record.identity.id, sha256: b5.record.identity.sha256 } } });
    expect(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.revise, { parent: b5.record.identity, descriptor: descriptor() }, authority)).toMatchObject({ ok: false, error: { code: "record_identity_conflict" } });
    expect(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.revise, { parent: b1.record.identity, descriptor: lifecycleDescriptor(3) }, authority)).toMatchObject({ ok: false, error: { code: "record_identity_conflict" } });
  });

  it("refuses signed B5 evidence on B1 and signed B1 evidence on B5", async () => {
    const { authority } = await host();
    const b1 = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: descriptor() }, authority));
    const b5 = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: lifecycleDescriptor() }, authority));
    const facts = checkedAuthority(authority);
    await initializeLifecycleStateHead(facts, b1.record.identity, b1.record.identity);
    expect(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.inspect, { identity: b1.record.identity }, authority)).toMatchObject({ ok: false, error: { code: "store_integrity_failed" } });
    await initializeMaterializationStateHead(facts, b5.record.identity, b5.record.identity);
    expect(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.inspect, { identity: b5.record.identity }, authority)).toMatchObject({ ok: false, error: { code: "store_integrity_failed" } });
  });

  it("scans the complete B5 namespace before tombstone and archive", async () => {
    const uuid = `${"a".repeat(8)}-${"b".repeat(4)}-${"c".repeat(4)}-${"d".repeat(4)}-${"e".repeat(12)}`;
    const removal = await host();
    const removalRecord = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: descriptor() }, removal.authority));
    await writeFile(join(removal.root, ".shellx-motion-c6c-record-store", "lifecycle-resolutions", `orphan.${uuid}.tmp`), "foreign B5 residue", { mode: 0o600 });
    expect(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.remove, { identity: removalRecord.record.identity }, removal.authority)).toMatchObject({ ok: false, error: { code: "store_integrity_failed" } });

    const archive = await host();
    const archiveRecord = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: descriptor() }, archive.authority));
    await writeFile(join(archive.root, ".shellx-motion-c6c-record-store", "lifecycle-resolutions", `orphan.${uuid}.tmp`), "foreign B5 residue", { mode: 0o600 });
    expect(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.archive, { identity: archiveRecord.record.identity }, archive.authority)).toMatchObject({ ok: false, error: { code: "store_integrity_failed" } });
  });

  it("keeps C6B5 lifecycle resolution identity-only and refuses an absent host authority", async () => {
    const { authority } = await host();
    const identity = { id: `checkpoint_storyboard_${"a".repeat(32)}`, sha256: "a".repeat(64), revision: 1 };
    for (const command of [CHECKPOINT_STORYBOARD_RECORD_COMMANDS.lifecycleResolve, CHECKPOINT_STORYBOARD_RECORD_COMMANDS.lifecycleDetach]) {
      await expect(call(command, { identity, package: "/caller-selected-package" }, authority)).resolves.toMatchObject({ ok: false, error: { code: "invalid_args" } });
      await expect(call(command, { identity }, authority)).resolves.toMatchObject({ ok: false, error: { code: "capability_unavailable" } });
    }
  });

  it("provisions, authenticates, and recovers only grammar-recognized B5 lifecycle journal staging", async () => {
    const { root, authority } = await host();
    const created = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: descriptor() }, authority));
    const journals = join(root, ".shellx-motion-c6c-record-store", "lifecycle-resolutions");
    const uuid = `${"a".repeat(8)}-${"b".repeat(4)}-${"c".repeat(4)}-${"d".repeat(4)}-${"e".repeat(12)}`;
    const recognized = join(journals, `${created.record.identity.id}.state.json.${uuid}.tmp`);
    const unrelated = join(journals, `orphan.${uuid}.tmp`);
    await writeFile(recognized, "private stage", { mode: 0o600 });
    await writeFile(unrelated, "must not be selected", { mode: 0o600 });
    await expect(recoverCheckpointStoryboardRecordStoreForQuiescentHost(authority, issueCheckpointStoryboardRecordStoreQuiescentAdmission(authority))).resolves.toEqual({ removedTemporaryFiles: 1, removedStaleLocks: 0 });
    await expect(readFile(recognized, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(unrelated, "utf8")).resolves.toBe("must not be selected");

    const moved = `${journals}-replaced`;
    await rename(journals, moved);
    await mkdir(journals, { mode: 0o700 });
    expect(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.inspect, { identity: created.record.identity }, authority)).toMatchObject({ ok: false, error: { code: "store_authority_refused" } });
  });

  it("publishes inherited lifecycle metadata and exact B5/B6 identity-only command contracts", () => {
    const commands = Object.values(CHECKPOINT_STORYBOARD_RECORD_COMMANDS);
    expect(commands.map((command) => debugCommandDefinition(command))).toEqual(commands.map((command) => expect.objectContaining(command === CHECKPOINT_STORYBOARD_RECORD_COMMANDS.inspect ? { permission: "read_motion", mutates: false } : command === CHECKPOINT_STORYBOARD_RECORD_COMMANDS.preview || command === CHECKPOINT_STORYBOARD_RECORD_COMMANDS.retainedTracePreview ? { permission: "render_motion", mutates: true } : { permission: "write_local", mutates: true })));
    expect(Object.keys(CHECKPOINT_STORYBOARD_RECORD_COMMAND_METADATA).sort()).toEqual(commands.slice().sort());
    expect(CHECKPOINT_STORYBOARD_RECORD_COMMAND_METADATA[CHECKPOINT_STORYBOARD_RECORD_COMMANDS.materialize].argsSchema).toEqual({ type: "object", additionalProperties: false, required: ["identity"], properties: { identity: expect.any(Object) } });
    for (const command of [CHECKPOINT_STORYBOARD_RECORD_COMMANDS.lifecycleResolve, CHECKPOINT_STORYBOARD_RECORD_COMMANDS.lifecycleDetach, CHECKPOINT_STORYBOARD_RECORD_COMMANDS.geometryMorphResolve, CHECKPOINT_STORYBOARD_RECORD_COMMANDS.geometryMorphDetach]) {
      expect(CHECKPOINT_STORYBOARD_RECORD_COMMAND_METADATA[command].argsSchema).toEqual({ type: "object", additionalProperties: false, required: ["identity"], properties: { identity: expect.any(Object) } });
      expect(debugCommandContract(command)?.argsSchema).toEqual(CHECKPOINT_STORYBOARD_RECORD_COMMAND_METADATA[command].argsSchema);
    }
    expect(CHECKPOINT_STORYBOARD_RECORD_COMMAND_METADATA[CHECKPOINT_STORYBOARD_RECORD_COMMANDS.preview].argsSchema).toEqual({
      type: "object", additionalProperties: false, required: ["identity", "target"], properties: {
        identity: expect.any(Object), target: expect.objectContaining({ type: "object", oneOf: [expect.objectContaining({ required: ["kind", "checkpointId"], additionalProperties: false }), expect.objectContaining({ required: ["kind", "atMs"], additionalProperties: false })] }),
      },
    });
    const creativeReviewSchema = CHECKPOINT_STORYBOARD_RECORD_COMMAND_METADATA[CHECKPOINT_STORYBOARD_RECORD_COMMANDS.creativeReviewBind].argsSchema;
    expect(creativeReviewSchema).toMatchObject({
      type: "object", additionalProperties: false, required: ["identity", "preview", "creativeReviewHandle"], properties: {
        identity: { type: "object", properties: { id: { type: "string", minLength: 54, maxLength: 54, pattern: "^checkpoint_storyboard_[a-f0-9]{32}$" }, sha256: { type: "string", minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" }, revision: { type: "number", minimum: 1, maximum: 1_000_000, multipleOf: 1 } } },
        preview: { additionalProperties: false, required: ["previewHandle", "receiptHandle"], properties: { previewHandle: { type: "string", minLength: 62, maxLength: 62, pattern: "^checkpoint_storyboard_preview_[a-f0-9]{32}$" }, receiptHandle: { type: "string", minLength: 70, maxLength: 70, pattern: "^checkpoint_storyboard_preview_receipt_[a-f0-9]{32}$" } } },
        creativeReviewHandle: { type: "string", minLength: 77, maxLength: 77, pattern: "^checkpoint_storyboard_creative_review_handle_[a-f0-9]{32}$" },
      },
    });
    expect(debugCommandContract(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.creativeReviewBind)?.argsSchema).toEqual(creativeReviewSchema);
    const profiles = CHECKPOINT_STORYBOARD_RECORD_COMMAND_METADATA[CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create].argsSchema.properties.descriptor!.oneOf!;
    const profileName = (profile: typeof profiles[number]): string => {
      if (profile.properties?.schema?.enum?.[0] === "shellx-motion/data-recipe-checkpoint@1") return "C6D data-recipe";
      if (profile.properties?.schema?.enum?.[0] === "shellx-motion/data-recipe-choreography@1") return "C6D choreography";
      for (const name of ["C6A B1", "C6B2", "C6B3", "C6B4", "C6B5", "C6B6", "C6B7"]) {
        if (profile.description?.includes(name)) return name;
      }
      return "unknown";
    };
    expect(profiles).toHaveLength(9);
    expect(profiles.map(profileName)).toEqual(["C6A B1", "C6B2", "C6B3", "C6B4", "C6B5", "C6B6", "C6B7", "C6D data-recipe", "C6D choreography"]);
  });
});
