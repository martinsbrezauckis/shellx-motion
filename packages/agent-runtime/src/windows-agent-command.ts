import { lstat, realpath } from "node:fs/promises";
import { delimiter, extname, isAbsolute, join } from "node:path";
import { resolveWindowsSystemExecutable } from "@shellx-motion/core";

import type { AgentCommand } from "./index";

const WINDOWS_AGENT_SCRIPT_LAUNCH = [
  "$arguments = @(ConvertFrom-Json -InputObject $env:SHELLX_MOTION_PROVIDER_ARGS)",
  "& $env:SHELLX_MOTION_PROVIDER_PATH @arguments",
  "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }"
].join("; ");

export async function resolveNativeWindowsAgentCommand(
  command: AgentCommand,
  environment: NodeJS.ProcessEnv
): Promise<AgentCommand> {
  const executable = await resolveNativeWindowsAgentExecutable(command.executable, environment);
  const extension = extname(executable).toLowerCase();
  if (extension === ".exe" || extension === ".com") return { ...command, executable };
  if (extension !== ".cmd" && extension !== ".bat" && extension !== ".ps1") {
    throw new Error("Motion Windows agent executable must be a canonical .exe, .com, .cmd, .bat, or .ps1 file.");
  }
  const providerEnvironment = Object.fromEntries(Object.entries(command.env ?? {}).filter(([name]) => {
    const normalized = name.toLowerCase();
    return normalized !== "shellx_motion_provider_path" && normalized !== "shellx_motion_provider_args";
  }));
  return {
    ...command,
    executable: resolveWindowsSystemExecutable("powershell"),
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_AGENT_SCRIPT_LAUNCH],
    env: {
      ...providerEnvironment,
      SHELLX_MOTION_PROVIDER_PATH: executable,
      SHELLX_MOTION_PROVIDER_ARGS: JSON.stringify(command.args),
    },
  };
}

async function resolveNativeWindowsAgentExecutable(executable: string, environment: NodeJS.ProcessEnv): Promise<string> {
  if (isAbsolute(executable)) return canonicalWindowsAgentExecutable(executable);
  if (executable.includes("/") || executable.includes("\\")) {
    throw new Error("Motion Windows agent executable must be absolute or selected from the trusted PATH.");
  }
  const pathValue = environment.PATH ?? environment.Path ?? environment.path ?? "";
  const suppliedExtension = extname(executable).toLowerCase();
  const allowedExtensions = new Set([".exe", ".com", ".cmd", ".bat", ".ps1"]);
  if (suppliedExtension && !allowedExtensions.has(suppliedExtension)) {
    throw new Error("Motion Windows agent executable uses an unsupported file type.");
  }
  const nativeExtensions = suppliedExtension
    ? [""]
    : [...new Set([
        ".exe",
        ".com",
        ".cmd",
        ".bat",
        ".ps1",
        ...(environment.PATHEXT ?? environment.Pathext ?? "")
          .split(";")
          .map((value) => value.trim().toLowerCase())
          .filter((value) => allowedExtensions.has(value)),
      ])];
  for (const directory of pathValue.split(delimiter)) {
    const root = directory.trim().replace(/^"|"$/g, "");
    if (!root || !isAbsolute(root)) continue;
    for (const extension of nativeExtensions) {
      const candidate = join(root, `${executable}${extension}`);
      try {
        return await canonicalWindowsAgentExecutable(candidate);
      } catch {
        // Continue through the bounded host PATH search.
      }
    }
  }
  throw new Error(`Motion could not resolve trusted Windows agent executable ${executable}.`);
}

async function canonicalWindowsAgentExecutable(executable: string): Promise<string> {
  const canonical = await realpath(executable);
  if (!isAbsolute(canonical)) throw new Error("Motion Windows agent executable must resolve to an absolute path.");
  const facts = await lstat(canonical);
  if (!facts.isFile() || facts.isSymbolicLink()) throw new Error("Motion Windows agent executable must resolve to a regular file.");
  return canonical;
}

export async function revalidateNativeWindowsAgentCommand(command: AgentCommand): Promise<void> {
  await canonicalWindowsAgentExecutable(command.executable).then((canonical) => {
    if (canonical.toLowerCase() !== command.executable.toLowerCase()) {
      throw new Error("Motion Windows agent launcher identity changed before fallback execution.");
    }
  });
  const providerPath = command.env?.SHELLX_MOTION_PROVIDER_PATH;
  if (!providerPath) return;
  await canonicalWindowsAgentExecutable(providerPath).then((canonical) => {
    if (canonical.toLowerCase() !== providerPath.toLowerCase()) {
      throw new Error("Motion Windows agent provider identity changed before fallback execution.");
    }
  });
}
