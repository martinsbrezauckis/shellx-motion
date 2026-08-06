import { execFile } from "node:child_process";
import { promisify } from "node:util";

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

const PROVIDER_ARGS: Record<MotionAgentProvider, (bridge: MotionAgentBridge) => string[]> = {
  codex: (bridge) => ["mcp", "add", "shellx-motion", "--", bridge.command, ...bridge.args],
  claude: (bridge) => ["mcp", "add", "--scope", "user", "shellx-motion", "--", bridge.command, ...bridge.args],
  grok: (bridge) => ["mcp", "add", "--scope", "user", "shellx-motion", "--", bridge.command, ...bridge.args]
};

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

export const configureMotionAgent: MotionAgentConfigurator = async (provider, bridge) => {
  const args = PROVIDER_ARGS[provider](bridge);
  try {
    if (process.platform === "win32") await runWindowsProvider(provider, args);
    else await execFileAsync(provider, args, { encoding: "utf8", windowsHide: true, timeout: 30_000, maxBuffer: 1_000_000 });
    return { provider, configured: true, alreadyConfigured: false };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    if (code === "ENOENT") {
      throw new Error(`${providerLabel(provider)} is not installed or is not available on PATH.`);
    }
    const stderr = error && typeof error === "object" && "stderr" in error && typeof error.stderr === "string"
      ? cleanProviderMessage(error.stderr)
      : "";
    if (/already exists|already configured|duplicate/i.test(stderr)) {
      return { provider, configured: true, alreadyConfigured: true };
    }
    throw new Error(stderr || `${providerLabel(provider)} could not add the ShellX Motion MCP connection.`);
  }
};

async function runWindowsProvider(provider: MotionAgentProvider, args: string[]): Promise<void> {
  const script = [
    "$command = Get-Command -Name $env:SHELLX_MOTION_PROVIDER -ErrorAction Stop",
    "$arguments = @(ConvertFrom-Json -InputObject $env:SHELLX_MOTION_PROVIDER_ARGS)",
    "& $command.Source @arguments",
    "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }"
  ].join("; ");
  await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 1_000_000,
    env: {
      ...process.env,
      SHELLX_MOTION_PROVIDER: provider,
      SHELLX_MOTION_PROVIDER_ARGS: JSON.stringify(args)
    }
  });
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
