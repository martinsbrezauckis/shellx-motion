import { lstat, open, realpath } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";

import type { AgentCommand } from "./index";

export interface NativePosixAgentExecutableIdentity {
  executable: string;
  displayExecutable: string;
  device: number;
  inode: number;
}

/**
 * Resolve a provider name without ever letting a relative or empty PATH entry
 * inherit authority from the agent prompt's working directory.
 */
export async function resolveNativePosixAgentCommand(
  command: AgentCommand,
  environment: NodeJS.ProcessEnv
): Promise<AgentCommand> {
  const resolved = await resolveNativePosixAgentExecutable(command.executable, environment);
  const providerIdentity = { ...resolved, displayExecutable: command.executable };
  return { ...command, executable: providerIdentity.executable, providerIdentity };
}

/**
 * The provider path is bound during health and checked again immediately before
 * spawn. Device/inode make an atomic same-path replacement fail closed too.
 */
export async function revalidateNativePosixAgentCommand(command: AgentCommand): Promise<void> {
  const expected = command.providerIdentity;
  if (!expected) return;
  const actual = await canonicalPosixAgentExecutable(command.executable);
  if (command.executable !== expected.executable
    || actual.executable !== expected.executable
    || actual.device !== expected.device
    || actual.inode !== expected.inode) {
    throw new Error("Motion POSIX agent provider identity changed before execution.");
  }
}

/**
 * Open and validate the exact provider object that will be inherited by the
 * child. This closes the check-then-path-spawn replacement window on POSIX
 * hosts, where the child can execute its inherited descriptor through its
 * descriptor filesystem.
 */
export async function prepareNativePosixAgentCommand(
  command: AgentCommand
): Promise<{ command: AgentCommand; cleanup: () => Promise<void> }> {
  const expected = command.providerIdentity;
  if (!expected || process.platform === "win32") {
    return { command, cleanup: async () => undefined };
  }
  const handle = await open(command.executable, "r");
  try {
    const facts = await handle.stat();
    if (!facts.isFile() || (facts.mode & 0o111) === 0
      || facts.dev !== expected.device || facts.ino !== expected.inode) {
      throw new Error("Motion POSIX agent provider identity changed before execution.");
    }
    return {
      command: { ...command, providerExecutableFd: handle.fd },
      cleanup: async () => { await handle.close(); }
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function resolveNativePosixAgentExecutable(
  executable: string,
  environment: NodeJS.ProcessEnv
): Promise<NativePosixAgentExecutableIdentity> {
  if (isAbsolute(executable)) return canonicalPosixAgentExecutable(executable);
  if (executable.includes("/")) {
    throw new Error("Motion POSIX agent executable must be absolute or selected from an absolute PATH entry.");
  }
  const pathValue = environment.PATH ?? "";
  for (const directory of pathValue.split(delimiter)) {
    // Empty entries and relative entries would make spawn resolve against cwd.
    if (!directory || !isAbsolute(directory)) continue;
    try {
      return await canonicalPosixAgentExecutable(join(directory, executable));
    } catch {
      // Continue through the host's explicit absolute PATH entries.
    }
  }
  throw new Error(`spawn ${executable} ENOENT: Motion could not resolve a trusted POSIX agent executable.`);
}

async function canonicalPosixAgentExecutable(executable: string): Promise<NativePosixAgentExecutableIdentity> {
  const canonical = await realpath(executable);
  if (!isAbsolute(canonical)) throw new Error("Motion POSIX agent executable must resolve to an absolute path.");
  const facts = await lstat(canonical);
  if (!facts.isFile() || facts.isSymbolicLink() || (facts.mode & 0o111) === 0) {
    throw new Error("Motion POSIX agent executable must resolve to an executable regular file.");
  }
  return { executable: canonical, displayExecutable: canonical, device: facts.dev, inode: facts.ino };
}
