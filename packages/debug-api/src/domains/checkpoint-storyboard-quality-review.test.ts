import { afterEach, describe, expect, it } from "vitest";
import { createHash, createHmac } from "node:crypto";
import { lstat, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { canonicalJson } from "@shellx-motion/core";
import { dispatchDebugCommand } from "../index.js";
import { configureCheckpointStoryboardQualityReviewAuthority } from "./checkpoint-storyboard-quality-review-authority.js";
import { detachCheckpointStoryboardStoredRecord } from "./checkpoint-storyboard-materialization.js";
import { setCheckpointStoryboardQualityReviewFaultHooksForTest } from "./checkpoint-storyboard-quality-review.js";
import { cleanupCreativeReviewFixtures, preparedCreativeReview, snapshotDirectory } from "./checkpoint-storyboard-creative-review.test-support.js";
import { CHECKPOINT_STORYBOARD_RECORD_COMMANDS } from "./checkpoint-storyboard-record-lifecycle.js";

afterEach(async () => await cleanupCreativeReviewFixtures());
const witnessHandle = (label: string) => `checkpoint_storyboard_endpoint_witness_handle_${createHash("sha256").update(label).digest("hex").slice(0, 32)}`;
type Prepared = Awaited<ReturnType<typeof preparedCreativeReview>>;
const inspect = async (prepared: Prepared) => await dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.inspect, { identity: prepared.created.record.identity }, { tier: "read_motion", checkpointStoryboardRecordStore: prepared.value.store });
const directoryOf = (prepared: Prepared) => join(prepared.value.root, ".shellx-motion-c6c-record-store", "quality-reviews", prepared.created.record.identity.id);

describe.skipIf(process.platform !== "linux")("C6C B1e authenticated preview quality receipts", () => {
  it("retains a passed interior receipt with opaque output only and no final acceptance", async () => {
    const prepared = await preparedCreativeReview({ validPng: true, outcome: "changes_requested" });
    await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.creativeReviewBind, prepared.args, prepared.context)).resolves.toMatchObject({ ok: true });
    const authority = qualityAuthority(prepared);
    const args = { identity: prepared.created.record.identity, preview: prepared.args.preview, review: { kind: "interior", creativeReviewHandle: prepared.args.creativeReviewHandle } };
    const context = { tier: "write_local" as const, checkpointStoryboardRecordStore: prepared.value.store, checkpointStoryboardQualityReviewAuthority: authority };
    await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.previewQualityReview, args, context)).resolves.toMatchObject({ ok: true, result: { verdict: "passed", finalAcceptance: "unavailable", qualityReceiptHandle: expect.stringMatching(/^checkpoint_storyboard_preview_quality_receipt_[a-f0-9]{32}$/u) } });
    const replayed = await dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.previewQualityReview, args, context);
    expect(replayed).toMatchObject({ ok: true, result: { replay: "same-input" } });
    const stored = await qualityFile(prepared);
    for (const secret of [prepared.handles.previewHandle, prepared.handles.receiptHandle, prepared.args.creativeReviewHandle, "creative-review-roster-png"]) expect(stored).not.toContain(secret);
    expect(stored).toContain('"finalAcceptance":"unavailable"');
    expect(stored).not.toContain("finalMedia");
    await detachCheckpointStoryboardStoredRecord(prepared.value.materialization, prepared.created.record.identity);
    await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.remove, { identity: prepared.created.record.identity }, { tier: "write_local", checkpointStoryboardRecordStore: prepared.value.store })).resolves.toMatchObject({ ok: true });
  });

  it("retains a failed fixed-PNG receipt and refuses any final acceptance", async () => {
    const prepared = await preparedCreativeReview();
    await dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.creativeReviewBind, prepared.args, prepared.context);
    const authority = qualityAuthority(prepared);
    const args = { identity: prepared.created.record.identity, preview: prepared.args.preview, review: { kind: "interior", creativeReviewHandle: prepared.args.creativeReviewHandle } };
    const result = await dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.previewQualityReview, args, { tier: "write_local", checkpointStoryboardRecordStore: prepared.value.store, checkpointStoryboardQualityReviewAuthority: authority });
    expect(result).toMatchObject({ ok: false, error: { code: "quality_check_failed", detail: { verdict: "failed", finalAcceptance: "unavailable", qualityReceiptHandle: expect.stringMatching(/^checkpoint_storyboard_preview_quality_receipt_[a-f0-9]{32}$/u) } } });
    expect(await qualityFile(prepared)).toContain('"failure":"invalid_png"');
  });

  it("makes inspect fail closed and read-only for pending, missing, tampered, symlinked, or residual B1e evidence", async () => {
    for (const damage of ["pending", "missing", "tampered", "symlinked", "residue"] as const) {
      const prepared = await preparedCreativeReview();
      await dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.creativeReviewBind, prepared.args, prepared.context);
      const authority = qualityAuthority(prepared), args = { identity: prepared.created.record.identity, preview: prepared.args.preview, review: { kind: "interior" as const, creativeReviewHandle: prepared.args.creativeReviewHandle } };
      if (damage === "pending") { setCheckpointStoryboardQualityReviewFaultHooksForTest(authority, { afterIntent: () => { throw new Error("retained pending intent"); } }); await dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.previewQualityReview, args, qualityContext(prepared, authority)); setCheckpointStoryboardQualityReviewFaultHooksForTest(authority, undefined); }
      else {
        await dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.previewQualityReview, args, qualityContext(prepared, authority));
        const receipt = join(directoryOf(prepared), `${prepared.created.record.identity.id}.quality-review.json`);
        if (damage === "missing") await rm(receipt);
        else if (damage === "tampered") await writeFile(receipt, "{}\n", { mode: 0o600 });
        else if (damage === "symlinked") { await rm(receipt); await symlink(`${prepared.created.record.identity.id}.quality-review.intent.json`, receipt); }
        else await writeFile(join(directoryOf(prepared), "unrecognized-residue.json"), "{}\n", { mode: 0o600 });
      }
      const before = await snapshotDirectory(directoryOf(prepared));
      await expect(inspect(prepared)).resolves.toMatchObject({ ok: false, error: { code: "store_integrity_failed" } });
      await expect(snapshotDirectory(directoryOf(prepared))).resolves.toBe(before);
    }
  }, 60_000);

  it("requires a host-only exact-D endpoint witness adjacent to B1c's end-exclusive review", async () => {
    const prepared = await preparedCreativeReview();
    await dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.creativeReviewBind, prepared.args, prepared.context);
    const terminal = await dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.preview, { identity: prepared.created.record.identity, target: { kind: "time", atMs: 1000 } }, { tier: "render_motion", checkpointStoryboardRecordStore: prepared.value.store, checkpointStoryboardPreviewAuthority: prepared.previewAuthority });
    if (!terminal.ok) throw new Error(JSON.stringify(terminal));
    const terminalResult = terminal.result as { previewHandle: string; receiptHandle: string };
    const handles = { previewHandle: terminalResult.previewHandle, receiptHandle: terminalResult.receiptHandle };
    const handle = witnessHandle(prepared.created.record.identity.id);
    const stale = qualityAuthority(prepared, new Map([[handle, { record: { identity: prepared.created.record.identity, root: prepared.created.record.identity }, creativeReviewHandle: prepared.args.creativeReviewHandle, terminalPreview: handles, endpoint: { atUs: 999_999 } }]]));
    await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.previewQualityReview, { identity: prepared.created.record.identity, preview: handles, review: { kind: "terminal-endpoint", endpointWitnessHandle: handle } }, { tier: "write_local", checkpointStoryboardRecordStore: prepared.value.store, checkpointStoryboardQualityReviewAuthority: stale })).resolves.toMatchObject({ ok: false, error: { code: "quality_review_evidence_refused" } });
    const authority = qualityAuthority(prepared, new Map([[handle, { record: { identity: prepared.created.record.identity, root: prepared.created.record.identity }, creativeReviewHandle: prepared.args.creativeReviewHandle, terminalPreview: handles, endpoint: { atUs: 1_000_000 } }]]));
    const result = await dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.previewQualityReview, { identity: prepared.created.record.identity, preview: handles, review: { kind: "terminal-endpoint", endpointWitnessHandle: handle } }, { tier: "write_local", checkpointStoryboardRecordStore: prepared.value.store, checkpointStoryboardQualityReviewAuthority: authority });
    expect(result).toMatchObject({ ok: false, error: { code: "quality_check_failed" } });
    const stored = await qualityFile(prepared);
    expect(stored).toContain('"relation":"adjacent-end-exclusive"');
    expect(stored).toContain('"visibleFinalState":false');
    expect(stored).toContain('"heldLayerContent":false');
    expect(stored).toContain('"humanPixelReview":false');
    expect(stored).toContain('"finalMedia":false');
    expect(stored).toContain('"selectedShotEndUs":1000000');
    expect(stored).not.toContain(handle);
    await expect(inspect(prepared)).resolves.toMatchObject({ ok: true });
    await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.previewQualityReview, { identity: prepared.created.record.identity, preview: prepared.args.preview, review: { kind: "interior", creativeReviewHandle: prepared.args.creativeReviewHandle } }, { tier: "write_local", checkpointStoryboardRecordStore: prepared.value.store, checkpointStoryboardQualityReviewAuthority: authority })).resolves.toMatchObject({ ok: false, error: { code: "quality_review_binding_conflict" } });
    await detachCheckpointStoryboardStoredRecord(prepared.value.materialization, prepared.created.record.identity);
    await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.remove, { identity: prepared.created.record.identity }, { tier: "write_local", checkpointStoryboardRecordStore: prepared.value.store })).resolves.toMatchObject({ ok: true });
    await rewriteTerminalEndpointFactsForTest(prepared, 1_000_000, 999_999);
    await expect(inspect(prepared)).resolves.toMatchObject({ ok: false, error: { code: "store_integrity_failed" } });
    await rewriteTerminalEndpointFactsForTest(prepared, 999_999, 999_999);
    await expect(inspect(prepared)).resolves.toMatchObject({ ok: false, error: { code: "store_integrity_failed" } });
  });

  it("recovers an interrupted intent only for the identical immutable candidate", async () => {
    const prepared = await preparedCreativeReview();
    await dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.creativeReviewBind, prepared.args, prepared.context);
    const authority = qualityAuthority(prepared);
    const args = { identity: prepared.created.record.identity, preview: prepared.args.preview, review: { kind: "interior", creativeReviewHandle: prepared.args.creativeReviewHandle } };
    setCheckpointStoryboardQualityReviewFaultHooksForTest(authority, { afterIntent: () => { throw new Error("interrupted after intent"); } });
    await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.previewQualityReview, args, { tier: "write_local", checkpointStoryboardRecordStore: prepared.value.store, checkpointStoryboardQualityReviewAuthority: authority })).resolves.toMatchObject({ ok: false });
    setCheckpointStoryboardQualityReviewFaultHooksForTest(authority, undefined);
    await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.previewQualityReview, args, { tier: "write_local", checkpointStoryboardRecordStore: prepared.value.store, checkpointStoryboardQualityReviewAuthority: authority })).resolves.toMatchObject({ ok: false, error: { code: "quality_check_failed" } });
  });
});

function qualityAuthority(prepared: Prepared, endpointWitnessRegistry = new Map()) {
  return configureCheckpointStoryboardQualityReviewAuthority({ recordStore: prepared.value.store, materializationAuthority: prepared.value.materialization, previewAuthority: prepared.previewAuthority, creativeReviewAuthority: prepared.creativeReviewAuthority, endpointWitnessRegistry: endpointWitnessRegistry as never });
}
function qualityContext(prepared: Prepared, authority: ReturnType<typeof qualityAuthority>) { return { tier: "write_local" as const, checkpointStoryboardRecordStore: prepared.value.store, checkpointStoryboardQualityReviewAuthority: authority }; }
async function qualityFile(prepared: Prepared): Promise<string> {
  return await readFile(join(directoryOf(prepared), `${prepared.created.record.identity.id}.quality-review.json`), "utf8");
}
async function rewriteTerminalEndpointFactsForTest(prepared: Prepared, endpointAtUs: number, selectedShotEndUs: number): Promise<void> {
  const receiptPath = join(directoryOf(prepared), `${prepared.created.record.identity.id}.quality-review.json`), intentPath = join(directoryOf(prepared), `${prepared.created.record.identity.id}.quality-review.intent.json`);
  const current = JSON.parse(await readFile(receiptPath, "utf8")) as { payload: Record<string, unknown> }, { id: _receiptId, sha256: _receiptSha256, ...receiptBody } = current.payload;
  const receipt = signedIdentity({ ...receiptBody, review: { ...(receiptBody.review as Record<string, unknown>), endpointAtUs, selectedShotEndUs } }, "checkpoint_storyboard_preview_quality_review_");
  const intentCurrent = JSON.parse(await readFile(intentPath, "utf8")) as { payload: Record<string, unknown> }, { id: _intentId, sha256: _intentSha256, receipt: _intentReceipt, ...intentBody } = intentCurrent.payload;
  const intent = signedIdentity({ ...intentBody, receipt: { id: receipt.id, sha256: receipt.sha256 } }, "checkpoint_storyboard_quality_review_intent_");
  await Promise.all([writeSignedQualityTestFile(prepared, receiptPath, receipt), writeSignedQualityTestFile(prepared, intentPath, intent)]);
}
function signedIdentity(payload: Record<string, unknown>, prefix: string) {
  const sha256 = createHash("sha256").update(canonicalJson(payload)).digest("hex");
  return { ...payload, id: `${prefix}${sha256.slice(0, 32)}`, sha256 };
}
async function writeSignedQualityTestFile(prepared: Prepared, path: string, payload: Record<string, unknown>): Promise<void> {
  const store = await lstat(join(prepared.value.root, ".shellx-motion-c6c-record-store"));
  const integrity = createHmac("sha256", Buffer.alloc(32, 9)).update(`${resolve(prepared.value.root)}\0${store.dev}:${store.ino}`).update("\0").update(canonicalJson(payload)).digest("hex");
  await writeFile(path, `${canonicalJson({ payload, integrity })}\n`, { mode: 0o600 });
}
