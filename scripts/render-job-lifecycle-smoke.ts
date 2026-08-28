/**
 * Host gate for the render job lifecycle: cancel, retry, and the words the queue reports.
 *
 * The vocabulary this asserts is not invented here. `state` is the contract's derived projection
 * (`schemas/job-status.json`), so a retried render that has been minted but not yet started is
 * `pending` — "Motion has accepted the request … and is waiting for a concurrency slot. No process
 * has been spawned and no bytes have been written." This smoke previously demanded `"queued"`, a
 * word the contract has never defined, and so failed against correct engine behaviour
 * Every state read here is checked for contract membership as well as
 * for the exact expected value, so the next word that does not exist fails as a vocabulary error.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSchema, type OperationReceipt, validateDocument } from "../packages/core/src/index";
import { runCli } from "../packages/cli/src/main";
import { assertContractJobState } from "./render-smoke-status";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const outDir = join(repoRoot, ".scratch", "render-job-lifecycle-smoke");
const receiptsRoot = join(outDir, "receipts");

await rm(outDir, { recursive: true, force: true });
await mkdir(receiptsRoot, { recursive: true });

const queuedReceipt = renderReceipt({
  id: "render-final-queued-smoke",
  status: "not_run",
  outputPath: join(outDir, "queued.mp4")
});
const failedReceipt = renderReceipt({
  id: "render-final-failed-smoke",
  status: "failed",
  outputPath: join(outDir, "failed.mp4")
});

await writeJsonFile(join(receiptsRoot, `${queuedReceipt.id}.receipt.json`), queuedReceipt);
await writeJsonFile(join(receiptsRoot, `${failedReceipt.id}.receipt.json`), failedReceipt);

const cancel = await runCli([
  "debug",
  "render-cancel",
  "--tier",
  "render_motion",
  "--trusted-local-tier",
  "--receipts-root",
  receiptsRoot,
  "--receipt-id",
  "render-final-queued-smoke",
  "--reason",
  "host lifecycle smoke cancel"
]);
assert(readObjectField(cancel, "ok", "cancel.ok") === true, `render-cancel failed: ${JSON.stringify(cancel, null, 2)}`);
assert(readObjectField(readObjectField(cancel, "visibleState", "cancel.visibleState"), "state", "cancel.visibleState.state") === "cancelled", "cancel did not expose cancelled state");

const retry = await runCli([
  "debug",
  "render-retry",
  "--tier",
  "render_motion",
  "--trusted-local-tier",
  "--receipts-root",
  receiptsRoot,
  "--receipt-id",
  "render-final-failed-smoke",
  "--reason",
  "host lifecycle smoke retry"
]);
assert(readObjectField(retry, "ok", "retry.ok") === true, `render-retry failed: ${JSON.stringify(retry, null, 2)}`);
const retryReceiptId = readString(readObjectField(retry, "receiptId", "retry.receiptId"), "retry.receiptId");
const retryResult = readObject(readObjectField(retry, "result", "retry.result"), "retry.result");
assert(readObjectField(retryResult, "retryAttempt", "retry.result.retryAttempt") === 1, "retry attempt mismatch");

const queue = await runCli(["debug", "render-queue", "--receipts-root", receiptsRoot]);
assert(readObjectField(queue, "ok", "queue.ok") === true, `render-queue failed: ${JSON.stringify(queue, null, 2)}`);
const queueResult = readObject(readObjectField(queue, "result", "queue.result"), "queue.result");
const jobs = readArray(readObjectField(queueResult, "jobs", "queue.result.jobs"));
const cancelledJob = findJob(jobs, "render-final-queued-smoke");
const failedJob = findJob(jobs, "render-final-failed-smoke");
const retryJob = findJob(jobs, retryReceiptId);

const cancelledState = readJobState(cancelledJob, "cancelledJob.state");
const failedState = readJobState(failedJob, "failedJob.state");
const retryState = readJobState(retryJob, "retryJob.state");

assert(cancelledState === "cancelled", `the cancelled job reports ${JSON.stringify(cancelledState)}, not "cancelled"`);
assert(failedState === "failed", `the failed job reports ${JSON.stringify(failedState)}, not "failed"`);
// A retry mints a fresh job that has not been admitted to a slot yet, which the contract calls
// `pending`. Nothing has been spawned and no bytes have been written, so any word implying work is
// under way would be a lie to whatever renders the host's progress display.
assert(retryState === "pending", `the retried job reports ${JSON.stringify(retryState)}, not "pending"`);
assert(readArray(readObjectField(retryJob, "availableActions", "retryJob.availableActions")).some((action) => readObjectField(action, "id", "retryJob.action.id") === "cancel"), "pending retry job lacks cancel action");

const handoff = readObject(readObjectField(retryJob, "handoff", "retryJob.handoff"), "retryJob.handoff");
assert(readObjectField(handoff, "schema", "retryJob.handoff.schema") === "shellx-motion/render-job-handoff@1", "retry handoff schema mismatch");
assert(readObjectField(handoff, "sourceReceiptId", "retryJob.handoff.sourceReceiptId") === "render-final-failed-smoke", "retry handoff source mismatch");
assert(readObjectField(handoff, "retryAttempt", "retryJob.handoff.retryAttempt") === 1, "retry handoff attempt mismatch");

const schema = await loadSchema("renderJobHandoff");
const validation = await validateDocument(schema, handoff);
assert.deepEqual(validation, { ok: true }, `render job handoff failed schema validation: ${JSON.stringify(validation, null, 2)}`);

console.log(JSON.stringify({
  ok: true,
  command: "render-job-lifecycle:smoke",
  receiptsRoot,
  cancelledReceiptId: "render-final-queued-smoke",
  retryReceiptId,
  states: { cancelled: cancelledState, failed: failedState, retry: retryState },
  handoff
}, null, 2));

/** Read a queue job's state and prove the word is one the contract defines before comparing it. */
function readJobState(job: object, label: string): string {
  const state = readObjectField(job, "state", label);
  assert(typeof state === "string", `expected ${label} string, got ${typeof state}`);
  assertContractJobState(state, label);
  return state;
}

function renderReceipt(input: { id: string; status: "not_run" | "failed"; outputPath: string }): OperationReceipt {
  return {
    schema: "shellx-motion/receipt@1",
    id: input.id,
    operation: "render.final",
    status: input.status,
    packageId: "pkg_render_lifecycle_smoke",
    inputHashes: { motion: "a".repeat(64) },
    createdAt: "2026-07-01T00:00:00.000Z",
    lane: "ffmpeg",
    output: { path: input.outputPath, preset: "mp4-h264" },
    warnings: []
  };
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  assert(JSON.parse(await readFile(path, "utf8")), `failed to write ${path}`);
}

function findJob(jobs: unknown[], receiptId: string): object {
  const job = jobs.find((candidate) => readObjectField(candidate, "receiptId", "job.receiptId") === receiptId);
  assert(job, `render-queue missing job ${receiptId}`);
  return readObject(job, `job ${receiptId}`);
}

function readObject(value: unknown, label: string): object {
  assert(typeof value === "object" && value !== null && !Array.isArray(value), `expected ${label} object, got ${typeof value}`);
  return value;
}

function readObjectField(value: unknown, key: string, label: string): unknown {
  const record = readObject(value, label);
  return Reflect.get(record, key);
}

function readArray(value: unknown): unknown[] {
  assert(Array.isArray(value), "expected array");
  return value;
}

function readString(value: unknown, label: string): string {
  assert(typeof value === "string" && value.length > 0, `missing ${label}`);
  return value;
}
