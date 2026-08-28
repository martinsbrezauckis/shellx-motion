/** Help/version token recognition and the package-local version banner. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { listMotionExportPresets } from "@shellx-motion/renderer-ffmpeg";

export function isHelpCommand(command: string | undefined): boolean {
  return command === undefined || command === "help" || command === "--help" || command === "-h";
}

/**
 * Whether the token requests the CLI version banner. Kept separate from {@link isHelpCommand} so
 * `--version`/`-v`/`version` return a machine-readable version payload rather than help. This is
 * the verb the Canvas host probes before it calls a renderer-capable Motion root.
 */
export function isVersionCommand(command: string | undefined): boolean {
  return command === "--version" || command === "-v" || command === "version";
}

/**
 * Emit a stable machine-readable version banner. The semver-shaped `version` lets host probes
 * distinguish an installed Motion CLI from an unrelated executable; a missing package manifest
 * degrades to `0.0.0` rather than making the probing command fail.
 */
export function versionCommand(): Record<string, unknown> & { ok: true; command: "version" } {
  return {
    ok: true,
    command: "version",
    name: "@shellx-motion/cli",
    version: cliVersion()
  };
}

/** Static export-preset metadata does not need the main CLI dispatcher. */
export function exportPresetsCommand(): Record<string, unknown> & { ok: true; command: "export-presets" } {
  return {
    ok: true,
    command: "export-presets",
    defaultPreset: "mp4-h264",
    presets: listMotionExportPresets()
  };
}

export function cliVersion(): string {
  return currentCliVersion() ?? "0.0.0";
}

/** The canonical package version when this CLI can read its own package metadata. */
export function currentCliVersion(): string | undefined {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const raw = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: unknown };
    return typeof raw.version === "string" && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(raw.version.trim()) ? raw.version.trim() : undefined;
  } catch {
    return undefined;
  }
}
