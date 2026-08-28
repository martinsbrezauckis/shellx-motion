import { motionCapabilityCatalog, motionRuntimeProbe } from "@shellx-motion/core";
import { MOTION_ENGINE_VERSION } from "@shellx-motion/debug-api";
import { currentCliVersion } from "./cli-command-metadata";
import type { CliResult } from "./main";

/** Read-only, project-free discovery routes that cannot instantiate a connector or renderer. */
export function runtimeProbeCommand(argv: string[]): CliResult {
  if (argv.length > 0) return discoveryInvalidArgs("runtime-probe", "runtime-probe accepts no arguments.");
  const version = currentCliVersion();
  if (!version) return { ok: false, command: "runtime-probe", error: { code: "runtime_identity_unavailable", message: "The CLI package version is unavailable, so runtime-probe refuses to fabricate an engine or distribution identity." } };
  return {
    ok: true,
    command: "runtime-probe",
    // CLI supplies canonical engine/CLI facts; Core stays browser-neutral and never reads a manifest.
    probe: motionRuntimeProbe({ engineVersion: MOTION_ENGINE_VERSION, cliVersion: version, execution: import.meta.url.endsWith(".ts") ? "source" : "packed", platform: process.platform, architecture: process.arch, nodeVersion: process.version })
  };
}

/** MCI-1 catalog lookup is deliberately handled before named connector execution dispatch. */
export function connectorDiscoveryCommand(argv: string[]): CliResult | undefined {
  const [subcommand, ...rest] = argv;
  if (subcommand !== "catalog" && subcommand !== "describe") return undefined;
  if (subcommand === "catalog") return rest.length === 0 ? { ok: true, command: "connector catalog", catalog: motionCapabilityCatalog() } : discoveryInvalidArgs("connector catalog", "connector catalog accepts no arguments.");
  if (rest.length !== 1 || rest[0]!.startsWith("-")) return discoveryInvalidArgs("connector describe", "connector describe requires exactly one capability id.");
  const catalog = motionCapabilityCatalog();
  const descriptor = catalog.descriptors.find((candidate) => candidate.id === rest[0]);
  if (!descriptor) return { ok: false, command: "connector describe", error: { code: "unknown_capability", message: `Unknown connector capability: ${rest[0]}.` } };
  return { ok: true, command: "connector describe", catalog: { schema: catalog.schema, fingerprint: catalog.fingerprint }, descriptor };
}

function discoveryInvalidArgs(command: string, message: string): CliResult {
  return { ok: false, command, error: { code: "invalid_args", message } };
}
