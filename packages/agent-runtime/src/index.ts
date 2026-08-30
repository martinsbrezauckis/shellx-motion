import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { MotionPermissionTier } from "@shellx-motion/actions";
import {
  cleanupWindowsJobObjectLaunchPlan,
  createWindowsJobObjectLaunchPlan,
  defaultLocalMotionJobGovernor,
  LocalMotionJobError,
  waitForWindowsJobObjectStatus,
  windowsJobObjectContainmentEvidence,
  WindowsJobObjectPlanError,
  createOwnedUnixProcessGroup,
  sanitizeUntrustedDiagnostic,
  takeUtf8Prefix,
  type LocalMotionJobErrorCode,
  type LocalMotionJobEvidence,
  type LocalMotionProcessContainmentEvidence,
  type WindowsJobObjectLaunchPlan,
  type WindowsJobObjectStatus,
  childEnvironment
} from "@shellx-motion/core";

import { antigravityAdapter } from "./antigravity";
import { materializeAgentPromptFile } from "./agent-prompt-file";
import { terminateAgentProcessTree, type AgentProcessTerminationMode } from "./agent-process-control";
import { resolveNativeWindowsAgentCommand, revalidateNativeWindowsAgentCommand } from "./windows-agent-command";

export {
  antigravityAdapter,
  antigravityCliCommand,
  antigravityProbeCommand,
  assertAntigravityPrintLast,
  AntigravityPrintOrderError,
  ANTIGRAVITY_EMPTY_OUTPUT_CODE,
  ANTIGRAVITY_EMPTY_OUTPUT_MESSAGE,
  ANTIGRAVITY_EXECUTABLE,
  ANTIGRAVITY_PRINT_FLAG
} from "./antigravity";

export type AgentId = "codex" | "claude-code" | "grok" | "antigravity" | string;
export type AgentTransport = "local-cli";
export type AgentBilling = "cli-subscription";
/** Provider context: only `prompt-only` is execution-safe; `filesystem-read` is health-visible but unsafe. */
export type AgentPromptContextMode = "prompt-only" | "filesystem-read";
export type AgentHealthStatus = "ready" | "missing_binary" | "auth_required" | "quota_limited" | "timeout" | "failed";

export interface AgentCommand {
  executable: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
  /** Internal process-output ceiling. Never exposed in public receipts. */
  maxOutputBytes?: number;
  /** Internal marker replaced with a secure temporary prompt-file path immediately before spawn. */
  promptFileArg?: string;
  /** Internal argv indexes replaced with neutral labels in panels and receipts. */
  redactedArgIndexes?: number[];
  shell: false;
}

export interface AgentPromptInput {
  prompt: string;
  cwd?: string;
}

/**
 * Adapter-declared diagnosis for a run that exits 0 but writes no stdout.
 *
 * Some provider CLIs can succeed at the process level while dropping the
 * response (e.g. Antigravity issue #76 under a non-TTY pipe, or a silent auth
 * failure). There is no response to report in that case, so the adapter names
 * the real cause instead of the runtime emitting a generic parse error — and
 * never a success envelope, which must always correspond to real evidence.
 */
export interface AgentEmptyOutputDiagnosis {
  code: string;
  message: string;
}

export interface AgentAdapter {
  id: AgentId;
  label: string;
  transport: AgentTransport;
  billing: AgentBilling;
  probeCommand: () => AgentCommand;
  promptCommand: (input: AgentPromptInput) => AgentCommand;
  /** Required for prompt execution; an omitted mode is unsafe before command construction, probing, or spawn. */
  promptContextMode?: AgentPromptContextMode;
  setup?: Partial<AgentSetupHints>;
  /**
   * Optional. When declared, an exit-0 run with empty stdout fails closed with
   * this diagnosis. Adapters that do not declare it keep the previous
   * behaviour, where empty stdout falls through to the structured-output parse
   * and reports `agent_invalid_output`.
   */
  emptyOutputDiagnosis?: () => AgentEmptyOutputDiagnosis;
}

export interface AgentProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  outputOverflow?: boolean;
  resources?: LocalMotionJobEvidence;
  resourceErrorCode?: LocalMotionJobErrorCode;
}

export type AgentRunner = (command: AgentCommand) => Promise<AgentProcessResult>;

export interface AgentHealth {
  agentId: AgentId;
  available: boolean;
  command: string;
  transport: AgentTransport;
  billing: AgentBilling;
  detail: string;
  status: AgentHealthStatus;
  version?: string;
  setup: AgentSetupHints;
  probe: PublicAgentCommand;
  failure?: {
    exitCode?: number;
    stderr?: string;
  };
}

export interface AgentSetupHints {
  checkCommand: string;
  installHint: string;
  authHint: string;
  quotaHint: string;
}

export interface RunAgentPromptInput extends AgentPromptInput {
  agentId?: AgentId;
  packageId?: string;
  permission: MotionPermissionTier;
}

export type AgentPromptResult =
  | {
      ok: true;
      receipt: AgentReceipt;
      structuredOutput: unknown;
      transcript: AgentPublicTranscript;
    }
  | {
      ok: false;
      error: { code: string; message: string; detail?: string };
      receipt?: AgentReceipt;
    };

export interface AgentReceipt {
  schema: "shellx-motion/receipt@1";
  id: string;
  operation: "agent.prompt";
  status: "passed" | "failed";
  packageId: string;
  inputHashes: Record<string, string>;
  createdAt: string;
  lane: "agent";
  output: {
    agentId: AgentId;
    label: string;
    transport: AgentTransport;
    billing: AgentBilling;
    command: PublicAgentCommand;
    transcript: Array<
      | { role: "user"; contentSha256: string }
      | { role: "agent"; content: string }
      | { role: "stderr"; content: string }
    >;
    permission: MotionPermissionTier;
    resources?: LocalMotionJobEvidence;
  };
  warnings: string[];
}

export interface AgentRuntime {
  listAgents: () => AgentAdapter[];
  health: () => Promise<AgentHealth[]>;
  runPrompt: (input: RunAgentPromptInput) => Promise<AgentPromptResult>;
}

export interface AgentRuntimeOptions {
  adapters?: AgentAdapter[];
  runner?: AgentRunner;
  now?: () => string;
  maxOutputBytes?: number;
  maxTranscriptBytes?: number;
}

export type PublicAgentCommand = Omit<AgentCommand, "stdin" | "env" | "maxOutputBytes" | "promptFileArg" | "redactedArgIndexes">;

export interface AgentPublicTranscript {
  stdout: string;
  stderr: string;
  redacted: true;
  truncated: boolean;
  maxBytes: number;
}

const DEFAULT_AGENT_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
const AGENT_TIMEOUT_EXIT_CODE = 124;
const AGENT_OUTPUT_OVERFLOW_EXIT_CODE = 125;
const AGENT_RESOURCE_LIMIT_EXIT_CODE = 126;
export const DEFAULT_AGENT_OUTPUT_MAX_BYTES = 1024 * 1024;
export const DEFAULT_AGENT_TRANSCRIPT_MAX_BYTES = 64 * 1024;
/** Public health fields are deliberately much smaller than a retained transcript. */
export const AGENT_HEALTH_DIAGNOSTIC_MAX_BYTES = 512;
/** Structured values can be useful evidence, but never an unbounded transport. */
export const AGENT_STRUCTURED_SCALAR_MAX_BYTES = 64 * 1024;
export const AGENT_CONTEXT_UNBOUNDED_CODE = "agent_context_unbounded";
const AGENT_PROMPT_FILE_ARG = "<prompt-file>";

export function buildAgentRuntime(options: AgentRuntimeOptions = {}): AgentRuntime {
  const adapters = options.adapters ?? createCliAgentAdapters();
  const runner = options.runner ?? spawnAgentCommand;
  const now = options.now ?? (() => new Date().toISOString());
  const maxOutputBytes = boundedPositiveInteger(options.maxOutputBytes, DEFAULT_AGENT_OUTPUT_MAX_BYTES, DEFAULT_AGENT_OUTPUT_MAX_BYTES);
  const maxTranscriptBytes = boundedPositiveInteger(options.maxTranscriptBytes, DEFAULT_AGENT_TRANSCRIPT_MAX_BYTES, DEFAULT_AGENT_TRANSCRIPT_MAX_BYTES);

  return {
    listAgents: () => [...adapters],
    health: async () => Promise.all(adapters.map((adapter) => probeAgent(adapter, runner, maxOutputBytes))),
    runPrompt: async (input) => {
      const adapter = adapters.find((candidate) => candidate.id === (input.agentId ?? "codex"));
      if (!adapter) {
        return {
          ok: false,
          error: {
            code: "agent_unknown",
            message: `${input.agentId ?? "codex"} is not configured.`
          }
        };
      }

      // Health remains independent, but a prompt must explicitly be prompt-only.
      if (adapter.promptContextMode !== "prompt-only") {
        return {
          ok: false,
          error: {
            code: AGENT_CONTEXT_UNBOUNDED_CODE,
            message: "The selected agent cannot run because its context is not bounded to the prompt.",
            detail: adapter.promptContextMode === "filesystem-read" ? "The adapter permits filesystem reads." : "The adapter does not declare a prompt context mode."
          }
        };
      }

      const health = await probeAgent(adapter, runner, maxOutputBytes);
      if (!health.available) {
        return {
          ok: false,
          error: {
            code: "agent_unavailable",
            message: `${adapter.id} is unavailable. No fallback agent was executed.`,
            detail: health.detail
          }
        };
      }

      const command = { ...adapter.promptCommand(input), maxOutputBytes };
      const result = boundProcessResult(await runner(command), maxOutputBytes);
      const transcript = publicTranscript(result, maxTranscriptBytes);
      const receipt = createAgentReceipt({
        adapter,
        command,
        input,
        process: result,
        createdAt: now(),
        maxTranscriptBytes
      });

      if (result.exitCode !== 0) {
        return {
          ok: false,
          receipt,
          error: {
            code: "agent_failed",
            message: `${adapter.id} exited with code ${result.exitCode}.`,
            detail: transcript.stderr || transcript.stdout
          }
        };
      }

      // Exit 0 with no stdout at all is a provider-specific failure mode, not a
      // result. Fail closed with the adapter's own diagnosis when it declares one.
      const emptyOutputDiagnosis = adapter.emptyOutputDiagnosis?.();
      if (emptyOutputDiagnosis && result.stdout.trim() === "") {
        const message = redactSensitiveText(emptyOutputDiagnosis.message);
        return {
          ok: false,
          receipt: { ...receipt, status: "failed", warnings: dedupe([...(receipt.warnings ?? []), message]) },
          error: { code: emptyOutputDiagnosis.code, message, detail: transcript.stderr }
        };
      }

      let structuredOutput: unknown;
      try {
        structuredOutput = parseStructuredAgentOutput(result.stdout);
      } catch (error) {
        const message = redactSensitiveText(error instanceof Error ? error.message : String(error));
        return {
          ok: false,
          receipt: { ...receipt, status: "failed", warnings: dedupe([...(receipt.warnings ?? []), message]) },
          error: { code: "agent_invalid_output", message, detail: transcript.stdout }
        };
      }

      return { ok: true, receipt, structuredOutput, transcript };
    }
  };
}

export function createCliAgentAdapters(): AgentAdapter[] {
  return [
    {
      id: "codex",
      label: "Codex CLI",
      transport: "local-cli",
      billing: "cli-subscription",
      probeCommand: () => ({ executable: "codex", args: ["--version"], shell: false }),
      promptCommand: codexCliCommand,
      promptContextMode: "filesystem-read", // `--sandbox read-only` still permits arbitrary reads.
      setup: {
        authHint: "Authenticate Codex CLI locally before running Motion prompts.",
        quotaHint: "Check Codex CLI subscription limits or retry after the provider limit resets."
      }
    },
    {
      id: "claude-code",
      label: "Claude Code CLI",
      transport: "local-cli",
      billing: "cli-subscription",
      probeCommand: () => ({ executable: "claude", args: ["--version"], shell: false }),
      promptCommand: claudeCodeCliCommand,
      promptContextMode: "prompt-only",
      setup: {
        authHint: "Authenticate Claude Code CLI locally before running Motion prompts.",
        quotaHint: "Check Claude Code CLI subscription limits or retry after the provider limit resets."
      }
    },
    {
      id: "grok",
      label: "Grok CLI",
      transport: "local-cli",
      billing: "cli-subscription",
      probeCommand: () => ({ executable: "grok", args: ["--version"], shell: false }),
      promptCommand: grokCliCommand,
      promptContextMode: "prompt-only", // Exact empty `--tools=` disables the tool surface.
      setup: {
        authHint: "Authenticate Grok CLI locally before running Motion prompts.",
        quotaHint: "Check Grok CLI subscription limits or retry after the provider limit resets."
      }
    },
    // Antigravity is an argv transport, not a stdin transport; its adapter and
    // the reasoning behind each flag live in ./antigravity.ts.
    antigravityAdapter()
    // Kimi is NOT registered. The Kimi CLI is not installed on any ShellX host
    // and no invocation contract for it exists anywhere in the ShellX family,
    // so there is nothing to declare that would be true. Adding a speculative
    // adapter here would make `agent health` claim a provider Motion cannot
    // actually run. Register it only after a real binary and a real probed
    // invocation exist, exactly as antigravity was added.
  ];
}

export function codexCliCommand(input: AgentPromptInput): AgentCommand {
  return {
    executable: "codex",
    args: [
      "exec",
      "--json",
      "--sandbox", "read-only",
      "--ask-for-approval", "never",
      "--ephemeral"
    ],
    cwd: input.cwd,
    stdin: input.prompt,
    shell: false
  };
}

export function claudeCodeCliCommand(input: AgentPromptInput): AgentCommand {
  return {
    executable: "claude",
    args: [
      "--print",
      "--output-format", "json",
      "--permission-mode", "plan",
      "--safe-mode",
      "--no-chrome",
      "--no-session-persistence",
      "--tools", "",
      "--disallowedTools", "Bash,Edit,Write,NotebookEdit,Agent,Task,WebFetch,WebSearch"
    ],
    cwd: input.cwd,
    stdin: input.prompt,
    shell: false
  };
}

export function grokCliCommand(input: AgentPromptInput): AgentCommand {
  return {
    executable: "grok",
    args: [
      "--output-format", "json",
      "--permission-mode", "plan",
      "--no-subagents",
      "--disable-web-search",
      "--tools=",
      "--no-memory",
      "--prompt-file", AGENT_PROMPT_FILE_ARG
    ],
    cwd: input.cwd,
    stdin: input.prompt,
    promptFileArg: AGENT_PROMPT_FILE_ARG,
    shell: false
  };
}

export function describeAgentSetup(adapter: AgentAdapter): AgentSetupHints {
  return agentSetupHints(adapter, adapter.probeCommand());
}

async function probeAgent(adapter: AgentAdapter, runner: AgentRunner, maxOutputBytes: number): Promise<AgentHealth> {
  const command = { ...adapter.probeCommand(), maxOutputBytes };
  const setup = agentSetupHints(adapter, command);
  const probe = publicCommand(command);
  try {
    const result = boundProcessResult(await runner(command), maxOutputBytes);
    const status = classifyAgentProbe(result);
    const detail = publicHealthDiagnostic(result.stdout || result.stderr || `exit ${result.exitCode}`);
    const redactedStderr = publicHealthDiagnostic(result.stderr);
    return {
      agentId: adapter.id,
      available: status === "ready",
      command: command.executable,
      transport: adapter.transport,
      billing: adapter.billing,
      detail,
      status,
      ...(status === "ready" && detail ? { version: detail } : {}),
      setup,
      probe,
      ...(status === "ready" ? {} : { failure: { exitCode: result.exitCode, ...(redactedStderr ? { stderr: redactedStderr } : {}) } })
    };
  } catch (error) {
    const detail = publicHealthDiagnostic(error instanceof Error ? error.message : String(error));
    const status = classifyAgentProbeError(error);
    return {
      agentId: adapter.id,
      available: false,
      command: command.executable,
      transport: adapter.transport,
      billing: adapter.billing,
      detail,
      status,
      setup,
      probe,
      failure: { stderr: detail }
    };
  }
}

function agentSetupHints(adapter: AgentAdapter, command: AgentCommand): AgentSetupHints {
  const cliName = adapter.label.endsWith("CLI") ? adapter.label : `${adapter.label} CLI`;
  const checkCommand = [command.executable, ...command.args].join(" ");
  return {
    checkCommand,
    installHint: adapter.setup?.installHint ?? `Install ${cliName} and ensure ${command.executable} is on PATH.`,
    authHint: adapter.setup?.authHint ?? `Authenticate ${cliName} with its local login command before running Motion prompts.`,
    quotaHint: adapter.setup?.quotaHint ?? `Check ${cliName} subscription quota or retry after the provider limit resets.`
  };
}

function classifyAgentProbe(result: AgentProcessResult): AgentHealthStatus {
  if (result.exitCode === 0) return "ready";
  const text = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (result.exitCode === AGENT_TIMEOUT_EXIT_CODE || text.includes("timed out")) return "timeout";
  if (result.exitCode === 127 || text.includes("enoent") || text.includes("command not found")) return "missing_binary";
  if (/\b(not logged in|login required|sign in|unauthorized|unauthenticated|auth required|cookie session)\b/.test(text)) return "auth_required";
  if (/\b(too many requests|quota|rate limit|rate-limited|out of host capacity|out of capacity)\b/.test(text)) return "quota_limited";
  return "failed";
}

function classifyAgentProbeError(error: unknown): AgentHealthStatus {
  const err = error as NodeJS.ErrnoException;
  const text = `${err.code ?? ""}\n${error instanceof Error ? error.message : String(error)}`.toLowerCase();
  if (text.includes("enoent") || text.includes("command not found")) return "missing_binary";
  if (text.includes("timed out")) return "timeout";
  if (/\b(not logged in|login required|sign in|unauthorized|unauthenticated|auth required|cookie session)\b/.test(text)) return "auth_required";
  if (/\b(too many requests|quota|rate limit|rate-limited|out of host capacity|out of capacity)\b/.test(text)) return "quota_limited";
  return "failed";
}

function createAgentReceipt(input: {
  adapter: AgentAdapter;
  command: AgentCommand;
  input: RunAgentPromptInput;
  process: AgentProcessResult;
  createdAt: string;
  maxTranscriptBytes: number;
}): AgentReceipt {
  const promptHash = sha256(input.input.prompt);
  const contextHash = sha256(JSON.stringify({
    cwd: input.input.cwd ?? null,
    packageId: input.input.packageId ?? "unknown",
    permission: input.input.permission
  }));
  const status = input.process.exitCode === 0 ? "passed" : "failed";
  const boundedTranscript = publicTranscript(input.process, input.maxTranscriptBytes);
  const warnings = boundedTranscript.stderr ? [boundedTranscript.stderr] : [];
  const transcript: AgentReceipt["output"]["transcript"] = [
    { role: "user", contentSha256: promptHash },
    { role: "agent", content: boundedTranscript.stdout }
  ];
  if (boundedTranscript.stderr) {
    transcript.push({ role: "stderr", content: boundedTranscript.stderr });
  }

  return {
    schema: "shellx-motion/receipt@1",
    id: `agent-${sha256(`${input.adapter.id}:${promptHash}:${input.createdAt}`).slice(0, 16)}`,
    operation: "agent.prompt",
    status,
    packageId: input.input.packageId ?? "unknown",
    inputHashes: {
      prompt: promptHash,
      context: contextHash
    },
    createdAt: input.createdAt,
    lane: "agent",
    output: {
      agentId: input.adapter.id,
      label: input.adapter.label,
      transport: input.adapter.transport,
      billing: input.adapter.billing,
      command: publicCommand(input.command),
      transcript,
      permission: input.input.permission,
      ...(input.process.resources ? { resources: input.process.resources } : {})
    },
    warnings
  };
}

async function spawnAgentCommand(command: AgentCommand): Promise<AgentProcessResult> {
  try {
    const governor = defaultLocalMotionJobGovernor;
    const execution = await governor.run({
      lane: "agent",
      operation: command.args.includes("--version") ? "agent.probe" : "agent.prompt",
      scratchRoot: process.env.SHELLX_MOTION_SCRATCH_ROOT?.trim() || resolve(command.cwd ?? process.cwd(), ".scratch"),
    }, async ({ signal, watchProcess, scratchRoot, reportProcessContainment }) => {
      const prepared = await materializeAgentPromptFile(command, scratchRoot);
      try {
        return await runAgentChild(prepared.command, {
          signal,
          watchProcess,
          scratchRoot,
          reportProcessContainment,
          maxProcessTreeRssBytes: governor.policy.maxProcessTreeRssBytes,
        });
      } finally {
        await prepared.cleanup();
      }
    });
    return { ...execution.value, resources: execution.evidence };
  } catch (error) {
    if (error instanceof LocalMotionJobError) {
      return {
        exitCode: AGENT_RESOURCE_LIMIT_EXIT_CODE,
        stdout: "",
        stderr: error.message,
        resourceErrorCode: error.code,
        ...(error.evidence ? { resources: error.evidence } : {}),
      };
    }
    throw error;
  }
}

interface RunAgentChildOptions {
  signal: AbortSignal;
  watchProcess: (pid: number) => void;
  scratchRoot: string;
  reportProcessContainment: (evidence: LocalMotionProcessContainmentEvidence) => void;
  maxProcessTreeRssBytes: number;
}

async function runAgentChild(command: AgentCommand, options: RunAgentChildOptions): Promise<AgentProcessResult> {
  if (process.platform === "win32") return runWindowsContainedAgentChild(command, options);
  const mode: AgentProcessTerminationMode = process.platform === "linux" || process.platform === "darwin"
    ? "unix-process-group"
    : "direct-child";
  options.reportProcessContainment({
    schema: "shellx-motion/process-containment@1",
    mode,
    status: mode === "unix-process-group" ? "enforced" : "unavailable",
    killTree: mode === "unix-process-group",
    memoryLimit: mode === "unix-process-group" ? "rss-monitor" : "none",
    ...(mode === "direct-child" ? { reasonCode: "unsupported_platform" as const } : {}),
  });
  return runSpawnedAgentChild(command, options.signal, options.watchProcess, () => mode);
}

async function runWindowsContainedAgentChild(command: AgentCommand, options: RunAgentChildOptions): Promise<AgentProcessResult> {
  const requireNative = nativeWindowsJobObjectRequired();
  // Windows launch path: same credential filtering as the POSIX path below. Named `childEnv` rather
  // than shadowing the imported `childEnvironment` helper, which is what builds it.
  const childEnv = childEnvironment({ extra: command.env });
  let resolvedCommand: AgentCommand;
  try {
    resolvedCommand = await resolveNativeWindowsAgentCommand(command, childEnv);
  } catch (error) {
    options.reportProcessContainment(unavailableWindowsContainment("native_setup_failed"));
    return {
      exitCode: 127,
      stdout: "",
      stderr: error instanceof Error ? error.message : "Motion could not resolve a trusted Windows agent executable."
    };
  }
  let plan: WindowsJobObjectLaunchPlan;
  try {
    plan = await createWindowsJobObjectLaunchPlan({
      executable: resolvedCommand.executable,
      args: resolvedCommand.args,
      workingDirectory: resolve(resolvedCommand.cwd ?? process.cwd()),
      scratchRoot: options.scratchRoot,
      maxJobMemoryBytes: options.maxProcessTreeRssBytes,
      maxActiveProcesses: 4_096,
      ...(process.env.SHELLX_MOTION_WINDOWS_JOB_HELPER?.trim()
        ? { helperPath: process.env.SHELLX_MOTION_WINDOWS_JOB_HELPER.trim() }
        : {}),
    });
  } catch (error) {
    const reasonCode = error instanceof WindowsJobObjectPlanError
      ? error.reasonCode
      : "native_setup_failed";
    if (requireNative) {
      options.reportProcessContainment(unavailableWindowsContainment(reasonCode));
      throw new LocalMotionJobError(
        "job_process_containment_unavailable",
        reasonCode === "native_helper_missing"
          ? "Motion requires native Windows Job Object containment, but the trusted launcher is unavailable."
          : "Motion requires native Windows Job Object containment, but agent launch planning failed."
      );
    }
    options.reportProcessContainment(windowsTaskkillFallbackEvidence(reasonCode));
    await revalidateNativeWindowsAgentCommand(resolvedCommand);
    return runSpawnedAgentChild(resolvedCommand, options.signal, options.watchProcess, () => "windows-taskkill-fallback");
  }

  let terminationMode: AgentProcessTerminationMode = "windows-taskkill-fallback";
  const nativeController = new AbortController();
  const relayAbort = () => nativeController.abort(options.signal.reason);
  options.signal.addEventListener("abort", relayAbort, { once: true });
  if (options.signal.aborted) relayAbort();
  await revalidateNativeWindowsAgentCommand(resolvedCommand);
  const nativeCommand: AgentCommand = {
    ...resolvedCommand,
    executable: plan.executable,
    args: plan.args,
    env: resolvedCommand.env,
    // The provider timeout starts after the actual agent child has entered the Job Object.
    timeoutMs: 0,
  };
  const nativeAttempt = runSpawnedAgentChild(
    nativeCommand,
    nativeController.signal,
    options.watchProcess,
    () => terminationMode
  );
  let status: WindowsJobObjectStatus;
  try {
    status = await waitForWindowsJobObjectStatus(plan, { signal: nativeController.signal });
  } catch (error) {
    if (!options.signal.aborted) {
      nativeController.abort(error instanceof Error
        ? error
        : new Error("Motion Windows Job Object helper returned invalid agent status evidence."));
    }
    await nativeAttempt.catch(() => undefined);
    const finalStatus = await waitForWindowsJobObjectStatus(plan, { timeoutMs: 100 }).catch(() => nativeSetupFailedStatus());
    if (options.signal.aborted) {
      options.reportProcessContainment(finalStatus.status === "enforced"
        ? windowsJobObjectContainmentEvidence(plan, finalStatus)
        : windowsTaskkillFallbackEvidence("native_setup_failed", plan.helperSha256));
      await cleanupWindowsJobObjectLaunchPlan(plan);
      options.signal.removeEventListener("abort", relayAbort);
      throw options.signal.reason;
    }
    status = finalStatus;
  }

  if (status.status === "enforced") {
    terminationMode = "windows-job-object";
    options.reportProcessContainment(windowsJobObjectContainmentEvidence(plan, status));
    let providerTimedOut = false;
    const providerTimeoutMs = command.timeoutMs ?? DEFAULT_AGENT_COMMAND_TIMEOUT_MS;
    const providerTimeout = providerTimeoutMs > 0
      ? setTimeout(() => {
          providerTimedOut = true;
          nativeController.abort(new Error(`Agent command timed out after ${providerTimeoutMs}ms.`));
        }, providerTimeoutMs)
      : null;
    providerTimeout?.unref?.();
    try {
      const result = await nativeAttempt;
      const timeoutMessage = `Agent command timed out after ${providerTimeoutMs}ms.`;
      return providerTimedOut
        ? {
            ...result,
            exitCode: AGENT_TIMEOUT_EXIT_CODE,
            stderr: result.stderr.includes(timeoutMessage) ? result.stderr : appendStderr(result.stderr, timeoutMessage),
          }
        : result;
    } finally {
      if (providerTimeout) clearTimeout(providerTimeout);
      options.signal.removeEventListener("abort", relayAbort);
      await cleanupWindowsJobObjectLaunchPlan(plan);
    }
  }

  nativeController.abort(new Error("Motion native Windows Job Object agent setup was unavailable."));
  await nativeAttempt.catch(() => undefined);
  options.signal.removeEventListener("abort", relayAbort);
  await cleanupWindowsJobObjectLaunchPlan(plan);
  if (requireNative) {
    options.reportProcessContainment(windowsJobObjectContainmentEvidence(plan, status));
    throw new LocalMotionJobError(
      "job_process_containment_unavailable",
      "Motion requires native Windows Job Object containment, but agent setup failed."
    );
  }
  options.reportProcessContainment(windowsTaskkillFallbackEvidence("native_setup_failed", plan.helperSha256));
  if (options.signal.aborted) throw options.signal.reason;
  await revalidateNativeWindowsAgentCommand(resolvedCommand);
  return runSpawnedAgentChild(resolvedCommand, options.signal, options.watchProcess, () => "windows-taskkill-fallback");
}

function runSpawnedAgentChild(
  command: AgentCommand,
  signal: AbortSignal,
  watchProcess: (pid: number) => void,
  terminationMode: () => AgentProcessTerminationMode
): Promise<AgentProcessResult> {
  return new Promise((resolveResult) => {
    let child;
    try {
      child = spawn(command.executable, command.args, {
        cwd: command.cwd,
        // The adapters here are the operator's own subscription CLIs (Codex, Claude Code,
        // grok), not third-party binaries -- so this is not a supply-chain exposure. It is still the
        // sharpest case for a full env inherit, for a different reason: these CLIs exist to execute
        // MODEL-AUTHORED commands. A prompt-injected model that can run a shell command can read its
        // own environment, and SHELLX_MOTION_DEBUG_TOKEN in there is authenticated control of the
        // Debug API at the operator's tier. The trust boundary is the model's output, not the vendor.
        //
        // `childEnvironment` strips credential-shaped names; anything an adapter genuinely needs
        // comes through `command.env`, which is applied after redaction.
        env: childEnvironment({ extra: command.env }),
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch (error) {
      const spawnError = error as NodeJS.ErrnoException;
      resolveResult({ exitCode: spawnError.code === "ENOENT" ? 127 : 1, stdout: "", stderr: spawnError.message });
      return;
    }
    if (child.pid) watchProcess(child.pid);
    const ownedUnixProcessGroup = terminationMode() === "unix-process-group"
      ? createOwnedUnixProcessGroup(child.pid)
      : undefined;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let outputOverflow = false;
    let outputBytes = 0;
    let killTimer: NodeJS.Timeout | null = null;
    let groupSettlement: Promise<void> | null = null;
    const timeoutMs = command.timeoutMs ?? DEFAULT_AGENT_COMMAND_TIMEOUT_MS;
    const maxOutputBytes = boundedPositiveInteger(command.maxOutputBytes, DEFAULT_AGENT_OUTPUT_MAX_BYTES, DEFAULT_AGENT_OUTPUT_MAX_BYTES);
    const terminate = () => {
      terminateAgentProcessTree(child, false, terminationMode(), ownedUnixProcessGroup);
      if (!killTimer) {
        killTimer = setTimeout(() => {
          if (!settled) terminateAgentProcessTree(child, true, terminationMode(), ownedUnixProcessGroup);
        }, 100);
        killTimer.unref?.();
      }
    };
    const abortChild = () => {
      stderr = appendStderr(stderr, signal.reason instanceof Error ? signal.reason.message : "Agent job cancelled.");
      terminate();
    };
    signal.addEventListener("abort", abortChild, { once: true });
    if (signal.aborted) abortChild();
    const timeoutTimer = timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          stderr = appendStderr(stderr, `Agent command timed out after ${timeoutMs}ms.`);
          terminate();
        }, timeoutMs)
      : null;
    const finish = (result: AgentProcessResult) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      signal.removeEventListener("abort", abortChild);
      resolveResult(result);
    };
    const settleAfterContainedGroupExit = (result: AgentProcessResult) => {
      if (groupSettlement) return;
      if (!ownedUnixProcessGroup || ownedUnixProcessGroup.presence() === "gone") {
        finish(result);
        return;
      }
      // The agent leader has closed already. Force any orphaned same-group helper immediately;
      // PPID traversal cannot account for its RSS after reparenting.
      terminateAgentProcessTree(child, true, terminationMode(), ownedUnixProcessGroup);
      groupSettlement = ownedUnixProcessGroup.waitForExit(1_500).then((gone) => {
        finish(gone ? result : {
          exitCode: 1,
          stdout: result.stdout,
          stderr: appendStderr(result.stderr, "Motion could not confirm contained Unix process-group cleanup."),
          ...(result.outputOverflow ? { outputOverflow: true } : {})
        });
      });
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const appendOutput = (stream: "stdout" | "stderr", chunk: string) => {
      if (outputOverflow) return;
      const remaining = Math.max(0, maxOutputBytes - outputBytes);
      const bounded = takeUtf8Prefix(chunk, remaining);
      if (stream === "stdout") stdout += bounded.value;
      else stderr += bounded.value;
      outputBytes += Buffer.byteLength(bounded.value);
      if (bounded.truncated) {
        outputOverflow = true;
        stderr = appendStderr(stderr, `Agent command exceeded output limit of ${maxOutputBytes} bytes.`);
        terminate();
      }
    };
    child.stdout.on("data", (chunk) => { appendOutput("stdout", chunk); });
    child.stderr.on("data", (chunk) => { appendOutput("stderr", chunk); });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      stderr = appendStderr(stderr, error.message);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      settleAfterContainedGroupExit({ exitCode: error.code === "ENOENT" ? 127 : 1, stdout, stderr: appendStderr(stderr, error.message) });
    });
    child.on("close", (code) => {
      settleAfterContainedGroupExit({
        exitCode: outputOverflow ? AGENT_OUTPUT_OVERFLOW_EXIT_CODE : timedOut ? AGENT_TIMEOUT_EXIT_CODE : code ?? 1,
        stdout,
        stderr,
        ...(outputOverflow ? { outputOverflow: true } : {})
      });
    });

    if (command.stdin) {
      child.stdin.write(command.stdin, (error?: Error | null) => {
        if (error) stderr = appendStderr(stderr, error.message);
      });
    }
    child.stdin.end();
  });
}

function nativeWindowsJobObjectRequired(): boolean {
  return /^(?:1|true|yes)$/i.test(process.env.SHELLX_MOTION_REQUIRE_NATIVE_WINDOWS_JOB_OBJECT?.trim() ?? "");
}

function unavailableWindowsContainment(
  reasonCode: "native_helper_missing" | "native_setup_failed"
): LocalMotionProcessContainmentEvidence {
  return {
    schema: "shellx-motion/process-containment@1",
    mode: "direct-child",
    status: "unavailable",
    killTree: false,
    memoryLimit: "none",
    reasonCode,
  };
}

function windowsTaskkillFallbackEvidence(
  reasonCode: "native_helper_missing" | "native_setup_failed",
  helperSha256?: string
): LocalMotionProcessContainmentEvidence {
  return {
    schema: "shellx-motion/process-containment@1",
    mode: "windows-taskkill-fallback",
    status: "fallback",
    killTree: true,
    memoryLimit: "rss-monitor",
    reasonCode,
    ...(helperSha256 ? { launcher: { kind: "powershell-csharp" as const, sha256: helperSha256 } } : {}),
  };
}

function nativeSetupFailedStatus(): WindowsJobObjectStatus {
  return {
    schema: "shellx-motion/windows-job-status@1",
    status: "unavailable",
    mode: "windows-job-object",
    reasonCode: "native_setup_failed",
  };
}

function publicCommand(command: AgentCommand): PublicAgentCommand {
  const redactedIndexes = new Set(command.redactedArgIndexes ?? []);
  return {
    executable: command.executable,
    args: command.args.map((arg, index) => redactedIndexes.has(index) ? "<prompt>" : arg),
    cwd: command.cwd,
    shell: command.shell
  };
}

function redactSensitiveText(value: string): string {
  return sanitizeUntrustedDiagnostic(value, {
    rawMaxBytes: AGENT_STRUCTURED_SCALAR_MAX_BYTES,
    publicMaxBytes: AGENT_STRUCTURED_SCALAR_MAX_BYTES
  });
}

export function parseStructuredAgentOutput(stdout: string): unknown {
  const source = stdout.trim();
  if (!source) throw new Error("Agent returned no structured JSON output.");
  try {
    const parsed = JSON.parse(source);
    const nested = nestedAgentJson(parsed);
    return sanitizeStructuredValue(nested === undefined ? parsed : nested);
  } catch (wholeError) {
    const values: unknown[] = [];
    for (const line of source.split(/\r?\n/).filter(Boolean)) {
      try {
        values.push(JSON.parse(line));
      } catch {
        throw new Error(`Agent output must be JSON or JSONL: ${wholeError instanceof Error ? wholeError.message : String(wholeError)}`);
      }
    }
    for (const value of [...values].reverse()) {
      const nested = nestedAgentJson(value);
      if (nested !== undefined) return sanitizeStructuredValue(nested);
    }
    return sanitizeStructuredValue(values);
  }
}

function nestedAgentJson(value: unknown): unknown | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const strings = [
    record.result,
    record.text,
    record.output,
    // Antigravity's `--output-format json` envelope carries the model turn in
    // `response`, the same role `result` plays for Codex/Claude Code.
    record.response,
    record.message && typeof record.message === "object" ? (record.message as Record<string, unknown>).content : undefined,
    record.item && typeof record.item === "object" ? (record.item as Record<string, unknown>).text : undefined
  ];
  for (const candidate of strings) {
    if (typeof candidate !== "string") continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // A transport event may contain human-readable status text; keep looking
      // for the explicit JSON result instead of treating status as authority.
    }
  }
  return undefined;
}

function sanitizeStructuredValue(value: unknown): unknown {
  let nodes = 0;
  const visit = (entry: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > 10_000) throw new Error("Agent structured output exceeds the node limit.");
    if (depth > 32) throw new Error("Agent structured output exceeds the depth limit.");
    if (entry === null || typeof entry === "boolean") return entry;
    if (typeof entry === "number") {
      if (!Number.isFinite(entry)) throw new Error("Agent structured output contains a non-finite number.");
      return entry;
    }
    if (typeof entry === "string") {
      const raw = takeUtf8Prefix(entry, AGENT_STRUCTURED_SCALAR_MAX_BYTES);
      if (raw.truncated) throw new Error("Agent structured output contains an oversized string.");
      return sanitizeUntrustedDiagnostic(raw.value, {
        rawMaxBytes: AGENT_STRUCTURED_SCALAR_MAX_BYTES,
        publicMaxBytes: AGENT_STRUCTURED_SCALAR_MAX_BYTES
      });
    }
    if (Array.isArray(entry)) {
      if (entry.length > 1000) throw new Error("Agent structured output contains an oversized array.");
      return entry.map((item) => visit(item, depth + 1));
    }
    if (!entry || typeof entry !== "object") throw new Error("Agent structured output contains an unsupported value.");
    const record = entry as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length > 256) throw new Error("Agent structured output contains too many object fields.");
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      if (key === "__proto__" || key === "prototype" || key === "constructor") {
        throw new Error(`Agent structured output contains forbidden field '${key}'.`);
      }
      output[key] = /(secret|token|password|api.?key|authorization|cookie)/i.test(key)
        ? "[redacted]"
        : visit(record[key], depth + 1);
    }
    return output;
  };
  return visit(value, 0);
}

function boundProcessResult(result: AgentProcessResult, maxBytes: number): AgentProcessResult {
  const stdoutPrefix = takeUtf8Prefix(result.stdout, maxBytes);
  const stdout = stdoutPrefix.value;
  const remaining = Math.max(0, maxBytes - Buffer.byteLength(stdout));
  const stderrPrefix = takeUtf8Prefix(result.stderr, remaining);
  if (!stdoutPrefix.truncated && !stderrPrefix.truncated && !result.outputOverflow) return result;
  const stderr = appendStderr(
    stderrPrefix.value,
    `Agent command exceeded output limit of ${maxBytes} bytes.`
  );
  return { exitCode: AGENT_OUTPUT_OVERFLOW_EXIT_CODE, stdout, stderr, outputOverflow: true };
}

function publicTranscript(result: AgentProcessResult, maxBytes: number): AgentPublicTranscript {
  const stdoutBudget = Math.floor(maxBytes / 2);
  const stderrBudget = maxBytes - stdoutBudget;
  const stdoutRaw = takeUtf8Prefix(result.stdout, stdoutBudget);
  const stderrRaw = takeUtf8Prefix(result.stderr, stderrBudget);
  const boundedStdout = sanitizeUntrustedDiagnostic(stdoutRaw.value, {
    rawMaxBytes: stdoutBudget,
    publicMaxBytes: stdoutBudget,
    sourceTruncated: stdoutRaw.truncated
  });
  const boundedStderr = sanitizeUntrustedDiagnostic(stderrRaw.value, {
    rawMaxBytes: stderrBudget,
    publicMaxBytes: stderrBudget,
    sourceTruncated: stderrRaw.truncated
  });
  return {
    stdout: boundedStdout,
    stderr: boundedStderr,
    redacted: true,
    truncated: result.outputOverflow === true || stdoutRaw.truncated || stderrRaw.truncated,
    maxBytes
  };
}

function takeUtf8Bytes(value: string, maxBytes: number): string {
  return takeUtf8Prefix(value, maxBytes).value;
}

function boundedPositiveInteger(value: unknown, fallback: number, maximum: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Math.min(Number(value), maximum) : fallback;
}

function publicHealthDiagnostic(value: string): string {
  const raw = takeUtf8Prefix(value, AGENT_HEALTH_DIAGNOSTIC_MAX_BYTES);
  const lineEnd = firstDiagnosticLineEnd(raw.value);
  const line = raw.value.slice(0, lineEnd);
  return sanitizeUntrustedDiagnostic(line, {
    rawMaxBytes: AGENT_HEALTH_DIAGNOSTIC_MAX_BYTES,
    publicMaxBytes: AGENT_HEALTH_DIAGNOSTIC_MAX_BYTES,
    sourceTruncated: raw.truncated && lineEnd === raw.value.length
  }).trim();
}

function firstDiagnosticLineEnd(value: string): number {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 10 || code === 13 || code === 0x2028 || code === 0x2029) return index;
  }
  return value.length;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function appendStderr(stderr: string, message: string): string {
  return stderr ? `${stderr}\n${message}` : message;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
