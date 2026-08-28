import { createHash } from "node:crypto";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson } from "@shellx-motion/core";
import { afterEach, describe, expect, it } from "vitest";
import { dispatchDebugCommand, debugCommandContract } from "../index.js";
import { DEBUG_COMMANDS, debugCommandDefinition } from "../command-registry.js";
import { CHECKPOINT_STORYBOARD_RECORD_COMMANDS } from "./checkpoint-storyboard-record-lifecycle.js";
import { checkedAuthority } from "./checkpoint-storyboard-record-store-authority.js";
import { inspectCheckpointStoryboardStoredRecordAuditView, tombstoneCheckpointStoryboardStoredRecord } from "./checkpoint-storyboard-record-store.js";
import { detachCheckpointStoryboardRetainedTraceStoredRecord, resolveCheckpointStoryboardRetainedTraceStoredRecord } from "./checkpoint-storyboard-retained-trace-resolution.js";
import { lineageRetainedTraceReviewsDirectory } from "./checkpoint-storyboard-retained-trace-review-store.js";
import { readHostRetainedTraceReviewRegistration, type RetainedTraceReviewActor } from "./checkpoint-storyboard-retained-trace-review-host-registry.js";
import { bindCheckpointStoryboardRetainedTraceReview, setCheckpointStoryboardRetainedTraceReviewFaultHooksForTest } from "./checkpoint-storyboard-retained-trace-review.js";
import { cleanupReviewTestRoots, makeReviewAuthority, makeReviewPreview, retainedTraceReviewFixture, reviewRegistration, reviewTestRenderer } from "./checkpoint-storyboard-retained-trace-review.test-support.js";

const command = CHECKPOINT_STORYBOARD_RECORD_COMMANDS.retainedTraceReviewBind;
const handle = (digit: string) => `checkpoint_storyboard_retained_trace_review_handle_${digit.repeat(32)}`;
afterEach(async () => await cleanupReviewTestRoots());

describe.skipIf(process.platform !== "linux")("C6C B7 retained-trace arbitrary-time review", () => {
  it("binds 0, interior, and D reviews to exact storyboard, recipe, installed package, frame, and receipt identities", async () => {
    const fixture = await retainedTraceReviewFixture(), identity = fixture.created.record.identity;
    await resolveCheckpointStoryboardRetainedTraceStoredRecord(fixture.resolution, identity); await rm(fixture.source, { recursive: true, force: true });
    const previews: Awaited<ReturnType<typeof makeReviewPreview>>[] = [];
    for (const atUs of [0, 2_000, 4_000]) previews.push(await makeReviewPreview(fixture, atUs));
    const entries = previews.map((preview, index) => ({ handle: handle(String(index + 1)), registration: reviewRegistration(fixture, preview, index === 0 ? "accepted" : index === 1 ? "changes_requested" : "rejected") }));
    const authority = makeReviewAuthority(fixture, entries);
    for (let index = 0; index < previews.length; index += 1) {
      const preview = previews[index]!, reviewHandle = entries[index]!.handle;
      const result = await dispatchDebugCommand(command, { identity, preview: { previewHandle: preview.previewHandle, receiptHandle: preview.receiptHandle }, reviewHandle }, { tier: "write_local", checkpointStoryboardRecordStore: fixture.store, checkpointStoryboardRetainedTraceReviewAuthority: authority });
      expect(result).toMatchObject({ ok: true, result: { review: { associationId: expect.stringMatching(/^checkpoint_storyboard_retained_trace_review_[a-f0-9]{32}$/u), scope: { atUs: preview.atUs }, preview: { width: 1280, height: 720, runtimeEvidence: "source-test" }, evidence: { storyboardSha256: identity.sha256, recipeSha256: fixture.created.record.storyboard.recipes[0]!.sha256, packageInventorySha256: expect.stringMatching(/^[a-f0-9]{64}$/u), previewReceiptSha256: expect.stringMatching(/^[a-f0-9]{64}$/u), pngSha256: preview.output.sha256, hostGpu: false, humanReview: false, pixels: false, quality: false, finalMedia: false } } } });
      expect(JSON.stringify(result)).not.toContain(fixture.root); expect(JSON.stringify(result)).not.toContain(fixture.workspace);
    }
    const directory = await lineageRetainedTraceReviewsDirectory(checkedAuthority(fixture.store), fixture.created.record.lineage.root.id), names = await readdir(directory.path);
    expect(names).toHaveLength(9);
    const bindingName = names.find((name) => name.endsWith(".review.json") && !name.includes(".intent.") && !name.includes(".complete."))!;
    const signed = JSON.parse(await readFile(join(directory.path, bindingName), "utf8")) as { payload: Record<string, unknown> };
    expect(signed.payload).toMatchObject({ storyboard: { id: identity.id, sha256: identity.sha256, revision: identity.revision }, recipe: { id: fixture.created.record.storyboard.recipes[0]!.id, sha256: fixture.created.record.storyboard.recipes[0]!.sha256 }, resolution: { receiptFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u), scheduleSha256: expect.stringMatching(/^[a-f0-9]{64}$/u) }, materialization: { package: { id: "trace-package", inventory: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) } } }, frame: { atUs: expect.any(Number), receipt: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) }, png: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/u), width: 1280, height: 720 } } });
    await expect(inspectCheckpointStoryboardStoredRecordAuditView(fixture.store, identity)).resolves.toBeDefined();
  });

  it("replays the exact association after detach but refuses a new reviewed frame", async () => {
    const fixture = await retainedTraceReviewFixture(), identity = fixture.created.record.identity;
    await resolveCheckpointStoryboardRetainedTraceStoredRecord(fixture.resolution, identity);
    const first = await makeReviewPreview(fixture, 0), second = await makeReviewPreview(fixture, 2_000), firstHandle = handle("a"), secondHandle = handle("b");
    const authority = makeReviewAuthority(fixture, [{ handle: firstHandle, registration: reviewRegistration(fixture, first) }, { handle: secondHandle, registration: reviewRegistration(fixture, second) }]);
    const input = { preview: { previewHandle: first.previewHandle, receiptHandle: first.receiptHandle }, reviewHandle: firstHandle };
    await expect(bindCheckpointStoryboardRetainedTraceReview(authority, identity, input)).resolves.toMatchObject({ replayed: false });
    await detachCheckpointStoryboardRetainedTraceStoredRecord(fixture.resolution, identity);
    await expect(bindCheckpointStoryboardRetainedTraceReview(authority, identity, input)).resolves.toMatchObject({ replayed: true });
    await expect(bindCheckpointStoryboardRetainedTraceReview(authority, identity, { preview: { previewHandle: second.previewHandle, receiptHandle: second.receiptHandle }, reviewHandle: secondHandle })).rejects.toMatchObject({ code: "retained_trace_review_evidence_refused" });
  });

  it("recovers one exact interrupted intent after detach and blocks lifecycle until recovery", async () => {
    const fixture = await retainedTraceReviewFixture(), identity = fixture.created.record.identity;
    await resolveCheckpointStoryboardRetainedTraceStoredRecord(fixture.resolution, identity); const preview = await makeReviewPreview(fixture, 2_000), reviewHandle = handle("c"), authority = makeReviewAuthority(fixture, [{ handle: reviewHandle, registration: reviewRegistration(fixture, preview) }]), input = { preview: { previewHandle: preview.previewHandle, receiptHandle: preview.receiptHandle }, reviewHandle };
    setCheckpointStoryboardRetainedTraceReviewFaultHooksForTest(authority, { "after-intent": () => { throw new Error("interrupt"); } });
    await expect(bindCheckpointStoryboardRetainedTraceReview(authority, identity, input)).rejects.toThrow("interrupt"); setCheckpointStoryboardRetainedTraceReviewFaultHooksForTest(authority, undefined);
    await detachCheckpointStoryboardRetainedTraceStoredRecord(fixture.resolution, identity);
    await expect(tombstoneCheckpointStoryboardStoredRecord(fixture.store, identity)).rejects.toMatchObject({ code: "store_integrity_failed" });
    await expect(bindCheckpointStoryboardRetainedTraceReview(authority, identity, input)).resolves.toMatchObject({ replayed: true });
    await expect(tombstoneCheckpointStoryboardStoredRecord(fixture.store, identity)).resolves.toMatchObject({ record: { target: { state: "tombstoned" } } });
  });

  it("refuses crossed handles, unknown authority data, output tamper, and hostile command fields", async () => {
    const calls: number[] = [], fixture = await retainedTraceReviewFixture(reviewTestRenderer(calls)), identity = fixture.created.record.identity;
    await resolveCheckpointStoryboardRetainedTraceStoredRecord(fixture.resolution, identity); const first = await makeReviewPreview(fixture, 0), second = await makeReviewPreview(fixture, 2_000), reviewHandle = handle("d"), authority = makeReviewAuthority(fixture, [{ handle: reviewHandle, registration: reviewRegistration(fixture, first) }]);
    const context = { tier: "write_local" as const, checkpointStoryboardRecordStore: fixture.store, checkpointStoryboardRetainedTraceReviewAuthority: authority };
    await expect(dispatchDebugCommand(command, { identity, preview: { previewHandle: second.previewHandle, receiptHandle: second.receiptHandle }, reviewHandle }, context)).resolves.toMatchObject({ ok: false, error: { code: "retained_trace_review_evidence_refused" } });
    await expect(dispatchDebugCommand(command, { identity, preview: { previewHandle: first.previewHandle, receiptHandle: first.receiptHandle }, reviewHandle: handle("e") }, context)).resolves.toMatchObject({ ok: false, error: { code: "retained_trace_review_evidence_refused" } });
    await expect(dispatchDebugCommand(command, { identity, preview: { previewHandle: first.previewHandle, receiptHandle: first.receiptHandle }, reviewHandle, packagePath: fixture.output }, context)).resolves.toMatchObject({ ok: false, error: { code: "invalid_args" } });
    await writeFile(join(fixture.output, "foreign.bin"), "tamper", "utf8");
    await expect(dispatchDebugCommand(command, { identity, preview: { previewHandle: first.previewHandle, receiptHandle: first.receiptHandle }, reviewHandle }, context)).resolves.toMatchObject({ ok: false, error: { code: "retained_trace_review_evidence_refused" } });
    expect((await readdir(join(fixture.storeRoot, ".shellx-motion-c6c-record-store", "retained-trace-reviews")))).toEqual([]); expect(calls).toEqual([0, 2_000]);
  });
});

describe("C6C B7 retained-trace review portable contract", () => {
  it("is write-local Debug/MCP only with a closed opaque argument schema", async () => {
    expect(DEBUG_COMMANDS).toContain(command); expect(debugCommandDefinition(command)).toMatchObject({ permission: "write_local", mutates: true });
    expect(debugCommandContract(command)?.argsSchema).toMatchObject({ type: "object", additionalProperties: false, required: ["identity", "preview", "reviewHandle"], properties: { preview: { additionalProperties: false, required: ["previewHandle", "receiptHandle"] }, reviewHandle: { pattern: "^checkpoint_storyboard_retained_trace_review_handle_[a-f0-9]{32}$" } } });
    const cli = await readFile(new URL("../../../cli/src/debug-subcommands.ts", import.meta.url), "utf8"), named = cli.slice(cli.indexOf("export const CLI_NAMED_DEBUG_NO_ROUTE"));
    expect(named).toContain(command); expect(cli.slice(0, cli.indexOf("export const CLI_NAMED_DEBUG_NO_ROUTE"))).not.toContain(command);
    for (const relative of ["../../../sdk/src/index.ts", "../../../actions/src/catalog.ts", "../../../connectors/src/index.ts", "../../../renderer-browser/src/index.ts"]) await expect(readFile(new URL(relative, import.meta.url), "utf8")).resolves.not.toContain(command);
  });

  it("authenticates portable human decisions and requires explicit policy opt-in", () => {
    const human = portableRegistration({ kind: "human", id: "reviewer-1" });
    expect(readHostRetainedTraceReviewRegistration(human, handle("f"), Buffer.alloc(32, 7), "store-binding", false)).toMatchObject({ decision: { outcome: "accepted" }, reviewer: { kind: "human", id: "reviewer-1" }, authenticationDigest: expect.stringMatching(/^[a-f0-9]{64}$/u), handleDigest: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    const policy = portableRegistration({ kind: "policy", id: "policy-1" });
    expect(() => readHostRetainedTraceReviewRegistration(policy, handle("f"), Buffer.alloc(32, 7), "store-binding", false)).toThrow("authenticated human");
    expect(readHostRetainedTraceReviewRegistration(policy, handle("f"), Buffer.alloc(32, 7), "store-binding", true)).toMatchObject({ reviewer: { kind: "policy", id: "policy-1" } });
  });

  it("refuses a portable review whose deterministic decision identity is crossed", () => {
    const registration = portableRegistration({ kind: "human", id: "reviewer-1" });
    expect(() => readHostRetainedTraceReviewRegistration({ ...registration, decision: { ...registration.decision as object, sha256: "8".repeat(64) } }, handle("f"), Buffer.alloc(32, 7), "store-binding", false)).toThrow("decision identity");
  });
});

function portableRegistration(actor: RetainedTraceReviewActor) {
  const sha256 = "1".repeat(64), identity = { id: `checkpoint_storyboard_${sha256.slice(0, 32)}`, sha256, revision: 1 };
  const payload = { schema: "shellx-motion/private-checkpoint-storyboard-retained-trace-review-decision@1", outcome: "accepted", reviewer: actor }, decisionSha256 = createHash("sha256").update(canonicalJson(payload)).digest("hex");
  return { record: { identity, root: identity }, preview: { previewHandle: `checkpoint_storyboard_retained_trace_preview_${"2".repeat(32)}`, receiptHandle: `checkpoint_storyboard_retained_trace_preview_receipt_${"3".repeat(32)}` }, decision: { ...payload, id: `checkpoint_storyboard_retained_trace_review_decision_${decisionSha256.slice(0, 32)}`, sha256: decisionSha256 }, authentication: { reviewer: { actor, id: `host_retained_trace_review_authentication_${"9".repeat(32)}`, sha256: "9".repeat(64) } } };
}
