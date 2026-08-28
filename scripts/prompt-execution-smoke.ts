import assert from "node:assert/strict";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dispatchDebugCommand } from "../packages/debug-api/src/index";
import { assertPrivateRepoScratchPath, preparePrivateRepoScratch } from "./repo-scratch.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const packageRoot = join(repoRoot, "fixtures", "packages", "lower-third");
const outDir = join(await preparePrivateRepoScratch(repoRoot), "prompt-execution-smoke");
const receiptsRoot = join(outDir, "receipts");
const patchedPackageRoot = join(outDir, "package");
const previewOutDir = join(outDir, "preview");
const previewPath = join(previewOutDir, "frame.png");

await assertPrivateRepoScratchPath(repoRoot, outDir);
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true, mode: 0o700 });
assert.equal(Number((await stat(outDir)).mode) & 0o777, 0o700, "prompt execution smoke output root must remain private under umask 0002");

const debugResult = await dispatchDebugCommand(
  "motion.prompt.run",
  {
    request: "edit the lower third title and preview the first frame",
    packageId: "pkg_lower_third",
    agentId: "fake",
    receiptsRoot,
    executeAgentCommands: true
  },
  {
    tier: "edit_motion",
    scratchRoot: outDir,
    receiptsRoot,
    authoringInputRoots: [packageRoot, outDir],
    authoringOutputRoots: [outDir],
    promptRuntime: {
      runPrompt: async (input) => ({
        ok: true as const,
        structuredOutput: {
          ok: true,
          debugCommands: [
            {
              command: "motion.package.patch",
              args: {
                packageRoot,
                outDir: patchedPackageRoot,
                patch: [{ op: "replace", path: "/layers/0/text", value: "Prompt Smoke" }],
                createdBy: "prompt-execution-smoke"
              }
            },
            {
              command: "motion.preview.frame",
              args: {
                packageRoot: patchedPackageRoot,
                outDir: previewOutDir,
                outputPath: previewPath,
                atMs: 0
              }
            }
          ]
        },
        transcript: {
          stdout: "[structured agent response]",
          stderr: "",
          redacted: true,
          truncated: false,
          maxBytes: 65_536
        },
        receipt: {
          schema: "shellx-motion/receipt@1" as const,
          id: "agent-prompt-execution-smoke",
          operation: "agent.prompt",
          status: "passed" as const,
          packageId: input.packageId ?? "pkg_lower_third",
          inputHashes: { prompt: "a".repeat(64), context: "b".repeat(64) },
          createdAt: "2026-07-03T00:00:00.000Z",
          lane: "agent",
          output: {
            agentId: input.agentId ?? "fake",
            label: "Fake Prompt Agent",
            transport: "local-cli",
            billing: "cli-subscription",
            command: { executable: "shellx-motion-fake-agent", args: ["run", "--json"], shell: false },
            transcript: [
              { role: "user", contentSha256: "a".repeat(64) },
              { role: "agent", content: "Prepared package patch and preview commands for Prompt Smoke." }
            ],
            permission: input.permission
          },
          warnings: []
        }
      })
    }
  }
);

assert(debugResult.ok, `Prompt execution smoke failed: ${JSON.stringify(debugResult, null, 2)}`);
assert(debugResult.receiptId, "missing prompt receipt id");

const result = readObject(debugResult.result, "debug result");
const execution = readObject(readObjectField(result, "execution", "result.execution"), "result.execution");
assert(readObjectField(execution, "commandCount", "execution.commandCount") === 2, "expected two executed commands");

const patchedMotion = readJsonObject(await readFile(join(patchedPackageRoot, "motion.json"), "utf8"), "patched motion");
const layers = readArray(readObjectField(patchedMotion, "layers", "patchedMotion.layers"));
const titleLayer = readObject(layers[0], "title layer");
assert(readObjectField(titleLayer, "text", "titleLayer.text") === "Prompt Smoke", "package patch did not update title text");

await stat(previewPath);
const png = await readFile(previewPath);
assert(png.subarray(0, 8).toString("hex") === "89504e470d0a1a0a", "prompt preview output is not a PNG");

const promptReceiptPath = join(receiptsRoot, `${debugResult.receiptId}.receipt.json`);
const agentReceiptPath = join(receiptsRoot, "agent-prompt-execution-smoke.receipt.json");
await stat(promptReceiptPath);
await stat(agentReceiptPath);

const promptReceipt = readJsonObject(await readFile(promptReceiptPath, "utf8"), "prompt receipt");
const promptOutput = readObject(readObjectField(promptReceipt, "output", "promptReceipt.output"), "promptReceipt.output");
const executedCommands = readArray(readObjectField(promptOutput, "executedCommands", "promptReceipt.output.executedCommands"));
const linkedReceiptIds = readArray(readObjectField(promptOutput, "linkedReceiptIds", "promptReceipt.output.linkedReceiptIds")).map((value) =>
  readString(value, "linkedReceiptId")
);

assert(executedCommands.length === 2, "prompt receipt must record two executed commands");
assert(readObjectField(promptOutput, "agentReceiptId", "promptReceipt.output.agentReceiptId") === "agent-prompt-execution-smoke", "prompt receipt must link the agent receipt");
assert(linkedReceiptIds.length === 2, "prompt receipt must link package patch and preview receipts");

const packagePatchReceiptPath = join(receiptsRoot, `${linkedReceiptIds[0]}.receipt.json`);
const previewReceiptPath = join(receiptsRoot, `${linkedReceiptIds[1]}.receipt.json`);
await stat(packagePatchReceiptPath);
await stat(previewReceiptPath);

const previewReceipt = readJsonObject(await readFile(previewReceiptPath, "utf8"), "preview receipt");
assert(readObjectField(previewReceipt, "operation", "previewReceipt.operation") === "preview.frame", "preview receipt operation mismatch");
assert(
  new Set(["passed", "warning"]).has(String(readObjectField(previewReceipt, "status", "previewReceipt.status"))),
  "preview receipt must complete without failure"
);

const transcriptResult = await dispatchDebugCommand(
  "motion.agent.transcript",
  { receiptsRoot, receiptId: debugResult.receiptId, limit: 1 },
  { tier: "read_motion", receiptsRoot }
);
assert(transcriptResult.ok, `Agent transcript smoke failed: ${JSON.stringify(transcriptResult, null, 2)}`);
assert(readObjectField(transcriptResult.visibleState, "sessionCount", "transcript.visibleState.sessionCount") === 1, "transcript panel must show one prompt session");
assert(readObjectField(transcriptResult.visibleState, "messageCount", "transcript.visibleState.messageCount") === 2, "transcript panel must summarize agent messages");
const transcriptPayload = readObject(transcriptResult.result, "transcript result");
const sessions = readArray(readObjectField(transcriptPayload, "sessions", "transcript.sessions"));
const session = readObject(sessions[0], "transcript session");
assert(readObjectField(session, "promptReceiptId", "transcript.promptReceiptId") === debugResult.receiptId, "transcript panel prompt receipt mismatch");
assert(readObjectField(session, "agentReceiptId", "transcript.agentReceiptId") === "agent-prompt-execution-smoke", "transcript panel agent receipt mismatch");
const transcript = readObject(readObjectField(session, "transcript", "transcript.session.transcript"), "transcript.session.transcript");
assert(readObjectField(transcript, "messageCount", "transcript.messageCount") === 2, "transcript digest message count mismatch");

console.log(JSON.stringify({
  ok: true,
  command: "agent:smoke",
  packageRoot,
  patchedPackageRoot,
  previewPath,
  promptReceiptPath,
  agentReceiptPath,
  packagePatchReceiptPath,
  previewReceiptPath,
  linkedReceiptIds,
  transcript: {
    sessionCount: readObjectField(transcriptResult.visibleState, "sessionCount", "transcript.visibleState.sessionCount"),
    messageCount: readObjectField(transcriptResult.visibleState, "messageCount", "transcript.visibleState.messageCount")
  }
}, null, 2));

function readJsonObject(text: string, label: string): object {
  const parsed: unknown = JSON.parse(text);
  return readObject(parsed, label);
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
