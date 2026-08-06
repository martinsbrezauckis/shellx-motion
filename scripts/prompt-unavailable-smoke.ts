import assert from "node:assert/strict";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAgentRuntime, type AgentAdapter, type AgentCommand, type AgentRunner } from "../packages/agent-runtime/src/index";
import { dispatchDebugCommand } from "../packages/debug-api/src/index";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const packageRoot = join(repoRoot, "fixtures", "packages", "lower-third");
const outDir = join(repoRoot, ".scratch", "prompt-unavailable-smoke");
const receiptsRoot = join(outDir, "receipts");
const patchedPackageRoot = join(outDir, "should-not-exist-package");
const previewOutDir = join(outDir, "should-not-exist-preview");

await rm(outDir, { recursive: true, force: true });

const unavailableAdapter: AgentAdapter = {
  id: "unavailable",
  label: "Unavailable Prompt Agent",
  transport: "local-cli",
  billing: "cli-subscription",
  probeCommand: () => ({ executable: "shellx-motion-unavailable-agent", args: ["--version"], shell: false }),
  promptCommand: (input) => ({
    executable: "shellx-motion-unavailable-agent",
    args: ["run", "--json"],
    cwd: input.cwd,
    stdin: input.prompt,
    shell: false
  })
};

const fallbackAdapter: AgentAdapter = {
  id: "fallback",
  label: "Fallback Prompt Agent",
  transport: "local-cli",
  billing: "cli-subscription",
  probeCommand: () => ({ executable: "shellx-motion-fallback-agent", args: ["--version"], shell: false }),
  promptCommand: (input) => ({
    executable: "shellx-motion-fallback-agent",
    args: ["run", "--json"],
    cwd: input.cwd,
    stdin: input.prompt,
    shell: false
  })
};

const commands: AgentCommand[] = [];
const runner: AgentRunner = async (command) => {
  commands.push(command);
  if (command.executable === "shellx-motion-unavailable-agent") {
    return { exitCode: 127, stdout: "", stderr: "command not found" };
  }
  if (command.executable === "shellx-motion-fallback-agent" && command.args.includes("--version")) {
    return { exitCode: 0, stdout: "shellx-motion-fallback-agent 0.0.0", stderr: "" };
  }
  if (command.executable === "shellx-motion-fallback-agent") {
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        ok: true,
        debugCommands: [
          {
            command: "motion.package.patch",
            args: {
              packageRoot,
              outDir: patchedPackageRoot,
              patch: [{ op: "replace", path: "/layers/0/text", value: "Fallback Should Not Run" }],
              createdBy: "prompt-unavailable-smoke"
            }
          },
          {
            command: "motion.preview.frame",
            args: {
              packageRoot: patchedPackageRoot,
              outDir: previewOutDir,
              outputPath: join(previewOutDir, "frame.png"),
              atMs: 0
            }
          }
        ]
      }),
      stderr: ""
    };
  }
  return { exitCode: 1, stdout: "", stderr: `unexpected command: ${command.executable}` };
};

const promptRuntime = buildAgentRuntime({
  adapters: [unavailableAdapter, fallbackAdapter],
  runner
});

const debugResult = await dispatchDebugCommand(
  "motion.prompt.run",
  {
    request: "edit the lower third title and preview the first frame",
    packageId: "pkg_unavailable_smoke",
    agentId: "unavailable",
    receiptsRoot,
    executeAgentCommands: true
  },
  {
    tier: "edit_motion",
    scratchRoot: outDir,
    receiptsRoot,
    promptRuntime
  }
);

assert(!debugResult.ok, `unavailable agent smoke unexpectedly passed: ${JSON.stringify(debugResult, null, 2)}`);
assert(debugResult.error.code === "agent_unavailable", `expected agent_unavailable, got ${debugResult.error.code}`);
assert(
  debugResult.error.message.includes("No fallback agent was executed"),
  `expected no-fallback error message, got ${debugResult.error.message}`
);
assert(commands.length === 1, `expected only the selected unavailable agent probe, got ${commands.length} commands`);
assert(commands[0]?.executable === "shellx-motion-unavailable-agent", "fallback agent was probed or executed");
assert(commands[0]?.args.join(" ") === "--version", "unavailable agent should only be probed");

const receiptNames = (await readdir(receiptsRoot)).filter((name) => name.endsWith(".receipt.json")).sort();
assert(receiptNames.length === 1, `expected one failed prompt receipt, got ${receiptNames.join(", ")}`);
const promptReceiptPath = join(receiptsRoot, receiptNames[0]);
const promptReceipt = readJsonObject(await readFile(promptReceiptPath, "utf8"), "prompt receipt");
assert(readObjectField(promptReceipt, "operation", "prompt.run.operation") === "prompt.run", "prompt receipt operation mismatch");
assert(readObjectField(promptReceipt, "status", "failed.status") === "failed", "prompt receipt must fail");
assert(readObjectField(promptReceipt, "packageId", "promptReceipt.packageId") === "pkg_unavailable_smoke", "prompt receipt package mismatch");

const warnings = readArray(readObjectField(promptReceipt, "warnings", "promptReceipt.warnings"));
assert(
  warnings.some((warning) => readString(warning, "prompt receipt warning") === "Agent prompt failed with code agent_unavailable."),
  "prompt receipt must include the selected-agent unavailable warning"
);

const promptOutput = readObject(readObjectField(promptReceipt, "output", "promptReceipt.output"), "promptReceipt.output");
assert(readObjectField(promptOutput, "agentId", "promptReceipt.output.agentId") === "unavailable", "prompt receipt agent mismatch");
assert(Array.isArray(readObjectField(promptOutput, "debugCommands", "promptReceipt.output.debugCommands")), "prompt receipt must retain planned debug commands");
assert(readObjectField(promptOutput, "executedCommands", "promptReceipt.output.executedCommands") === undefined, "failed prompt receipt must not include executed commands");
const linkedReceiptIds = readObjectField(promptOutput, "linkedReceiptIds", "promptReceipt.output.linkedReceiptIds");
assert(linkedReceiptIds === undefined || (Array.isArray(linkedReceiptIds) && linkedReceiptIds.length === 0), "failed prompt receipt must not include linkedReceiptIds");

await assertPathMissing(patchedPackageRoot);
await assertPathMissing(previewOutDir);

console.log(JSON.stringify({
  ok: true,
  command: "agent-unavailable:smoke",
  errorCode: debugResult.error.code,
  promptReceiptPath,
  probedCommands: commands.map((command) => [command.executable, ...command.args].join(" ")),
  noFallback: true,
  noMutation: true
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

async function assertPathMissing(path: string): Promise<void> {
  try {
    await stat(path);
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return;
    throw error;
  }
  assert.fail(`expected path to be absent: ${path}`);
}

function nodeErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !("code" in error)) return undefined;
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}
