import { lstatSync, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, win32 } from "node:path";

export interface TrustedExecutableResolution {
  executable: string | null;
  problem?: string;
}

/** Resolve one native tool without ever delegating selection to cwd or a relative PATH entry. */
export function resolveTrustedExecutable(options: {
  toolName: string;
  override?: string;
  env?: NodeJS.ProcessEnv;
}): TrustedExecutableResolution {
  const toolName = options.toolName.trim();
  if (!toolName || toolName.includes("\0") || /[\\/]/.test(toolName)) {
    return { executable: null, problem: "Trusted executable tool names must be one bounded file name." };
  }
  const override = options.override?.trim();
  if (override) {
    if (override.includes("\0")) return { executable: null, problem: `${toolName} override must not contain null bytes.` };
    if (!isAbsolute(override)) return { executable: null, problem: `${toolName} override must be an absolute executable path.` };
    const executable = canonicalRegularExecutable(override);
    return executable
      ? { executable }
      : { executable: null, problem: `${toolName} override must name an existing regular executable file.` };
  }

  const fileName = process.platform === "win32" ? `${toolName}.exe` : toolName;
  for (const rawEntry of (options.env ?? process.env).PATH?.split(delimiter) ?? []) {
    const entry = rawEntry.trim().replace(/^"|"$/g, "");
    if (!entry || !isAbsolute(entry)) continue;
    const executable = canonicalRegularExecutable(join(entry, fileName));
    if (executable) return { executable };
  }
  return { executable: null, problem: `No trusted ${fileName} was found on the absolute PATH entries.` };
}

/** Absolute non-existent refusal target; a caller can safely pass it to a diagnostic runner. */
export function missingTrustedExecutableCandidate(toolName: string): string {
  return process.platform === "win32"
    ? win32.join(String.raw`\\?\GLOBALROOT\SystemRoot`, "System32", `${toolName}.exe`)
    : `/__shellx_motion_missing__/${toolName}`;
}

function canonicalRegularExecutable(candidate: string): string | null {
  try {
    const lexical = lstatSync(candidate);
    if (process.platform === "win32" && lexical.isSymbolicLink()) return null;
    const canonical = realpathSync(candidate);
    const target = statSync(canonical);
    if (!isAbsolute(canonical) || !target.isFile()) return null;
    if (process.platform !== "win32" && (target.mode & 0o111) === 0) return null;
    return canonical;
  } catch {
    return null;
  }
}
