import { childEnvironment } from "@shellx-motion/core";

import { prepareNativePosixAgentCommand, resolveNativePosixAgentCommand } from "./posix-agent-command";
import type {
  AgentAdapter,
  AgentCommand,
  AgentHealth,
  AgentHealthStatus,
  AgentProcessResult,
  AgentRunner,
  AgentSetupHints,
  PublicAgentCommand
} from "./index";

export interface AgentProbeSupport {
  agentSetupHints: (adapter: AgentAdapter, command: AgentCommand) => AgentSetupHints;
  boundProcessResult: (result: AgentProcessResult, maxOutputBytes: number) => AgentProcessResult;
  classifyAgentProbe: (result: AgentProcessResult) => AgentHealthStatus;
  classifyAgentProbeError: (error: unknown) => AgentHealthStatus;
  publicCommand: (command: AgentCommand) => PublicAgentCommand;
  publicHealthDiagnostic: (value: string) => string;
}

interface AgentProbeResult {
  health: AgentHealth;
  command: AgentCommand;
}

/**
 * Health probes prepare and execute the same descriptor-bound provider path
 * that prompts use, keeping provider identity logic out of the runtime facade.
 */
export async function probeAgent(
  adapter: AgentAdapter,
  runner: AgentRunner,
  maxOutputBytes: number,
  support: AgentProbeSupport
): Promise<AgentProbeResult> {
  const declaredCommand = { ...adapter.probeCommand(), maxOutputBytes };
  const setup = support.agentSetupHints(adapter, declaredCommand);
  const probe = support.publicCommand(declaredCommand);
  let command: AgentCommand = declaredCommand;
  try {
    command = await resolvePinnedProviderIdentity(adapter, command);
    const result = support.boundProcessResult(await runPinnedPosixAgentCommand(command, runner), maxOutputBytes);
    const status = support.classifyAgentProbe(result);
    const detail = support.publicHealthDiagnostic(result.stdout || result.stderr || `exit ${result.exitCode}`);
    const redactedStderr = support.publicHealthDiagnostic(result.stderr);
    return {
      command,
      health: {
        agentId: adapter.id,
        available: status === "ready",
        command: declaredCommand.executable,
        transport: adapter.transport,
        billing: adapter.billing,
        detail,
        status,
        ...(status === "ready" && detail ? { version: detail } : {}),
        setup,
        probe,
        ...(status === "ready" ? {} : { failure: { exitCode: result.exitCode, ...(redactedStderr ? { stderr: redactedStderr } : {}) } })
      }
    };
  } catch (error) {
    const detail = support.publicHealthDiagnostic(error instanceof Error ? error.message : String(error));
    const status = support.classifyAgentProbeError(error);
    return {
      command,
      health: {
        agentId: adapter.id,
        available: false,
        command: declaredCommand.executable,
        transport: adapter.transport,
        billing: adapter.billing,
        detail,
        status,
        setup,
        probe,
        failure: { stderr: detail }
      }
    };
  }
}

export function bindPinnedProviderIdentity(
  adapter: AgentAdapter,
  command: AgentCommand,
  probeCommand: AgentCommand
): AgentCommand {
  if (!adapter.pinProviderIdentity || process.platform === "win32") return command;
  const providerIdentity = probeCommand.providerIdentity;
  if (!providerIdentity) throw new Error("Motion could not retain the trusted POSIX agent provider identity.");
  return { ...command, executable: providerIdentity.executable, providerIdentity };
}

export async function runPinnedPosixAgentCommand(command: AgentCommand, runner: AgentRunner): Promise<AgentProcessResult> {
  try {
    const prepared = await prepareNativePosixAgentCommand(command);
    try {
      return await runner(prepared.command);
    } finally {
      await prepared.cleanup();
    }
  } catch (error) {
    return {
      exitCode: 127,
      stdout: "",
      stderr: error instanceof Error ? error.message : "Motion could not prepare the trusted POSIX agent executable."
    };
  }
}

async function resolvePinnedProviderIdentity(adapter: AgentAdapter, command: AgentCommand): Promise<AgentCommand> {
  if (!adapter.pinProviderIdentity || process.platform === "win32") return command;
  return resolveNativePosixAgentCommand(command, childEnvironment({ extra: command.env }));
}
