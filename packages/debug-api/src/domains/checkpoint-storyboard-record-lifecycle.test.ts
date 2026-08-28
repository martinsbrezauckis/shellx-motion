import { chmod, cp, link, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchDebugCommand } from "../index.js";
import {
  CHECKPOINT_STORYBOARD_RECORD_COMMANDS,
  dispatchCheckpointStoryboardRecordLifecycleCommand,
} from "./checkpoint-storyboard-record-lifecycle.js";
import {
  configureCheckpointStoryboardRecordStore,
  createCheckpointStoryboardStoredRecord,
  issueCheckpointStoryboardRecordStoreQuiescentAdmission,
  inspectCheckpointStoryboardStoredRecord,
  recoverCheckpointStoryboardRecordStoreForQuiescentHost,
  type CheckpointStoryboardRecordStoreAuthority,
} from "./checkpoint-storyboard-record-store.js";

/** Test-module-only filesystem faults; production has no test or race callback seam. */
const fsFault = vi.hoisted(() => ({ replaceTarget: "", replacement: "", replaceAtOpen: false, publicationDirectory: "", linked: false, failDirectorySync: false, failLink: false, failTempClose: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const path = await import("node:path");
  return {
    ...actual,
    link: (async (...args: any[]) => {
      if (fsFault.failLink && typeof args[1] === "string" && path.resolve(path.dirname(args[1])) === fsFault.publicationDirectory) {
        fsFault.failLink = false;
        throw Object.assign(new Error("test link failure"), { code: "EIO" });
      }
      const result = await (actual.link as any)(...args);
      if (fsFault.failDirectorySync && typeof args[1] === "string" && path.resolve(path.dirname(args[1])) === fsFault.publicationDirectory) fsFault.linked = true;
      return result;
    }) as typeof actual.link,
    open: (async (...args: any[]) => {
      if (fsFault.replaceAtOpen && typeof args[0] === "string" && path.resolve(args[0]) === fsFault.replaceTarget) {
        fsFault.replaceAtOpen = false;
        await actual.rename(fsFault.replacement, args[0]);
      }
      const handle = await (actual.open as any)(...args);
      if (fsFault.failTempClose && typeof args[0] === "string" && args[0].endsWith(".tmp")) {
        fsFault.failTempClose = false;
        const close = (handle as { close: () => Promise<void> }).close.bind(handle);
        (handle as { close: () => Promise<void> }).close = async () => { await close(); throw Object.assign(new Error("test close failure"), { code: "EIO" }); };
      }
      if (typeof args[0] === "string" && path.resolve(args[0]) === fsFault.publicationDirectory) {
        const sync = (handle as { sync: () => Promise<void> }).sync.bind(handle);
        (handle as { sync: () => Promise<void> }).sync = async () => {
          if (fsFault.failDirectorySync && fsFault.linked) {
            fsFault.failDirectorySync = false;
            throw Object.assign(new Error("test directory sync failure"), { code: "EIO" });
          }
          await sync();
        };
      }
      return handle;
    }) as typeof actual.open,
  };
});

const roots: string[] = [];
afterEach(async () => {
  fsFault.replaceTarget = "";
  fsFault.replacement = "";
  fsFault.replaceAtOpen = false;
  fsFault.publicationDirectory = "";
  fsFault.linked = false;
  fsFault.failDirectorySync = false;
  fsFault.failLink = false;
  fsFault.failTempClose = false;
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

function descriptor(rotation = 90) {
  return {
    seed: 1,
    capabilityRequirements: ["renderer.native"],
    objectCatalog: [{ objectId: "orb", rootShapeKind: "ellipse", propertyMask: ["transform.x", "transform.y", "transform.rotation", "transform.scale", "opacity"] }],
    checkpoints: [
      checkpoint("start", 0, 0, 0, 0, 1, 1),
      checkpoint("finish", 1_000_000, 100, 50, rotation, 2, 0.5),
    ],
    edges: [{ id: "start-finish", fromCheckpointId: "start", toCheckpointId: "finish", lifecycle: [{ kind: "preserve", objectId: "orb" }], recipeIds: ["scalar", "spatial"] }],
    recipes: [
      { recipeId: "scalar", seed: 2, exactBaseRequirements: [], intent: { kind: "checkpoint-keyframe", easing: "ease-in-out", targets: [{ objectId: "orb", propertyMask: ["transform.rotation", "transform.scale", "opacity"] }] } },
      { recipeId: "spatial", seed: 3, exactBaseRequirements: [], intent: { kind: "checkpoint-spatial-path", targets: [{ objectId: "orb", tangentMode: "auto" }] } },
    ],
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
  return { root, authority, services: { checkpointStoryboardRecordStore: authority } };
}
async function call(command: string, args: unknown, authority: CheckpointStoryboardRecordStoreAuthority) {
  return await dispatchCheckpointStoryboardRecordLifecycleCommand(command as never, args, { checkpointStoryboardRecordStore: authority });
}
function succeeded(result: Awaited<ReturnType<typeof call>>) {
  expect(result?.ok).toBe(true);
  if (!result?.ok) throw new Error("Expected success.");
  return result.result as { record: { identity: { id: string; sha256: string; revision: number }; storyboard?: unknown; target: { state: string }; archive: { terminal: boolean }; admission: { staticProfileAdmitted: boolean }; materializationBinding: { state: string; active: number } }; evidence?: { id: string; sha256: string; operation: string }; replay?: string };
}
function receiptPath(root: string, evidenceId: string): string {
  return join(root, ".shellx-motion-c6c-record-store", "receipts", `${evidenceId}.json`);
}

describe("C6C B1 host-owned immutable checkpoint storyboard records", () => {
  it("seals only unsealed descriptors, replays the same input deterministically, and never exposes host paths", async () => {
    const { root, authority } = await host();
    const first = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: descriptor() }, authority));
    expect(first.record.identity.revision).toBe(1);
    expect(first.record.admission).toEqual({ staticProfileAdmitted: true });
    const legacyRecord = JSON.parse(await readFile(join(root, ".shellx-motion-c6c-record-store", "records", `${first.record.identity.id}.json`), "utf8")) as { payload: { admission: Record<string, unknown> } };
    expect(Object.hasOwn(legacyRecord.payload.admission, "profile")).toBe(false);
    expect(first.record.materializationBinding).toEqual({ state: "unbound", active: 0 });
    expect(first).toHaveProperty("evidence.operation", "timeline.checkpoint-storyboard.create");
    expect(JSON.stringify(first)).not.toMatch(/shellx-motion-c6c-record|\.shellx-motion-c6c-record-store|exactBaseValidated|materializable/i);

    const replay = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: descriptor() }, authority));
    expect(replay.replay).toBe("same-input");
    expect(replay.record.identity).toEqual(first.record.identity);
    expect(replay.evidence).toEqual(first.evidence);

    const inspected = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.inspect, { identity: first.record.identity }, authority));
    expect(inspected.record.target.state).toBe("active");
    const loose = await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.inspect, { identity: { id: first.record.identity.id } }, authority);
    expect(loose).toMatchObject({ ok: false, error: { code: "invalid_args" } });
  });

  it("completes a same-input retry when immutable bytes exist but the active final marker was interrupted", async () => {
    const { root, authority } = await host();
    const created = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: descriptor() }, authority));
    await rm(join(root, ".shellx-motion-c6c-record-store", "targets", `${created.record.identity.id}.active.json`));
    const recovered = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: descriptor() }, authority));
    expect(recovered.replay).toBe("same-input");
    expect(recovered.record.target.state).toBe("active");
    expect(recovered.evidence).toEqual(created.evidence);
  });

  it("fails closed when an existing immutable record is missing its lineage journal", async () => {
    const { root, authority } = await host();
    const created = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: descriptor() }, authority));
    await rm(join(root, ".shellx-motion-c6c-record-store", "lineages", `${created.record.identity.id}.open.json`));
    expect(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: descriptor() }, authority)).toMatchObject({ ok: false, error: { code: "store_integrity_failed" } });
  });

  it("routes the opaque configured authority through production Debug dispatch and refuses its absence", async () => {
    const { authority } = await host();
    await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: descriptor() }, { tier: "write_local", checkpointStoryboardRecordStore: authority })).resolves.toMatchObject({ ok: true, result: { record: { admission: { staticProfileAdmitted: true } } } });
    await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: descriptor() }, { tier: "write_local" })).resolves.toMatchObject({ ok: false, error: { code: "capability_unavailable" } });
  });

  it("reopens an exact parent host-side, preserves lineage, and refuses forged or caller-supplied parent identity", async () => {
    const { authority } = await host();
    const parent = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: descriptor() }, authority)).record.identity;
    const revised = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.revise, { parent, descriptor: descriptor(180) }, authority));
    expect(revised.record.identity.revision).toBe(2);
    expect(revised.record).toMatchObject({ storyboard: { parentRevision: { id: parent.id, sha256: parent.sha256 } } });
    expect(revised.evidence).toMatchObject({ operation: "timeline.checkpoint-storyboard.revise" });

    const forged = await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.revise, { parent: { id: `checkpoint_storyboard_${"f".repeat(32)}`, sha256: "f".repeat(64), revision: parent.revision }, descriptor: descriptor(270) }, authority);
    expect(forged).toMatchObject({ ok: false, error: { code: "record_not_found" } });
    const supplied = structuredClone(descriptor(270)) as Record<string, unknown>;
    supplied.parent = {};
    expect(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.revise, { parent, descriptor: supplied }, authority)).toMatchObject({ ok: false, error: { code: "checkpoint_storyboard_record_invalid" } });
  });

  it("reopens every bounded immutable ancestor and fails closed for a missing parent or root", async () => {
    const first = await host();
    const root = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: descriptor() }, first.authority)).record.identity;
    const parent = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.revise, { parent: root, descriptor: descriptor(180) }, first.authority)).record.identity;
    const child = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.revise, { parent, descriptor: descriptor(270) }, first.authority)).record.identity;
    await rm(join(first.root, ".shellx-motion-c6c-record-store", "records", `${parent.id}.json`));
    expect(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.inspect, { identity: child }, first.authority)).toMatchObject({ ok: false, error: { code: "store_integrity_failed" } });

    const second = await host();
    const secondRoot = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: descriptor() }, second.authority)).record.identity;
    const secondChild = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.revise, { parent: secondRoot, descriptor: descriptor(180) }, second.authority)).record.identity;
    await rm(join(second.root, ".shellx-motion-c6c-record-store", "records", `${secondRoot.id}.json`));
    expect(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.inspect, { identity: secondChild }, second.authority)).toMatchObject({ ok: false, error: { code: "store_integrity_failed" } });
  });

  it("replays at the bounded ancestry edge and refuses to publish an unreadable successor", async () => {
    const { authority } = await host();
    let parent = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: descriptor() }, authority)).record.identity;
    for (let revision = 2; revision <= 127; revision += 1) {
      parent = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.revise, { parent, descriptor: descriptor(revision) }, authority)).record.identity;
    }
    const edge = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.revise, { parent, descriptor: descriptor(180) }, authority));
    expect(edge.record.identity.revision).toBe(128);
    expect(succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.revise, { parent, descriptor: descriptor(180) }, authority)).replay).toBe("same-input");
    expect(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.revise, { parent: edge.record.identity, descriptor: descriptor(270) }, authority)).toMatchObject({ ok: false, error: { code: "lineage_limit_exceeded" } });
    expect(succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.inspect, { identity: edge.record.identity }, authority)).record.identity.revision).toBe(128);
  }, 60_000);

  it("retains immutable audit bytes on durable tombstone and archive, while blocking later revision", async () => {
    const { authority } = await host();
    const created = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: descriptor() }, authority));
    const removed = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.remove, { identity: created.record.identity }, authority));
    expect(removed.record.target.state).toBe("tombstoned");
    expect(removed.evidence).toMatchObject({ operation: "timeline.checkpoint-storyboard.remove" });
    expect(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.revise, { parent: created.record.identity, descriptor: descriptor(180) }, authority)).toMatchObject({ ok: false, error: { code: "record_tombstoned" } });
    expect((await inspectCheckpointStoryboardStoredRecord(authority, created.record.identity)).storyboard.id).toBe(created.record.identity.id);

    const archived = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.archive, { identity: created.record.identity }, authority));
    expect(archived.record.archive.terminal).toBe(true);
    expect(archived.evidence).toMatchObject({ operation: "timeline.checkpoint-storyboard.archive" });
  });

  it("derives terminal archive state across a revised lineage and rejects further reopening", async () => {
    const { authority } = await host();
    const root = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: descriptor() }, authority)).record.identity;
    const child = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.revise, { parent: root, descriptor: descriptor(180) }, authority)).record.identity;
    expect(succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.archive, { identity: child }, authority)).record.archive.terminal).toBe(true);
    expect(succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.inspect, { identity: root }, authority)).record.archive.terminal).toBe(true);
    expect(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.revise, { parent: child, descriptor: descriptor(270) }, authority)).toMatchObject({ ok: false, error: { code: "lineage_archived" } });
  });

  it("fails archive closed for a deleted signed member entry or a missing non-root immutable member record", async () => {
    const first = await host();
    const root = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: descriptor() }, first.authority)).record.identity;
    const child = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.revise, { parent: root, descriptor: descriptor(180) }, first.authority)).record.identity;
    await rm(join(first.root, ".shellx-motion-c6c-record-store", "members", root.id, "2.json"));
    expect(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.archive, { identity: root }, first.authority)).toMatchObject({ ok: false, error: { code: "store_integrity_failed" } });

    const second = await host();
    const secondRoot = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: descriptor() }, second.authority)).record.identity;
    const secondChild = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.revise, { parent: secondRoot, descriptor: descriptor(180) }, second.authority)).record.identity;
    await rm(join(second.root, ".shellx-motion-c6c-record-store", "records", `${secondChild.id}.json`));
    expect(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.archive, { identity: secondRoot }, second.authority)).toMatchObject({ ok: false, error: { code: "store_integrity_failed" } });
  });

  it("repairs only a same-input child replay whose member head lagged before that child target was published", async () => {
    const { root, authority } = await host();
    const parent = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: descriptor() }, authority)).record.identity;
    const members = join(root, ".shellx-motion-c6c-record-store", "members", parent.id);
    const priorHead = await (await import("node:fs/promises")).readFile(join(members, "head.json"));
    const createdChild = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.revise, { parent, descriptor: descriptor(180) }, authority));
    const child = createdChild.record.identity;
    const childStoryboard = createdChild.record.storyboard as Parameters<typeof createCheckpointStoryboardStoredRecord>[1];
    // Model the exact member-before-head crash: immutable child/member exist, but no child final
    // target and the durable mutable head still names only the root.
    await rm(join(root, ".shellx-motion-c6c-record-store", "targets", `${child.id}.active.json`));
    await writeFile(join(members, "head.json"), priorHead);
    const replay = await createCheckpointStoryboardStoredRecord(authority, childStoryboard, parent);
    expect(replay.replayed).toBe(true);
    expect(replay.record.identity).toEqual(child);

    const finalized = await host();
    const finalizedParent = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: descriptor() }, finalized.authority)).record.identity;
    const finalizedMembers = join(finalized.root, ".shellx-motion-c6c-record-store", "members", finalizedParent.id);
    const finalizedHead = await (await import("node:fs/promises")).readFile(join(finalizedMembers, "head.json"));
    const finalizedCreatedChild = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.revise, { parent: finalizedParent, descriptor: descriptor(180) }, finalized.authority));
    const finalizedChild = finalizedCreatedChild.record.identity;
    const finalizedStoryboard = finalizedCreatedChild.record.storyboard as Parameters<typeof createCheckpointStoryboardStoredRecord>[1];
    await writeFile(join(finalizedMembers, "head.json"), finalizedHead);
    await expect(createCheckpointStoryboardStoredRecord(finalized.authority, finalizedStoryboard, finalizedParent)).rejects.toMatchObject({ code: "store_integrity_failed" });
    expect(finalizedChild.revision).toBe(2);
  });

  it("rejects broad C6A grammar at the single shared B1 static-profile admission", async () => {
    const { authority } = await host();
    const absent = descriptor() as any;
    absent.checkpoints[1].objects[0].state = "absent";
    absent.checkpoints[1].objects[0].properties = [];
    absent.edges[0].lifecycle[0].kind = "remove";
    absent.edges[0].recipeIds = [];
    absent.recipes = [];
    const smooth = descriptor() as any;
    smooth.recipes[1].intent.targets[0].tangentMode = "smooth";
    const behavior = descriptor() as any;
    behavior.recipes[1].intent = { kind: "transform-behavior", targetObjectId: "orb", behavior: { kind: "gravity", velocityX: 0, velocityY: 0, gravityY: 1 } };
    behavior.recipes[1].exactBaseRequirements = [];
    for (const candidate of [absent, smooth, behavior]) {
      expect(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: candidate }, authority)).toMatchObject({ ok: false, error: { code: "checkpoint_storyboard_record_invalid" } });
    }
  });

  it("contains hostile descriptors and refuses changed authority, symlink, tamper, and existing-member contention", async () => {
    const { root, authority } = await host();
    let getterCalls = 0;
    const hostile = { ...descriptor() } as Record<string, unknown>;
    Object.defineProperty(hostile, "recipes", { enumerable: true, get() { getterCalls += 1; return descriptor().recipes; } });
    expect(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: hostile }, authority)).toMatchObject({ ok: false, error: { code: "checkpoint_storyboard_record_invalid" } });
    expect(getterCalls).toBe(0);

    const created = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: descriptor() }, authority));
    const lock = join(root, ".shellx-motion-c6c-record-store", "locks", `${created.record.identity.id}.lock`);
    await mkdir(lock);
    expect(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.inspect, { identity: created.record.identity }, authority)).toMatchObject({ ok: false, error: { code: "store_busy" } });
    await rm(lock, { recursive: true });

    const recordPath = join(root, ".shellx-motion-c6c-record-store", "records", `${created.record.identity.id}.json`);
    await writeFile(recordPath, "{}", "utf8");
    expect(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.inspect, { identity: created.record.identity }, authority)).toMatchObject({ ok: false, error: { code: "store_integrity_failed" } });

    const symlinkRoot = await mkdtemp(join(tmpdir(), "shellx-motion-c6c-link-"));
    roots.push(symlinkRoot);
    const linked = `${symlinkRoot}-link`;
    roots.push(linked);
    await symlink(symlinkRoot, linked);
    await expect(configureCheckpointStoryboardRecordStore({ root: linked, integrityKey: Buffer.alloc(32, 9) })).rejects.toThrow("symlink component");
  });

  it("rejects a tampered active journal and a symlinked selected leaf", async () => {
    const first = await host();
    const created = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: descriptor() }, first.authority));
    const active = join(first.root, ".shellx-motion-c6c-record-store", "targets", `${created.record.identity.id}.active.json`);
    await writeFile(active, "{}", "utf8");
    expect(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.inspect, { identity: created.record.identity }, first.authority)).toMatchObject({ ok: false, error: { code: "store_integrity_failed" } });

    const second = await host();
    const clean = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: descriptor() }, second.authority));
    const leaf = join(second.root, ".shellx-motion-c6c-record-store", "targets", `${clean.record.identity.id}.active.json`);
    await rm(leaf);
    await symlink(join(second.root, ".shellx-motion-c6c-record-store", "records", `${clean.record.identity.id}.json`), leaf);
    expect(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.inspect, { identity: clean.record.identity }, second.authority)).toMatchObject({ ok: false, error: { code: "store_integrity_failed" } });
  });

  it("fails closed instead of repairing an active, tombstone, or archive evidence reference", async () => {
    const active = await host();
    const activeRecord = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: descriptor() }, active.authority));
    await rm(receiptPath(active.root, activeRecord.evidence!.id));
    expect(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.inspect, { identity: activeRecord.record.identity }, active.authority)).toMatchObject({ ok: false, error: { code: "store_integrity_failed" } });
    expect(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: descriptor() }, active.authority)).toMatchObject({ ok: false, error: { code: "store_integrity_failed" } });

    const tombstoned = await host();
    const tombstoneRecord = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: descriptor() }, tombstoned.authority));
    const removal = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.remove, { identity: tombstoneRecord.record.identity }, tombstoned.authority));
    await rm(receiptPath(tombstoned.root, removal.evidence!.id));
    expect(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.inspect, { identity: tombstoneRecord.record.identity }, tombstoned.authority)).toMatchObject({ ok: false, error: { code: "store_integrity_failed" } });
    expect(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.remove, { identity: tombstoneRecord.record.identity }, tombstoned.authority)).toMatchObject({ ok: false, error: { code: "store_integrity_failed" } });

    const archived = await host();
    const archiveRecord = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: descriptor() }, archived.authority));
    const archive = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.archive, { identity: archiveRecord.record.identity }, archived.authority));
    await rm(receiptPath(archived.root, archive.evidence!.id));
    expect(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.inspect, { identity: archiveRecord.record.identity }, archived.authority)).toMatchObject({ ok: false, error: { code: "store_integrity_failed" } });
    expect(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.archive, { identity: archiveRecord.record.identity }, archived.authority)).toMatchObject({ ok: false, error: { code: "store_integrity_failed" } });
  });

  it("bounds deeply nested tampered JSON before canonical MAC validation", async () => {
    const { root, authority } = await host();
    const created = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: descriptor() }, authority));
    let deep: unknown = null;
    for (let index = 0; index < 80; index += 1) deep = { nested: deep };
    await writeFile(join(root, ".shellx-motion-c6c-record-store", "records", `${created.record.identity.id}.json`), JSON.stringify(deep), { mode: 0o600 });
    expect(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.inspect, { identity: created.record.identity }, authority)).toMatchObject({ ok: false, error: { code: "store_integrity_failed" } });
  });

  it("refuses concurrent lineage writers and recovers only quiescent private staging", async () => {
    const { root, authority } = await host();
    const created = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: descriptor() }, authority));
    const locks = join(root, ".shellx-motion-c6c-record-store", "locks");
    const lock = join(locks, `${created.record.identity.id}.lock`);
    await mkdir(lock, { mode: 0o700 });
    const [revise, remove] = await Promise.all([
      call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.revise, { parent: created.record.identity, descriptor: descriptor(180) }, authority),
      call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.remove, { identity: created.record.identity }, authority),
    ]);
    expect(revise).toMatchObject({ ok: false, error: { code: "store_busy" } });
    expect(remove).toMatchObject({ ok: false, error: { code: "store_busy" } });
    await expect(recoverCheckpointStoryboardRecordStoreForQuiescentHost(authority, issueCheckpointStoryboardRecordStoreQuiescentAdmission(authority))).resolves.toEqual({ removedTemporaryFiles: 0, removedStaleLocks: 1 });
    const staged = join(root, ".shellx-motion-c6c-record-store", "targets", `${created.record.identity.id}.active.json.${"a".repeat(8)}-${"b".repeat(4)}-${"c".repeat(4)}-${"d".repeat(4)}-${"e".repeat(12)}.tmp`);
    await writeFile(staged, "staged", { mode: 0o600 });
    await expect(recoverCheckpointStoryboardRecordStoreForQuiescentHost(authority, issueCheckpointStoryboardRecordStoreQuiescentAdmission(authority))).resolves.toEqual({ removedTemporaryFiles: 1, removedStaleLocks: 0 });
  });

  it("recovers a selected hard-link staging pair and leaves its final member readable", async () => {
    const { root, authority } = await host();
    const created = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: descriptor() }, authority));
    const active = join(root, ".shellx-motion-c6c-record-store", "targets", `${created.record.identity.id}.active.json`);
    const staged = `${active}.${"a".repeat(8)}-${"b".repeat(4)}-${"c".repeat(4)}-${"d".repeat(4)}-${"e".repeat(12)}.tmp`;
    await link(active, staged);
    await expect(recoverCheckpointStoryboardRecordStoreForQuiescentHost(authority, issueCheckpointStoryboardRecordStoreQuiescentAdmission(authority))).resolves.toEqual({ removedTemporaryFiles: 1, removedStaleLocks: 0 });
    expect(succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.inspect, { identity: created.record.identity }, authority)).record.target.state).toBe("active");
  });

  it("streams quiescent recovery across more than 512 independent private member roots", async () => {
    const { root, authority } = await host();
    const members = join(root, ".shellx-motion-c6c-record-store", "members");
    for (let index = 0; index < 513; index += 1) {
      await mkdir(join(members, `checkpoint_storyboard_${index.toString(16).padStart(32, "0")}`));
    }
    const admission = issueCheckpointStoryboardRecordStoreQuiescentAdmission(authority);
    await expect(recoverCheckpointStoryboardRecordStoreForQuiescentHost(authority, admission)).resolves.toMatchObject({ removedTemporaryFiles: 0, removedStaleLocks: 0 });
  });

  it("streams high-cardinality grammar-valid locks and B1a binding staging without readdir arrays", async () => {
    const { root, authority } = await host();
    const locks = join(root, ".shellx-motion-c6c-record-store", "locks");
    const bindings = join(root, ".shellx-motion-c6c-record-store", "bindings");
    for (let index = 0; index < 513; index += 1) {
      const id = `checkpoint_storyboard_${index.toString(16).padStart(32, "0")}`;
      const uuid = `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
      await mkdir(join(locks, `${id}.lock`), { mode: 0o700 });
      await writeFile(join(bindings, `${id}.state.json.${uuid}.tmp`), "private stage", { mode: 0o600 });
    }
    await expect(recoverCheckpointStoryboardRecordStoreForQuiescentHost(authority, issueCheckpointStoryboardRecordStoreQuiescentAdmission(authority))).resolves.toEqual({ removedTemporaryFiles: 513, removedStaleLocks: 513 });
  });

  it("archives one complete root without treating an unrelated pre-target record as its failure", async () => {
    const { root, authority } = await host();
    const interrupted = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: descriptor() }, authority)).record.identity;
    await rm(join(root, ".shellx-motion-c6c-record-store", "targets", `${interrupted.id}.active.json`));
    const complete = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: descriptor(180) }, authority)).record.identity;
    expect(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.archive, { identity: complete }, authority)).toMatchObject({ ok: true, result: { record: { archive: { terminal: true } } } });
  });

  it("allows an unrelated exact private writer staging file during archive without treating it as final state", async () => {
    const { root, authority } = await host();
    const record = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: descriptor() }, authority)).record.identity;
    const uuid = `${"a".repeat(8)}-${"b".repeat(4)}-${"c".repeat(4)}-${"d".repeat(4)}-${"e".repeat(12)}`;
    const staged = join(root, ".shellx-motion-c6c-record-store", "targets", `${record.id}.active.json.${uuid}.tmp`);
    await writeFile(staged, "recoverable-private-stage", { mode: 0o600 });
    expect(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.archive, { identity: record }, authority)).toMatchObject({ ok: true, result: { record: { archive: { terminal: true } } } });
    await expect(writeFile(staged, "still-staged", { flag: "a" })).resolves.toBeUndefined();

    const invalid = await host();
    const invalidRecord = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: descriptor() }, invalid.authority)).record.identity;
    await writeFile(join(invalid.root, ".shellx-motion-c6c-record-store", "targets", `orphan.${uuid}.tmp`), "not a writer-selected final staging name", { mode: 0o600 });
    expect(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.archive, { identity: invalidRecord }, invalid.authority)).toMatchObject({ ok: false, error: { code: "store_integrity_failed" } });
  });

  it("types lstat/open replacement and post-link directory-sync uncertainty without rollback", async () => {
    const replacement = await host();
    const created = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: descriptor() }, replacement.authority));
    const active = join(replacement.root, ".shellx-motion-c6c-record-store", "targets", `${created.record.identity.id}.active.json`);
    const alternate = `${active}.replacement`;
    await writeFile(alternate, await (await import("node:fs/promises")).readFile(active), { mode: 0o600 });
    fsFault.replaceTarget = resolve(active); fsFault.replacement = alternate; fsFault.replaceAtOpen = true;
    expect(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.inspect, { identity: created.record.identity }, replacement.authority)).toMatchObject({ ok: false, error: { code: "store_integrity_failed" } });

    const uncertain = await host();
    fsFault.publicationDirectory = resolve(join(uncertain.root, ".shellx-motion-c6c-record-store", "targets")); fsFault.linked = false; fsFault.failDirectorySync = true;
    expect(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: descriptor() }, uncertain.authority)).toMatchObject({ ok: false, error: { code: "record_commit_uncertain" } });
    // The selected hard-link pair remains until quiescent recovery can sync the final directory;
    // a second injected directory-sync fault must not report cleanup success or retry the command.
    fsFault.linked = true; fsFault.failDirectorySync = true;
    await expect(recoverCheckpointStoryboardRecordStoreForQuiescentHost(uncertain.authority, issueCheckpointStoryboardRecordStoreQuiescentAdmission(uncertain.authority))).rejects.toMatchObject({ code: "record_commit_uncertain" });
    expect(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: descriptor() }, uncertain.authority)).toMatchObject({ ok: false, error: { code: "store_integrity_failed" } });
    await expect(recoverCheckpointStoryboardRecordStoreForQuiescentHost(uncertain.authority, issueCheckpointStoryboardRecordStoreQuiescentAdmission(uncertain.authority))).resolves.toEqual({ removedTemporaryFiles: 1, removedStaleLocks: 0 });
    expect(succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: descriptor() }, uncertain.authority)).record.target.state).toBe("active");
    const linkUncertain = await host();
    fsFault.publicationDirectory = resolve(join(linkUncertain.root, ".shellx-motion-c6c-record-store", "targets")); fsFault.failLink = true;
    expect(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: descriptor() }, linkUncertain.authority)).toMatchObject({ ok: false, error: { code: "record_commit_uncertain" } });
    await expect(recoverCheckpointStoryboardRecordStoreForQuiescentHost(linkUncertain.authority, issueCheckpointStoryboardRecordStoreQuiescentAdmission(linkUncertain.authority))).resolves.toEqual({ removedTemporaryFiles: 1, removedStaleLocks: 0 });
    expect(succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: descriptor() }, linkUncertain.authority)).record.target.state).toBe("active");

    const closeUncertain = await host();
    fsFault.failTempClose = true;
    expect(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: descriptor() }, closeUncertain.authority)).toMatchObject({ ok: false, error: { code: "record_commit_uncertain" } });
    await expect(recoverCheckpointStoryboardRecordStoreForQuiescentHost(closeUncertain.authority, issueCheckpointStoryboardRecordStoreQuiescentAdmission(closeUncertain.authority))).resolves.toEqual({ removedTemporaryFiles: 1, removedStaleLocks: 0 });
    expect(succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: descriptor() }, closeUncertain.authority)).record.target.state).toBe("active");
  });

  it("serializes competing revisions and revision/removal without exposing partial derived state", async () => {
    const { authority } = await host();
    const root = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: descriptor() }, authority)).record.identity;
    const revisions = await Promise.all([
      call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.revise, { parent: root, descriptor: descriptor(180) }, authority),
      call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.revise, { parent: root, descriptor: descriptor(270) }, authority),
    ]);
    for (const result of revisions) {
      expect(result).not.toBeNull();
      if (result && !result.ok) expect(result.error.code).toBe("store_busy");
    }

    const second = await host();
    const parent = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: descriptor() }, second.authority)).record.identity;
    const mixed = await Promise.all([
      call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.revise, { parent, descriptor: descriptor(180) }, second.authority),
      call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.remove, { identity: parent }, second.authority),
    ]);
    for (const result of mixed) {
      expect(result).not.toBeNull();
      if (result && !result.ok) expect(["store_busy", "record_tombstoned"]).toContain(result.error.code);
    }
  });

  it("refuses copied/moved store authority and group-writable child authority", async () => {
    const { root, authority } = await host();
    const created = succeeded(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create, { descriptor: descriptor() }, authority));
    const store = join(root, ".shellx-motion-c6c-record-store");
    await chmod(join(store, "records"), 0o770);
    expect(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.inspect, { identity: created.record.identity }, authority)).toMatchObject({ ok: false, error: { code: "store_authority_refused" } });
    await chmod(join(store, "records"), 0o700);

    const copyRoot = await mkdtemp(join(tmpdir(), "shellx-motion-c6c-copy-"));
    roots.push(copyRoot);
    await cp(store, join(copyRoot, ".shellx-motion-c6c-record-store"), { recursive: true });
    const copied = await configureCheckpointStoryboardRecordStore({ root: copyRoot, integrityKey: Buffer.alloc(32, 7) });
    expect(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.inspect, { identity: created.record.identity }, copied)).toMatchObject({ ok: false, error: { code: "store_integrity_failed" } });

    const moved = `${root}-moved`;
    roots.push(moved);
    await rename(root, moved);
    expect(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.inspect, { identity: created.record.identity }, authority)).toMatchObject({ ok: false, error: { code: "store_authority_refused" } });
    const movedAuthority = await configureCheckpointStoryboardRecordStore({ root: moved, integrityKey: Buffer.alloc(32, 7) });
    expect(await call(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.inspect, { identity: created.record.identity }, movedAuthority)).toMatchObject({ ok: false, error: { code: "store_integrity_failed" } });
  });

});
