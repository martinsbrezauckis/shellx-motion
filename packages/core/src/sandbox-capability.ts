import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { canonicalJsonSha256 } from "./canonical-json";
import type { OperationReceipt } from "./types";

export const LOCAL_MOTION_SANDBOX_CAPABILITY_SCHEMA = "shellx-motion/sandbox-capability@1" as const;

export type LocalMotionSandboxProvider = "linux-bubblewrap" | "macos-sandbox-exec" | "windows-appcontainer" | "unsupported";

export interface LocalMotionSandboxCapabilityReport {
  schema: typeof LOCAL_MOTION_SANDBOX_CAPABILITY_SCHEMA;
  platform: NodeJS.Platform;
  provider: LocalMotionSandboxProvider;
  status: "available" | "unavailable";
  required: false;
  appliedToWorkers: false;
  policy: {
    network: "denied" | "not-probed";
    filesystem: "read-only-host-probe" | "host-default" | "not-probed";
    process: "new-session" | "host-default" | "not-probed";
  };
  executable?: {
    path: string;
    sha256: string;
    versionStatus: "reported" | "not-supported" | "unavailable";
    version?: string;
  };
  probe: {
    kind: "executed" | "not-found" | "not-implemented" | "unsupported-platform";
    exitCode?: number;
    outputSha256?: string;
  };
  reasonCode?: "binary_not_found" | "probe_failed" | "provider_not_implemented" | "unsupported_platform";
  createdAt: string;
}

export interface LocalMotionSandboxProbeServices {
  platform?: NodeJS.Platform;
  locateExecutable?: (provider: Exclude<LocalMotionSandboxProvider, "windows-appcontainer" | "unsupported">) => Promise<{ path: string; sha256: string } | null>;
  runExecutable?: (path: string, args: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  now?: () => string;
}

/**
 * Probe an optional host sandbox by executing one fixed, non-networked no-op policy. Availability is
 * evidence only: normal Motion workers are not silently re-routed through a partially proven profile.
 */
export async function probeLocalMotionSandboxCapability(
  services: LocalMotionSandboxProbeServices = {}
): Promise<LocalMotionSandboxCapabilityReport> {
  const platform = services.platform ?? process.platform;
  const createdAt = services.now?.() ?? new Date().toISOString();
  if (platform === "win32") {
    return unavailableReport({
      platform,
      provider: "windows-appcontainer",
      probe: { kind: "not-implemented" },
      reasonCode: "provider_not_implemented",
      createdAt,
    });
  }
  if (platform !== "linux" && platform !== "darwin") {
    return unavailableReport({
      platform,
      provider: "unsupported",
      probe: { kind: "unsupported-platform" },
      reasonCode: "unsupported_platform",
      createdAt,
    });
  }

  const provider = platform === "linux" ? "linux-bubblewrap" : "macos-sandbox-exec";
  const locateExecutable = services.locateExecutable ?? locateTrustedSandboxExecutable;
  const executable = await locateExecutable(provider);
  if (!executable) {
    return unavailableReport({
      platform,
      provider,
      probe: { kind: "not-found" },
      reasonCode: "binary_not_found",
      createdAt,
    });
  }

  const runExecutable = services.runExecutable ?? runSandboxProbeExecutable;
  const versionResult = provider === "linux-bubblewrap"
    ? await runExecutable(executable.path, ["--version"])
    : null;
  const probeResult = await runExecutable(executable.path, sandboxProbeArgs(provider));
  const combinedOutput = `${versionResult?.stdout ?? ""}\n${versionResult?.stderr ?? ""}\n${probeResult.stdout}\n${probeResult.stderr}`;
  const outputSha256 = createHash("sha256").update(combinedOutput).digest("hex");
  const version = versionResult ? firstBoundedLine(`${versionResult.stdout}\n${versionResult.stderr}`) : undefined;
  if (probeResult.exitCode !== 0 || (versionResult !== null && (versionResult.exitCode !== 0 || !version))) {
    return {
      ...unavailableReport({
        platform,
        provider,
        probe: { kind: "executed", exitCode: probeResult.exitCode, outputSha256 },
        reasonCode: "probe_failed",
        createdAt,
      }),
      executable: {
        ...executable,
        versionStatus: version ? "reported" : provider === "macos-sandbox-exec" ? "not-supported" : "unavailable",
        ...(version ? { version } : {}),
      },
    };
  }

  return {
    schema: LOCAL_MOTION_SANDBOX_CAPABILITY_SCHEMA,
    platform,
    provider,
    status: "available",
    required: false,
    appliedToWorkers: false,
    policy: provider === "linux-bubblewrap"
      ? { network: "denied", filesystem: "read-only-host-probe", process: "new-session" }
      : { network: "denied", filesystem: "host-default", process: "host-default" },
    executable: {
      ...executable,
      versionStatus: version ? "reported" : "not-supported",
      ...(version ? { version } : {}),
    },
    probe: { kind: "executed", exitCode: 0, outputSha256 },
    createdAt,
  };
}

/** Wrap one host capability result in the same durable receipt envelope as other Motion evidence. */
export function createLocalMotionSandboxCapabilityReceipt(
  report: LocalMotionSandboxCapabilityReport
): OperationReceipt {
  // Canonical serialization, not JSON.stringify. `report.executable` is built by spreading a
  // caller-supplied record, so its key order is the caller's insertion order rather than anything
  // fixed by this file — and this hash is both the receipt id and its declared input hash.
  const contentSha256 = canonicalJsonSha256(report);
  return {
    schema: "shellx-motion/receipt@1",
    id: `sandbox-capability-${contentSha256.slice(0, 16)}`,
    operation: "resources.sandbox.probe",
    status: report.status === "available" ? "passed" : "warning",
    packageId: "shellx-motion-host",
    inputHashes: { capability: contentSha256 },
    createdAt: report.createdAt,
    lane: "resources",
    output: report,
    warnings: report.status === "available"
      ? []
      : [`Optional ${report.provider} sandbox capability is unavailable (${report.reasonCode ?? "unknown"}).`],
  };
}

function unavailableReport(input: {
  platform: NodeJS.Platform;
  provider: LocalMotionSandboxProvider;
  probe: LocalMotionSandboxCapabilityReport["probe"];
  reasonCode: NonNullable<LocalMotionSandboxCapabilityReport["reasonCode"]>;
  createdAt: string;
}): LocalMotionSandboxCapabilityReport {
  return {
    schema: LOCAL_MOTION_SANDBOX_CAPABILITY_SCHEMA,
    platform: input.platform,
    provider: input.provider,
    status: "unavailable",
    required: false,
    appliedToWorkers: false,
    policy: { network: "not-probed", filesystem: "not-probed", process: "not-probed" },
    probe: input.probe,
    reasonCode: input.reasonCode,
    createdAt: input.createdAt,
  };
}

async function locateTrustedSandboxExecutable(
  provider: Exclude<LocalMotionSandboxProvider, "windows-appcontainer" | "unsupported">
): Promise<{ path: string; sha256: string } | null> {
  const candidates = provider === "linux-bubblewrap"
    ? ["/usr/bin/bwrap", "/bin/bwrap"]
    : ["/usr/bin/sandbox-exec"];
  for (const candidate of candidates) {
    try {
      const canonical = await realpath(candidate);
      const facts = await lstat(canonical);
      if (!facts.isFile() || facts.isSymbolicLink()) continue;
      const sha256 = createHash("sha256").update(await readFile(canonical)).digest("hex");
      return { path: canonical, sha256 };
    } catch {
      // Optional providers are allowed to be absent; continue through fixed system paths only.
    }
  }
  return null;
}

function runSandboxProbeExecutable(path: string, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolveResult) => {
    execFile(path, args, {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
      timeout: 5_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      const errorCode = (error as { code?: string | number } | null)?.code;
      const code = typeof errorCode === "number"
        ? errorCode
        : error ? 1 : 0;
      resolveResult({ exitCode: code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

function sandboxProbeArgs(provider: LocalMotionSandboxProvider): string[] {
  if (provider === "linux-bubblewrap") {
    return [
      "--ro-bind", "/", "/",
      "--proc", "/proc",
      "--dev", "/dev",
      "--unshare-net",
      "--new-session",
      "--die-with-parent",
      "--", "/bin/true",
    ];
  }
  return ["-p", "(version 1) (allow default) (deny network*)", "/usr/bin/true"];
}

function firstBoundedLine(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => line.replace(/[\u0000-\u001f\u007f]/g, " ").trim())
    .find(Boolean)
    ?.slice(0, 200) ?? "";
}
