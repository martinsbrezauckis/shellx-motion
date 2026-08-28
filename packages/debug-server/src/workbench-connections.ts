import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { untrustedExecutableFileReason } from "@shellx-motion/core";
import { workbenchChildEnvironment } from "./workbench-child-environment.js";
import { resolveWorkbenchSystemExecutable } from "./workbench-system-executable.js";

const execFileAsync = promisify(execFile);

export type MotionAgentProvider = "codex" | "claude" | "grok";

export interface MotionAgentConfigurationResult {
  provider: MotionAgentProvider;
  configured: true;
  alreadyConfigured: boolean;
}

export interface MotionAgentBridge {
  command: string;
  args: string[];
}

export type MotionAgentConfigurator = (
  provider: MotionAgentProvider,
  bridge: MotionAgentBridge
) => Promise<MotionAgentConfigurationResult>;

export interface MotionAgentProviderLaunch {
  executable: string;
  args: string[];
  env: Record<string, string>;
}

/** Test seam for the bounded provider child. Production always uses {@link runMotionAgentProvider}. */
export interface MotionAgentConfigurationDependencies {
  source?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  run?: (launch: MotionAgentProviderLaunch) => Promise<void>;
}

const PROVIDER_ARGS: Record<MotionAgentProvider, (bridge: MotionAgentBridge) => string[]> = {
  codex: (bridge) => ["mcp", "add", "shellx-motion", "--", bridge.command, ...bridge.args],
  claude: (bridge) => ["mcp", "add", "--scope", "user", "shellx-motion", "--", bridge.command, ...bridge.args],
  grok: (bridge) => ["mcp", "add", "--scope", "user", "shellx-motion", "--", bridge.command, ...bridge.args]
};

class ProviderExecutableUnavailableError extends Error {}

export function readMotionAgentProvider(value: unknown): MotionAgentProvider | null {
  return value === "codex" || value === "claude" || value === "grok" ? value : null;
}

export function buildMotionAgentConnectionState(baseUrl: URL) {
  const bridgeCommand = "shellx-motion-mcp";
  return {
    ok: true,
    mcpUrl: new URL("/rpc", baseUrl).toString(),
    debugApiUrl: new URL("/debug", baseUrl).toString(),
    setupCommands: {
      codex: formatSetupCommand(["codex", "mcp", "add", "shellx-motion", "--", bridgeCommand]),
      claude: formatSetupCommand(["claude", "mcp", "add", "--scope", "user", "shellx-motion", "--", bridgeCommand]),
      grok: formatSetupCommand(["grok", "mcp", "add", "--scope", "user", "shellx-motion", "--", bridgeCommand]),
      generic: bridgeCommand
    }
  };
}

export async function runMotionAgentConfiguration(
  providerValue: unknown,
  bridge: MotionAgentBridge,
  configurator: MotionAgentConfigurator
): Promise<
  | { ok: true; result: MotionAgentConfigurationResult }
  | { ok: false; status: 400 | 409; code: string; message: string }
> {
  const provider = readMotionAgentProvider(providerValue);
  if (!provider) return { ok: false, status: 400, code: "invalid_provider", message: "Choose Codex, Claude Code, or Grok." };
  try {
    return { ok: true, result: await configurator(provider, bridge) };
  } catch (error) {
    return {
      ok: false,
      status: 409,
      code: "provider_configuration_failed",
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Configure an allowlisted provider without reading, copying, or otherwise touching its credential
 * material. The provider CLI performs its own documented configuration operation in place; Motion
 * only selects a trusted executable and passes the non-secret MCP bridge arguments.
 */
export async function configureMotionAgent(
  provider: MotionAgentProvider,
  bridge: MotionAgentBridge,
  dependencies: MotionAgentConfigurationDependencies = {}
): Promise<MotionAgentConfigurationResult> {
  const source = dependencies.source ?? process.env;
  const platform = dependencies.platform ?? process.platform;
  const environment = workbenchChildEnvironment(source);
  const args = PROVIDER_ARGS[provider](bridge);
  try {
    const executable = await resolveMotionAgentProviderExecutable(provider, environment, platform);
    // Resolve and inspect once to select the host-approved binary, then repeat the full policy
    // immediately before execution. A changed link/file/path between those steps fails closed.
    await revalidateMotionAgentProviderExecutable(executable, platform);
    const launch = { executable, args, env: environment };
    await (dependencies.run ?? ((value) => runMotionAgentProvider(value, platform)))(launch);
    return { provider, configured: true, alreadyConfigured: false };
  } catch (error) {
    if (error instanceof ProviderExecutableUnavailableError
      || (error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
      throw new Error(`${providerLabel(provider)} is not installed or cannot be approved by the local host policy.`);
    }
    const stderr = error && typeof error === "object" && "stderr" in error && typeof error.stderr === "string"
      ? cleanProviderMessage(error.stderr)
      : "";
    if (/already exists|already configured|duplicate/i.test(stderr)) {
      return { provider, configured: true, alreadyConfigured: true };
    }
    throw new Error(stderr || `${providerLabel(provider)} could not add the ShellX Motion MCP connection.`);
  }
}

/**
 * Select the first canonical, absolute and host-approved provider executable from the filtered
 * host PATH. A bare provider name is never passed to a child process, avoiding a second implicit
 * PATH lookup in a potentially different environment.
 */
export async function resolveMotionAgentProviderExecutable(
  provider: MotionAgentProvider,
  environment: NodeJS.ProcessEnv = workbenchChildEnvironment(),
  platform: NodeJS.Platform = process.platform
): Promise<string> {
  const pathValue = environment.PATH ?? environment.Path ?? environment.path ?? "";
  const extensions = platform === "win32"
    ? [".exe", ".com", ".cmd", ".bat", ".ps1"]
    : [""];
  for (const rawDirectory of pathValue.split(delimiter)) {
    const directory = rawDirectory.trim().replace(/^"|"$/g, "");
    if (!directory || !isAbsolute(directory)) continue;
    for (const extension of extensions) {
      const candidate = join(directory, `${provider}${extension}`);
      try {
        // A launcher may be a trusted package-manager symlink. It is never executed by that name:
        // resolve it to a canonical target, validate that target, then execute the target directly.
        const original = await lstat(candidate);
        if (!original.isFile() && !original.isSymbolicLink()) continue;
        const canonical = await realpath(candidate);
        if (!isAbsolute(canonical)) continue;
        await revalidateMotionAgentProviderExecutable(canonical, platform);
        return canonical;
      } catch {
        // Search the next host PATH candidate. The public Workbench state intentionally does not
        // expose absolute executable locations or filesystem-policy diagnostics.
      }
    }
  }
  throw new ProviderExecutableUnavailableError();
}

async function revalidateMotionAgentProviderExecutable(executable: string, platform: NodeJS.Platform): Promise<void> {
  if (!isAbsolute(executable)) throw new ProviderExecutableUnavailableError();
  const original = await lstat(executable);
  if (!original.isFile() || original.isSymbolicLink()) throw new ProviderExecutableUnavailableError();
  const canonical = await realpath(executable);
  if (canonical !== executable) throw new ProviderExecutableUnavailableError();
  if (platform !== "win32") {
    const reason = untrustedExecutableFileReason(executable);
    if (reason) throw new ProviderExecutableUnavailableError();
  }
}

async function runMotionAgentProvider(launch: MotionAgentProviderLaunch, platform: NodeJS.Platform): Promise<void> {
  if (platform === "win32") {
    await runWindowsProvider(launch);
    return;
  }
  await execFileAsync(launch.executable, launch.args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 1_000_000,
    env: launch.env
  });
}

async function runWindowsProvider(launch: MotionAgentProviderLaunch): Promise<void> {
  const powershell = await resolveWindowsPowerShellExecutable();
  const script = [
    "$arguments = @(ConvertFrom-Json -InputObject $env:SHELLX_MOTION_PROVIDER_ARGS)",
    "& $env:SHELLX_MOTION_PROVIDER_PATH @arguments",
    "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }"
  ].join("; ");
  await execFileAsync(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 1_000_000,
    env: {
      ...launch.env,
      SHELLX_MOTION_PROVIDER_PATH: launch.executable,
      SHELLX_MOTION_PROVIDER_ARGS: JSON.stringify(launch.args)
    }
  });
}

/** Resolve the fixed Windows PowerShell host used only to launch an admitted provider executable. */
export async function resolveWindowsPowerShellExecutable(): Promise<string> {
  try {
    return await resolveWorkbenchSystemExecutable("windows-powershell");
  } catch {
    throw new ProviderExecutableUnavailableError();
  }
}

function providerLabel(provider: MotionAgentProvider): string {
  return provider === "codex" ? "Codex" : provider === "claude" ? "Claude Code" : "Grok";
}

function cleanProviderMessage(value: string): string {
  return value
    .replace(/\b(?:Authorization\s*:\s*)?Bearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Authorization: Bearer [redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function formatSetupCommand(argv: string[]): string {
  return argv.map((value) => process.platform === "win32" ? quotePowerShellArg(value) : quotePosixArg(value)).join(" ");
}

function quotePowerShellArg(value: string): string {
  return /^[A-Za-z0-9_./:@=-]+$/.test(value) ? value : `'${value.replace(/'/g, "''")}'`;
}

function quotePosixArg(value: string): string {
  return /^[A-Za-z0-9_./:@=-]+$/.test(value) ? value : `'${value.replace(/'/g, `'"'"'`)}'`;
}
