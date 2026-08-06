import assert from "node:assert/strict";
import { readFile, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startMotionDebugServer } from "../packages/debug-server/src/index";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const packageRoot = join(repoRoot, "fixtures", "packages", "lower-third");
const outDir = join(repoRoot, ".scratch", "debug-server-prompt-smoke");
const receiptsRoot = join(outDir, "receipts");
const patchedPackageRoot = join(outDir, "package");
const previewOutDir = join(outDir, "preview");
const previewPath = join(previewOutDir, "frame.png");

await rm(outDir, { recursive: true, force: true });

const server = await startMotionDebugServer({
  port: 0,
  grantedTier: "edit_motion",
  context: {
    scratchRoot: outDir,
    receiptsRoot,
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
                patch: [{ op: "replace", path: "/layers/0/text", value: "Debug Server Prompt" }],
                createdBy: "debug-server-prompt-smoke"
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
          id: "agent-debug-server-prompt-smoke",
          operation: "agent.prompt",
          status: "passed" as const,
          packageId: input.packageId ?? "pkg_lower_third",
          inputHashes: { prompt: "c".repeat(64), context: "d".repeat(64) },
          createdAt: "2026-07-03T00:00:00.000Z",
          lane: "agent",
          output: {
            agentId: input.agentId ?? "fake",
            label: "Fake Debug Server Prompt Agent",
            transport: "local-cli",
            billing: "cli-subscription",
            command: { executable: "shellx-motion-fake-agent", args: ["run", "--json"], shell: false },
            transcript: [
              { role: "user", contentSha256: "c".repeat(64) },
              { role: "agent", content: "Prepared debug-server prompt package patch and preview." }
            ],
            permission: input.permission
          },
          warnings: []
        }
      })
    }
  }
});

try {
  const initialize = await jsonRpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "shellx-motion-debug-server-prompt-smoke", version: "0.0.0" }
  }, "mcp-initialize");
  const initializeResult = readObject(readObjectField(initialize, "result", "initialize.result"), "initialize.result");
  assert(readObjectField(initializeResult, "protocolVersion", "initialize.protocolVersion") === "2025-06-18", "MCP initialize protocol mismatch");

  const toolsList = await jsonRpc("tools/list", {}, "mcp-tools");
  const toolsResult = readObject(readObjectField(toolsList, "result", "tools.result"), "tools.result");
  const tools = readArray(readObjectField(toolsResult, "tools", "tools.result.tools"));
  const toolNames = new Set(tools.map((tool) => readString(readObjectField(tool, "name", "tool.name"), "tool.name")));
  assert(toolNames.has("motion_prompt_run"), "MCP tools/list missing motion_prompt_run");
  assert(toolNames.has("motion_receipts_panel"), "MCP tools/list missing motion_receipts_panel");
  assert(toolNames.has("motion_agent_transcript"), "MCP tools/list missing motion_agent_transcript");

  const promptCall = await mcpCall("motion_prompt_run", {
    requestedTier: "edit_motion",
    args: {
      request: "edit the lower third title and preview it from MCP",
      packageId: "pkg_lower_third",
      agentId: "fake",
      receiptsRoot,
      executeAgentCommands: true
    }
  }, "mcp-call-prompt-run");
  assert(
    readObjectField(promptCall, "isError", "promptCall.isError") === false,
    `motion_prompt_run MCP call failed: ${JSON.stringify(promptCall)}`
  );
  const promptStructured = readObject(readObjectField(promptCall, "structuredContent", "promptCall.structuredContent"), "promptCall.structuredContent");
  assert(readObjectField(promptStructured, "command", "promptStructured.command") === "motion.prompt.run", "motion_prompt_run returned wrong command");
  assert(readObjectField(promptStructured, "ok", "promptStructured.ok") === true, "motion_prompt_run did not pass");
  const promptReceiptId = readString(readObjectField(promptStructured, "receiptId", "promptStructured.receiptId"), "promptStructured.receiptId");
  const promptPayload = readObject(readObjectField(promptStructured, "result", "promptStructured.result"), "promptStructured.result");
  const execution = readObject(readObjectField(promptPayload, "execution", "promptPayload.execution"), "promptPayload.execution");
  assert(readObjectField(execution, "commandCount", "execution.commandCount") === 2, "motion_prompt_run did not execute both debug commands");
  const promptReceipt = readObject(readObjectField(promptPayload, "receipt", "promptPayload.receipt"), "promptPayload.receipt");
  const promptOutput = readObject(readObjectField(promptReceipt, "output", "promptReceipt.output"), "promptReceipt.output");
  const linkedReceiptIds = readArray(readObjectField(promptOutput, "linkedReceiptIds", "promptReceipt.output.linkedReceiptIds")).map((value) =>
    readString(value, "linkedReceiptId")
  );
  assert(readObjectField(promptOutput, "agentReceiptId", "promptReceipt.output.agentReceiptId") === "agent-debug-server-prompt-smoke", "prompt receipt did not link agent receipt");
  assert(linkedReceiptIds.length === 2, "prompt receipt did not link package patch and preview receipts");

  const patchedMotion = readJsonObject(await readFile(join(patchedPackageRoot, "motion.json"), "utf8"), "patched motion");
  const layers = readArray(readObjectField(patchedMotion, "layers", "patchedMotion.layers"));
  const titleLayer = readObject(layers[0], "title layer");
  assert(readObjectField(titleLayer, "text", "titleLayer.text") === "Debug Server Prompt", "MCP prompt package patch did not update title text");
  await stat(previewPath);
  const png = await readFile(previewPath);
  assert(png.subarray(0, 8).toString("hex") === "89504e470d0a1a0a", "MCP prompt preview output is not a PNG");

  const receiptsCall = await mcpCall("motion_receipts_panel", {
    requestedTier: "read_motion",
    args: { receiptsRoot, limit: 20 }
  }, "mcp-call-receipts-panel");
  assert(readObjectField(receiptsCall, "isError", "receiptsCall.isError") === false, "motion_receipts_panel MCP call failed");
  const receiptsStructured = readObject(readObjectField(receiptsCall, "structuredContent", "receiptsCall.structuredContent"), "receiptsCall.structuredContent");
  const receiptsVisibleState = readObject(readObjectField(receiptsStructured, "visibleState", "receiptsStructured.visibleState"), "receiptsStructured.visibleState");
  assertNumberAtLeast(readObjectField(receiptsVisibleState, "receiptCount", "receiptsVisibleState.receiptCount"), 4, "receipt panel receiptCount");
  assert(readObjectField(receiptsVisibleState, "failedCount", "receiptsVisibleState.failedCount") === 0, "receipt panel must not report failed prompt receipts");

  const transcriptCall = await mcpCall("motion_agent_transcript", {
    requestedTier: "read_motion",
    args: { receiptsRoot, receiptId: promptReceiptId, limit: 1 }
  }, "mcp-call-agent-transcript");
  assert(readObjectField(transcriptCall, "isError", "transcriptCall.isError") === false, "motion_agent_transcript MCP call failed");
  const transcriptStructured = readObject(readObjectField(transcriptCall, "structuredContent", "transcriptCall.structuredContent"), "transcriptCall.structuredContent");
  const transcriptVisibleState = readObject(readObjectField(transcriptStructured, "visibleState", "transcriptStructured.visibleState"), "transcriptStructured.visibleState");
  assert(readObjectField(transcriptVisibleState, "sessionCount", "transcriptVisibleState.sessionCount") === 1, "transcript panel session count mismatch");
  assert(readObjectField(transcriptVisibleState, "messageCount", "transcriptVisibleState.messageCount") === 2, "transcript panel message count mismatch");

  console.log(JSON.stringify({
    ok: true,
    command: "debug-server-prompt:smoke",
    url: server.url.toString(),
    transports: ["http", "json-rpc", "mcp"],
    mcp: {
      called: ["motion_prompt_run", "motion_receipts_panel", "motion_agent_transcript"],
      promptReceiptId,
      linkedReceiptIds
    },
    patchedPackageRoot,
    previewPath,
    receiptsRoot
  }, null, 2));
} finally {
  await server.close();
}

async function jsonRpc(method: string, params: object, id: string): Promise<object> {
  const response = await fetch(new URL("/rpc", server.url), {
    method: "POST",
    headers: {
      authorization: `Bearer ${server.capabilityToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params
    })
  });
  assert(response.ok, `JSON-RPC ${method} returned HTTP ${response.status}`);
  const body = readObject(await response.json(), `JSON-RPC ${method} body`);
  assert(readObjectField(body, "jsonrpc", `${method}.jsonrpc`) === "2.0", `JSON-RPC ${method} response version mismatch`);
  assert(readObjectField(body, "id", `${method}.id`) === id, `JSON-RPC ${method} response id mismatch`);
  assert(!Reflect.has(body, "error"), `JSON-RPC ${method} returned an error: ${JSON.stringify(body)}`);
  return body;
}

async function mcpCall(name: string, args: object, id: string): Promise<object> {
  const response = await jsonRpc("tools/call", { name, arguments: args }, id);
  const result = readObject(readObjectField(response, "result", `${id}.result`), `${id}.result`);
  const content = readArray(readObjectField(result, "content", `${id}.content`));
  assert(content.length > 0, `${name} returned no MCP content`);
  return result;
}

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

function assertNumberAtLeast(value: unknown, minimum: number, label: string): void {
  assert(typeof value === "number", `${label} must be a number`);
  assert(value >= minimum, `${label} must be at least ${minimum}, got ${value}`);
}
