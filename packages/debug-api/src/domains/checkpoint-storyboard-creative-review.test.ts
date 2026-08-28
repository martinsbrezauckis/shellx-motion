import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dispatchDebugCommand } from "../index.js";
import { configureCheckpointStoryboardCreativeReviewAuthority } from "./checkpoint-storyboard-creative-review-authority.js";
import { setCheckpointStoryboardCreativeReviewFaultHooksForTest } from "./checkpoint-storyboard-creative-review.js";
import { detachCheckpointStoryboardStoredRecord } from "./checkpoint-storyboard-materialization.js";
import { CHECKPOINT_STORYBOARD_RECORD_COMMANDS } from "./checkpoint-storyboard-record-lifecycle.js";
import { archiveCheckpointStoryboardStoredLineage, issueCheckpointStoryboardRecordStoreQuiescentAdmission, recoverCheckpointStoryboardRecordStoreForQuiescentHost } from "./checkpoint-storyboard-record-store.js";
import { cleanupCreativeReviewFixtures, hostCreativeAuthentication, opaqueCreativeReviewHandle, preparedCreativeReview, seedCreativeReviewCapacity, snapshotDirectory } from "./checkpoint-storyboard-creative-review.test-support.js";

afterEach(async () => await cleanupCreativeReviewFixtures());
const bind = async (prepared: Awaited<ReturnType<typeof preparedCreativeReview>>, args = prepared.args) => await dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.creativeReviewBind, args, prepared.context);
const inspect = async (prepared: Awaited<ReturnType<typeof preparedCreativeReview>>) => await dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.inspect, { identity: prepared.created.record.identity }, { tier: "read_motion", checkpointStoryboardRecordStore: prepared.value.store });
const remove = async (prepared: Awaited<ReturnType<typeof preparedCreativeReview>>) => await dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.remove, { identity: prepared.created.record.identity }, { tier: "write_local", checkpointStoryboardRecordStore: prepared.value.store });
const directoryOf = (prepared: Awaited<ReturnType<typeof preparedCreativeReview>>) => join(prepared.value.root, ".shellx-motion-c6c-record-store", "creative-reviews", prepared.created.record.identity.id);

describe.skipIf(process.platform !== "linux")("C6C B1c creative-review durability", () => {
  it("binds one complete B1b pair as a redacted source-test association and replays after detach", async () => {
    const prepared = await preparedCreativeReview(), directory = directoryOf(prepared);
    await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    const bound = await bind(prepared); if (!bound.ok) throw new Error(JSON.stringify(bound));
    expect(bound).toMatchObject({ ok: true, result: { creativeReview: { evidence: { evidenceClass: "source-test-association", hostBrowser: false, humanReview: false, pixels: false, quality: false, finalMedia: false } } } });
    await expect(bind(prepared)).resolves.toMatchObject({ ok: true, result: { replay: "same-input" } });
    const persisted = await readFile(join(directory, `${prepared.created.record.identity.id}.creative-review.json`), "utf8");
    for (const secret of ["unretained private prompt", prepared.handles.previewHandle, prepared.handles.receiptHandle, prepared.args.creativeReviewHandle, prepared.value.source, prepared.value.output]) expect(persisted).not.toContain(secret);
    await detachCheckpointStoryboardStoredRecord(prepared.value.materialization, prepared.created.record.identity);
    await expect(bind(prepared)).resolves.toMatchObject({ ok: true, result: { replay: "same-input" } });
    await expect(bind(prepared, prepared.alternateArgs)).resolves.toMatchObject({ ok: false, error: { code: "creative_review_binding_conflict" } });
  });

  it("requires every final, intent, member, completion, and signed root head on inspect/remove/archive", async () => {
    for (const missing of ["final", "intent", "member", "completion", "head"] as const) {
      const prepared = await preparedCreativeReview(); await expect(bind(prepared)).resolves.toMatchObject({ ok: true });
      await detachCheckpointStoryboardStoredRecord(prepared.value.materialization, prepared.created.record.identity);
      const directory = directoryOf(prepared), id = prepared.created.record.identity.id;
      await rm(join(directory, missing === "final" ? `${id}.creative-review.json` : missing === "intent" ? `${id}.creative-review.intent.json` : missing === "member" ? "1.json" : missing === "completion" ? `${id}.creative-review.complete.json` : "head.json"));
      await expect(inspect(prepared)).resolves.toMatchObject({ ok: false, error: { code: "store_integrity_failed" } });
      await expect(remove(prepared)).resolves.toMatchObject({ ok: false, error: { code: "store_integrity_failed" } });
      await expect(archiveCheckpointStoryboardStoredLineage(prepared.value.store, prepared.created.record.identity)).rejects.toMatchObject({ code: "store_integrity_failed" });
    }
  }, 60_000);

  it("repairs only a missing completion tail and fails closed for tampered intent/completion", async () => {
    const completion = await preparedCreativeReview(), completionDirectory = directoryOf(completion), completionId = completion.created.record.identity.id;
    await expect(bind(completion)).resolves.toMatchObject({ ok: true }); await rm(join(completionDirectory, `${completionId}.creative-review.complete.json`));
    await detachCheckpointStoryboardStoredRecord(completion.value.materialization, completion.created.record.identity);
    await expect(inspect(completion)).resolves.toMatchObject({ ok: false, error: { code: "store_integrity_failed" } });
    await expect(remove(completion)).resolves.toMatchObject({ ok: false, error: { code: "store_integrity_failed" } });
    await expect(archiveCheckpointStoryboardStoredLineage(completion.value.store, completion.created.record.identity)).rejects.toMatchObject({ code: "store_integrity_failed" });
    await expect(bind(completion, completion.alternateArgs)).resolves.toMatchObject({ ok: false, error: { code: "creative_review_binding_conflict" } });
    await expect(bind(completion)).resolves.toMatchObject({ ok: true, result: { replay: "same-input" } });
    for (const damaged of ["intent", "completion"] as const) {
      const prepared = await preparedCreativeReview(), directory = directoryOf(prepared), id = prepared.created.record.identity.id;
      await expect(bind(prepared)).resolves.toMatchObject({ ok: true }); await writeFile(join(directory, `${id}.creative-review.${damaged}.json`), "{}", { mode: 0o600 });
      await detachCheckpointStoryboardStoredRecord(prepared.value.materialization, prepared.created.record.identity);
      await expect(inspect(prepared)).resolves.toMatchObject({ ok: false, error: { code: "store_integrity_failed" } });
      await expect(remove(prepared)).resolves.toMatchObject({ ok: false, error: { code: "store_integrity_failed" } });
      await expect(archiveCheckpointStoryboardStoredLineage(prepared.value.store, prepared.created.record.identity)).rejects.toMatchObject({ code: "store_integrity_failed" });
      if (damaged === "intent") await expect(bind(prepared)).resolves.toMatchObject({ ok: false, error: { code: "store_integrity_failed" } });
    }
  }, 60_000);

  it("rejects hidden/tampered roster members while retaining detached historical association and recognized temporary cleanup", async () => {
    const retained = await preparedCreativeReview(), directory = directoryOf(retained), final = join(directory, `${retained.created.record.identity.id}.creative-review.json`);
    await expect(bind(retained)).resolves.toMatchObject({ ok: true }); await detachCheckpointStoryboardStoredRecord(retained.value.materialization, retained.created.record.identity);
    await expect(remove(retained)).resolves.toMatchObject({ ok: true }); await expect(archiveCheckpointStoryboardStoredLineage(retained.value.store, retained.created.record.identity)).resolves.toMatchObject({ replayed: false }); await expect(readFile(final, "utf8")).resolves.toContain("creative_review_");
    await writeFile(join(directory, "1.json.11111111-1111-1111-1111-111111111111.tmp"), "{}", { mode: 0o600 }); await expect(recoverCheckpointStoryboardRecordStoreForQuiescentHost(retained.value.store, issueCheckpointStoryboardRecordStoreQuiescentAdmission(retained.value.store))).resolves.toMatchObject({ removedTemporaryFiles: 1 });
    const tampered = await preparedCreativeReview(); await expect(bind(tampered)).resolves.toMatchObject({ ok: true }); await writeFile(join(directoryOf(tampered), "head.json"), "{}", { mode: 0o600 }); await expect(inspect(tampered)).resolves.toMatchObject({ ok: false, error: { code: "store_integrity_failed" } });
    const hidden = await preparedCreativeReview(); await expect(bind(hidden)).resolves.toMatchObject({ ok: true }); const hiddenDirectory = directoryOf(hidden); await writeFile(join(hiddenDirectory, "2.json"), await readFile(join(hiddenDirectory, "1.json")), { mode: 0o600 }); await expect(inspect(hidden)).resolves.toMatchObject({ ok: false, error: { code: "store_integrity_failed" } });
  }, 60_000);

  it("refuses forged/mixed B1b and host handles, caller creative records, and malformed authority", async () => {
    const prepared = await preparedCreativeReview();
    await expect(bind(prepared, { ...prepared.args, preview: { previewHandle: prepared.handles.previewHandle, receiptHandle: "checkpoint_storyboard_preview_receipt_00000000000000000000000000000000" } })).resolves.toMatchObject({ ok: false, error: { code: "creative_review_evidence_refused" } });
    await expect(bind(prepared, { ...prepared.args, creativeReviewHandle: opaqueCreativeReviewHandle("unknown") })).resolves.toMatchObject({ ok: false, error: { code: "creative_review_evidence_refused" } });
    await expect(bind(prepared, { ...prepared.args, callerPath: "/host/private" } as never)).resolves.toMatchObject({ ok: false, error: { code: "invalid_args" } });
    await expect(bind(prepared, { ...prepared.args, creative: { brief: { sha256: "f".repeat(64) } } } as never)).resolves.toMatchObject({ ok: false, error: { code: "invalid_args" } });
    const [handle, registration] = [...prepared.registry.entries()][0]!;
    const mismatched = { ...registration, authentication: { ...registration.authentication, shotPlanApprover: hostCreativeAuthentication({ kind: "human", id: "wrong-approver" }, "wrong-approver") } };
    expect(() => configureCheckpointStoryboardCreativeReviewAuthority({ recordStore: prepared.value.store, materializationAuthority: prepared.value.materialization, previewAuthority: prepared.previewAuthority, creativeReviewRegistry: new Map([[handle, mismatched]]) as never })).toThrow(/attestations must match/u);
    await expect(dispatchDebugCommand(CHECKPOINT_STORYBOARD_RECORD_COMMANDS.creativeReviewBind, prepared.args, { ...prepared.context, checkpointStoryboardCreativeReviewAuthority: {} as never })).resolves.toMatchObject({ ok: false, error: { code: "creative_review_authority_refused" } });
  });

  it("refuses AI and default-policy actors, admitting matching policy attestations only through host opt-in", async () => {
    await expect(preparedCreativeReview({ shotPlanApprover: { kind: "ai", id: "ai-approver" }, reviewDecisionReviewer: { kind: "human", id: "critic" } })).rejects.toThrow(/must be human or policy/u);
    await expect(preparedCreativeReview({ shotPlanApprover: { kind: "policy", id: "policy-approver" }, reviewDecisionReviewer: { kind: "policy", id: "policy-reviewer" } })).rejects.toThrow(/policy is permitted only by explicit host opt-in/u);
    const policy = await preparedCreativeReview({ shotPlanApprover: { kind: "policy", id: "policy-approver" }, reviewDecisionReviewer: { kind: "policy", id: "policy-reviewer" }, allowPolicyActors: true });
    await expect(bind(policy)).resolves.toMatchObject({ ok: true });
  });

  it("refuses terminal background-only evidence even when the host-selected shot extends beyond D", async () => {
    const prepared = await preparedCreativeReview({ previewAtMs: 1000, shotDurationUs: 2_000_000 });
    await expect(bind(prepared)).resolves.toMatchObject({ ok: false, error: { code: "creative_review_evidence_refused" } });
    await expect(lstat(directoryOf(prepared))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails inspect read-only on removed B1b evidence and forward-completes only exact interruptions", async () => {
    const removed = await preparedCreativeReview(); await expect(bind(removed)).resolves.toMatchObject({ ok: true }); const previews = join(removed.value.root, ".shellx-motion-c6c-record-store", "previews", removed.created.record.identity.id); await rm(previews, { recursive: true }); await expect(inspect(removed)).resolves.toMatchObject({ ok: false, error: { code: "store_integrity_failed" } }); await expect(lstat(previews)).rejects.toMatchObject({ code: "ENOENT" });
    for (const point of ["after-intent", "after-member", "after-head", "after-final"] as const) {
      const prepared = await preparedCreativeReview(); setCheckpointStoryboardCreativeReviewFaultHooksForTest(prepared.creativeReviewAuthority, { [point]: () => { throw new Error(`interrupted ${point}`); } }); await expect(bind(prepared)).resolves.toMatchObject({ ok: false }); setCheckpointStoryboardCreativeReviewFaultHooksForTest(prepared.creativeReviewAuthority, undefined);
      await expect(inspect(prepared)).resolves.toMatchObject({ ok: false, error: { code: "store_integrity_failed" } }); await detachCheckpointStoryboardStoredRecord(prepared.value.materialization, prepared.created.record.identity); await expect(remove(prepared)).resolves.toMatchObject({ ok: false, error: { code: "store_integrity_failed" } }); await expect(archiveCheckpointStoryboardStoredLineage(prepared.value.store, prepared.created.record.identity)).rejects.toMatchObject({ code: "store_integrity_failed" }); await expect(bind(prepared, prepared.alternateArgs)).resolves.toMatchObject({ ok: false, error: { code: "creative_review_binding_conflict" } }); await expect(bind(prepared)).resolves.toMatchObject({ ok: true, result: { replay: "same-input" } });
    }
    const rollback = await preparedCreativeReview(); setCheckpointStoryboardCreativeReviewFaultHooksForTest(rollback.creativeReviewAuthority, { "after-final": () => { throw new Error("preserve preparing head"); } }); await bind(rollback); setCheckpointStoryboardCreativeReviewFaultHooksForTest(rollback.creativeReviewAuthority, undefined);
    const oldHead = await readFile(join(directoryOf(rollback), "head.json")); await expect(bind(rollback)).resolves.toMatchObject({ ok: true }); await writeFile(join(directoryOf(rollback), "head.json"), oldHead, { mode: 0o600 }); await expect(inspect(rollback)).resolves.toMatchObject({ ok: false, error: { code: "store_integrity_failed" } });
  }, 90_000);

  it("preflights the 129th request before intent publication and leaves its roster byte-exact", async () => {
    const prepared = await preparedCreativeReview(), directory = directoryOf(prepared), id = prepared.created.record.identity.id;
    await expect(bind(prepared)).resolves.toMatchObject({ ok: true }); const signed = JSON.parse(await readFile(join(directory, `${id}.creative-review.json`), "utf8")) as { payload: Record<string, unknown> };
    await rm(directory, { recursive: true }); await mkdir(directory, { recursive: true, mode: 0o700 }); await seedCreativeReviewCapacity(prepared.value.root, directory, signed.payload); const before = await snapshotDirectory(directory);
    await expect(bind(prepared)).resolves.toMatchObject({ ok: false, error: { code: "lineage_limit_exceeded" } }); await expect(snapshotDirectory(directory)).resolves.toBe(before);
  }, 60_000);
});
