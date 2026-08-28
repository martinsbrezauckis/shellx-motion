import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { crc32 } from "@shellx-motion/core";
import { checkedAuthority } from "./checkpoint-storyboard-record-store-authority.js";
import { lineageRetainedTracePreviewsDirectory } from "./checkpoint-storyboard-retained-trace-preview-store.js";
import { configureCheckpointStoryboardRecordStore, issueCheckpointStoryboardRecordStoreQuiescentAdmission, recoverCheckpointStoryboardRecordStoreForQuiescentHost } from "./checkpoint-storyboard-record-store.js";
import { archiveCheckpointStoryboardStoredLineage, createCheckpointStoryboardStoredRecord, tombstoneCheckpointStoryboardStoredRecord } from "./checkpoint-storyboard-record-store.js";
import { writeExclusiveSignedFile } from "./checkpoint-storyboard-record-store-signed-files.js";
import {
  assertLineageHasNoUnsettledCheckpointStoryboardRetainedTracePreviews,
  publishCheckpointStoryboardRetainedTracePreviewPreparing,
  reopenCompleteCheckpointStoryboardRetainedTracePreviewPair,
  replaceCheckpointStoryboardRetainedTracePreviewState,
  retainedTracePreviewHandles,
  type CheckpointStoryboardRetainedTracePreviewState,
} from "./checkpoint-storyboard-retained-trace-preview-state.js";
import { createCheckpointStoryboard, createTransitionRecipe } from "@shellx-motion/core/internal/checkpoint-storyboard-scalar-spatial-materializer";

const roots: string[] = [];
const CAPS = { maxSamples: 64, maxVertices: 64, maxWorkUnits: 16_384, maxBytes: 128 * 1024 };
const PNG_1X1 = exactPng1x1();

afterEach(async () => { await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))); });

function retainedTraceStoryboard() {
  const durationUs = 4_000, sampleIntervalUs = 1_000;
  const recipe = createTransitionRecipe({
    recipeId: "retained-line", seed: 2, exactBaseRequirements: [],
    intent: {
      kind: "parametric-trace", outputObjectId: "trace-anchor", trace: {
        schema: "shellx-motion/private-parametric-trace@1", clip: { durationUs, sampleIntervalUs },
        drawers: [{
          id: "line", driver: { kind: "parametric-graph", graph: { nodes: [
            { id: "time", kind: "time-us" }, { id: "scale", kind: "constant", value: 0.001 }, { id: "x", kind: "multiply", left: "time", right: "scale" }, { id: "zero", kind: "constant", value: 0 },
          ], output: { x: "x", y: "zero", z: "zero" } } }, retention: { kind: "full-clip", maxSamples: 5 },
          output: { mode: "line", width: { source: "constant", from: 2, to: 2 }, colour: { source: "constant", from: 0.5, to: 0.5 }, opacity: { source: "constant", from: 0.75, to: 0.75 }, speedLimit: 100 },
        }], caps: { perDrawer: { ...CAPS }, aggregate: { ...CAPS } },
      },
    },
  });
  return createCheckpointStoryboard({
    seed: 1, capabilityRequirements: ["renderer.gpu"],
    objectCatalog: [{ objectId: "trace-anchor", rootShapeKind: "rect", propertyMask: ["opacity"] }],
    checkpoints: [
      { id: "start", atUs: 0, objects: [{ objectId: "trace-anchor", state: "present", properties: [{ property: "opacity", value: 0.75 }] }] },
      { id: "finish", atUs: durationUs, objects: [{ objectId: "trace-anchor", state: "present", properties: [{ property: "opacity", value: 0.75 }] }] },
    ],
    edges: [{ id: "start-finish", fromCheckpointId: "start", toCheckpointId: "finish", lifecycle: [{ kind: "preserve", objectId: "trace-anchor" }], recipeIds: [recipe.recipeId] }], recipes: [recipe],
  });
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-c6c-b7-preview-state-"));
  roots.push(root);
  const authority = await configureCheckpointStoryboardRecordStore({ root, integrityKey: Buffer.alloc(32, 17) });
  const created = await createCheckpointStoryboardStoredRecord(authority, retainedTraceStoryboard());
  return { authority, facts: checkedAuthority(authority), created };
}
function sha256(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function exactPng1x1(): Buffer {
  const header = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
  const chunk = (type: string, data: Buffer) => { const value = Buffer.alloc(12 + data.byteLength); value.writeUInt32BE(data.byteLength, 0); value.write(type, 4, 4, "ascii"); data.copy(value, 8); value.writeUInt32BE(crc32(value.subarray(4, 8 + data.byteLength)), 8 + data.byteLength); return value; };
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.alloc(5))), chunk("IEND", Buffer.alloc(0))]);
}
function stateFor(created: Awaited<ReturnType<typeof createCheckpointStoryboardStoredRecord>>, suffix: string): CheckpointStoryboardRetainedTracePreviewState {
  return {
    schema: "shellx-motion/private-checkpoint-storyboard-retained-trace-preview-state@1",
    id: `checkpoint_storyboard_retained_trace_preview_${suffix.repeat(32)}`,
    identity: created.record.identity,
    root: created.record.lineage.root,
    binding: { id: `checkpoint_storyboard_retained_trace_resolution_binding_${"b".repeat(32)}`, sha256: "c".repeat(64) },
    atUs: 2_000,
    runtimeEvidence: "source-test",
    phase: "preparing",
  };
}
async function writeState(facts: Awaited<ReturnType<typeof fixture>>["facts"], state: CheckpointStoryboardRetainedTracePreviewState) {
  const directory = await lineageRetainedTracePreviewsDirectory(facts, state.root.id);
  await writeExclusiveSignedFile(join(directory.path, `${state.id}.state.json`), state, facts, 16 * 1024);
  return directory;
}

describe("C6C B7 retained-trace preview private state", () => {
  it("requires a currently active exact B7 binding before a renderer may publish preparing state", async () => {
    const { facts, created } = await fixture();
    await expect(publishCheckpointStoryboardRetainedTracePreviewPreparing(facts, stateFor(created, "a"))).rejects.toMatchObject({ code: "preview_binding_not_active" });
  });

  it("reopens a receipt-first PNG pair without interpreting renderer receipt bytes and mints opaque handles", async () => {
    const { facts, created } = await fixture();
    let state = stateFor(created, "d"), directory = await writeState(facts, state);
    const receipt = Buffer.from("renderer receipt bytes are opaque to retained-trace preview state\n", "utf8");
    await writeFile(join(directory.path, `${state.id}.receipt.json`), receipt, { mode: 0o600 });
    state = await replaceCheckpointStoryboardRetainedTracePreviewState(facts, state, "receipt-published", { receipt: { sha256: sha256(receipt), byteLength: receipt.byteLength } });
    await writeFile(join(directory.path, `${state.id}.png`), PNG_1X1, { mode: 0o600 });
    state = await replaceCheckpointStoryboardRetainedTracePreviewState(facts, state, "complete", { png: { sha256: sha256(PNG_1X1), byteLength: PNG_1X1.byteLength, width: 1, height: 1 } });

    await expect(assertLineageHasNoUnsettledCheckpointStoryboardRetainedTracePreviews(facts, created.record.lineage.root)).resolves.toBe(1);
    const pair = await reopenCompleteCheckpointStoryboardRetainedTracePreviewPair(facts, directory.path, state, new Set([`${state.id}.receipt.json`, `${state.id}.png`]));
    expect(pair.handles).toEqual(retainedTracePreviewHandles(facts, state));
    expect(pair.handles.preview).toMatch(/^checkpoint_storyboard_retained_trace_preview_[a-f0-9]{32}$/u);
    expect(pair.handles.receipt).toMatch(/^checkpoint_storyboard_retained_trace_preview_receipt_[a-f0-9]{32}$/u);
  });

  it("only quiescent recovery may abandon a preparing state with no receipt, PNG, or reservation", async () => {
    const { authority, facts, created } = await fixture();
    const state = stateFor(created, "e");
    const directory = await writeState(facts, state);
    await recoverCheckpointStoryboardRecordStoreForQuiescentHost(authority, issueCheckpointStoryboardRecordStoreQuiescentAdmission(authority));
    await expect(assertLineageHasNoUnsettledCheckpointStoryboardRetainedTracePreviews(facts, created.record.lineage.root)).resolves.toBe(1);
    const recovered = JSON.parse(await readFile(join(directory.path, `${state.id}.state.json`), "utf8"));
    expect(recovered.payload.phase).toBe("abandoned");
  });

  it("blocks lifecycle removal/archive on an unsettled B7 preview and recovers only grammar-valid state staging", async () => {
    const { authority, facts, created } = await fixture();
    const state = stateFor(created, "f"), directory = await writeState(facts, state);
    await expect(tombstoneCheckpointStoryboardStoredRecord(authority, created.record.identity)).rejects.toMatchObject({ code: "preview_publication_uncertain" });
    await expect(archiveCheckpointStoryboardStoredLineage(authority, created.record.identity)).rejects.toMatchObject({ code: "preview_publication_uncertain" });

    const stage = join(directory.path, `${state.id}.state.json.aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.tmp`);
    await writeFile(stage, "unselected preview state staging", { mode: 0o600 });
    const recovered = await recoverCheckpointStoryboardRecordStoreForQuiescentHost(authority, issueCheckpointStoryboardRecordStoreQuiescentAdmission(authority));
    expect(recovered.removedTemporaryFiles).toBe(1);
  });
});
