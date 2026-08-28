import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertDataOnlyForUntrustedExecution,
  requireEnforcedLinuxBubblewrap,
  UntrustedMotionExecutionRefusal,
  type EnforcedLinuxBubblewrapCapability,
  type EnforcedLinuxBubblewrapServices,
  type LinuxBubblewrapRuntimeSandboxEvidence,
  type MotionDocument,
} from "@shellx-motion/core";

/** Trusted renderer-host policy token. It is never a package or agent command argument. */
export const ENFORCED_UNTRUSTED_BROWSER_EXECUTION = "enforced" as const;

export interface EnforcedUntrustedBrowserLaunchInput {
  motion: Pick<MotionDocument, "layers">;
  packageRoot: string;
  browserExecutable: string;
  chromiumArgs: readonly string[];
  /** True only when the trusted host requested any browser network authority. */
  networkAccessRequested: boolean;
}

export interface EnforcedUntrustedBrowserLaunchServices extends EnforcedLinuxBubblewrapServices {}

interface ExecutableIdentity {
  path: string;
  sha256: string;
}

/** A prepared host launch is intentionally not runtime-enforcement evidence yet. */
export interface EnforcedUntrustedBrowserLaunchEvidence {
  schema: "shellx-motion/runtime-sandbox@1";
  provider: "linux-bubblewrap";
  status: "requested";
  scope: "browser-process";
  launcher: ExecutableIdentity;
  /** Canonical Node interpreter selected from the current trusted host process; its directory pins PATH. */
  interpreter: ExecutableIdentity;
  executable: { path: string; sha256: string; version?: string };
  policy: LinuxBubblewrapRuntimeSandboxEvidence["policy"];
}

export interface EnforcedUntrustedBrowserLaunchPlan {
  /** Fixed repository-owned launcher; never a package executable. */
  executablePath: string;
  /** Chromium argv forwarded by the fixed launcher; never treated as Node eval input. */
  args: string[];
  /** The complete launcher environment: a pinned Node search path and bounded configuration only. */
  env: Record<string, string>;
  evidence: EnforcedUntrustedBrowserLaunchEvidence;
}

const READ_ONLY_RUNTIME_ROOTS = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/opt"] as const;
const LAUNCHER_ENV = "SHELLX_MOTION_ENFORCED_BROWSER_CONFIG";
const LAUNCHER_FILE = "enforced-untrusted-browser-launcher.mjs";

/**
 * Build a fail-closed, repository-owned Bubblewrap launch plan. Playwright receives the fixed
 * launcher while its shebang sees only the canonical current Node directory in PATH; package data
 * can affect neither identity nor Bubblewrap configuration. A plan is only a requested policy:
 * callers promote its evidence after the default Playwright launch successfully connects.
 */
export async function prepareEnforcedUntrustedBrowserLaunch(
  input: EnforcedUntrustedBrowserLaunchInput,
  services: EnforcedUntrustedBrowserLaunchServices = {}
): Promise<EnforcedUntrustedBrowserLaunchPlan> {
  assertDataOnlyForUntrustedExecution(input.motion);
  if (input.networkAccessRequested) {
    throw new UntrustedMotionExecutionRefusal(
      "untrusted_network_configuration_refused",
      "Enforced untrusted execution denies every network namespace and refuses host-approved browser origins."
    );
  }
  if (input.chromiumArgs.includes("--no-sandbox")) {
    throw new UntrustedMotionExecutionRefusal(
      "chromium_sandbox_opt_out_refused",
      "Enforced untrusted execution refuses a Chromium --no-sandbox host opt-out."
    );
  }
  const capability = await requireEnforcedLinuxBubblewrap(services);
  const packageRoot = await canonicalDirectory(input.packageRoot, "Motion package root");
  if (insideAnyRoot(packageRoot, READ_ONLY_RUNTIME_ROOTS)) {
    throw new UntrustedMotionExecutionRefusal(
      "sandbox_unavailable",
      "Enforced untrusted execution requires a package root outside the fixed read-only runtime mounts.",
      { packageRoot }
    );
  }
  const browserExecutable = await canonicalRegularFile(input.browserExecutable, "Chromium executable");
  const launcher = await canonicalExecutable(launcherPath(), "Bubblewrap launcher");
  const interpreter = await canonicalExecutable(process.execPath, "Node interpreter");
  const shebangInterpreter = await canonicalExecutable(
    resolve(dirname(interpreter.path), "node"),
    "Node shebang interpreter"
  );
  if (
    shebangInterpreter.path !== interpreter.path
    || shebangInterpreter.sha256 !== interpreter.sha256
  ) {
    throw new UntrustedMotionExecutionRefusal(
      "sandbox_unavailable",
      "Enforced untrusted execution requires /usr/bin/env node to resolve the current canonical Node interpreter."
    );
  }
  const config = JSON.stringify({
    launcherExecutable: launcher.path,
    launcherSha256: launcher.sha256,
    interpreterExecutable: interpreter.path,
    interpreterSha256: interpreter.sha256,
    bubblewrapExecutable: capability.executable.path,
    bubblewrapSha256: capability.executable.sha256,
    browserExecutable,
    browserRoot: dirname(browserExecutable),
    packageRoot,
  });
  if (Buffer.byteLength(config, "utf8") > 16_384) {
    throw new UntrustedMotionExecutionRefusal(
      "sandbox_unavailable",
      "Enforced untrusted execution launch configuration exceeds its fixed bound."
    );
  }
  return {
    executablePath: launcher.path,
    args: [...input.chromiumArgs],
    env: {
      PATH: dirname(shebangInterpreter.path),
      [LAUNCHER_ENV]: config,
    },
    evidence: requestedRuntimeEvidence(capability, launcher, interpreter),
  };
}

/** Refuse the generic host/test launcher seam when its result could forge enforcement evidence. */
export function assertEnforcedUntrustedBrowserDefaultLaunch(launchBrowser: unknown): void {
  if (launchBrowser === undefined) return;
  throw new UntrustedMotionExecutionRefusal(
    "untrusted_browser_launcher_override_refused",
    "Enforced untrusted execution requires Motion's default Playwright launcher so its runtime evidence cannot be forged."
  );
}

/** Promote a requested, hash-bound plan only after Motion's default Playwright launch succeeds. */
export function promoteEnforcedUntrustedBrowserLaunchEvidence(
  evidence: EnforcedUntrustedBrowserLaunchEvidence
): LinuxBubblewrapRuntimeSandboxEvidence {
  return { ...evidence, status: "enforced" };
}

function requestedRuntimeEvidence(
  capability: EnforcedLinuxBubblewrapCapability,
  launcher: ExecutableIdentity,
  interpreter: ExecutableIdentity
): EnforcedUntrustedBrowserLaunchEvidence {
  return {
    schema: "shellx-motion/runtime-sandbox@1",
    provider: "linux-bubblewrap",
    status: "requested",
    scope: "browser-process",
    executable: { ...capability.executable },
    launcher: { ...launcher },
    interpreter: { ...interpreter },
    policy: {
      network: "denied",
      packageFilesystem: "read-only",
      writableFilesystem: "isolated-tmpfs-root-and-browser-profile",
      process: "new-pid-namespace",
      capabilities: "dropped",
      seccomp: "not-configured",
    },
  };
}

function launcherPath(): string {
  // `src/index.ts` and `dist/index.js` are sibling directories of the same package-local bin/.
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "bin", LAUNCHER_FILE);
}

async function canonicalDirectory(path: string, label: string): Promise<string> {
  const canonical = await realpath(path);
  const facts = await lstat(canonical);
  if (!facts.isDirectory() || facts.isSymbolicLink()) {
    throw new UntrustedMotionExecutionRefusal(
      "sandbox_unavailable",
      `Enforced untrusted execution requires a canonical ${label}.`,
      { path }
    );
  }
  return canonical;
}

async function canonicalRegularFile(path: string, label: string): Promise<string> {
  const canonical = await realpath(path);
  const facts = await lstat(canonical);
  if (!facts.isFile() || facts.isSymbolicLink()) {
    throw new UntrustedMotionExecutionRefusal(
      "sandbox_unavailable",
      `Enforced untrusted execution requires a canonical ${label}.`,
      { path }
    );
  }
  return canonical;
}

async function canonicalExecutable(path: string, label: string): Promise<ExecutableIdentity> {
  const canonical = await canonicalRegularFile(path, label);
  const facts = await lstat(canonical);
  if ((facts.mode & 0o111) === 0) {
    throw new UntrustedMotionExecutionRefusal(
      "sandbox_unavailable",
      `Enforced untrusted execution requires an executable ${label}.`,
      { path }
    );
  }
  return {
    path: canonical,
    sha256: createHash("sha256").update(await readFile(canonical)).digest("hex"),
  };
}

function insideAnyRoot(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => path === root || path.startsWith(`${root}/`));
}
