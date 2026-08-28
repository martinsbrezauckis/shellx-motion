import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isAbsolute, join, resolve } from "node:path";
import type { LocalMotionProcessContainmentEvidence } from "./job-governor";
import { resolveWindowsSystemExecutable, windowsSystemExecutableCandidate } from "./windows-system-executable";

const WINDOWS_JOB_REQUEST_SCHEMA = "shellx-motion/windows-job-request@1" as const;
const WINDOWS_JOB_STATUS_SCHEMA = "shellx-motion/windows-job-status@1" as const;
const WINDOWS_JOB_HELPER_PATH = fileURLToPath(new URL("../assets/windows-job-object-launcher.ps1", import.meta.url));
const MAX_WINDOWS_ARGUMENTS = 8_192;
const MAX_WINDOWS_ARGUMENT_CHARS = 24_000;
const MIN_JOB_MEMORY_BYTES = 64 * 1024 * 1024;
const MAX_JOB_MEMORY_BYTES = 1024 * 1024 * 1024 * 1024;

export interface WindowsJobObjectLaunchPlan {
  executable: string;
  args: string[];
  requestPath: string;
  statusPath: string;
  helperPath: string;
  helperSha256: string;
  maxJobMemoryBytes: number;
  maxActiveProcesses: number;
}

export type WindowsJobObjectStatus =
  | {
      schema: typeof WINDOWS_JOB_STATUS_SCHEMA;
      status: "enforced";
      mode: "windows-job-object";
      childPid: number;
      maxJobMemoryBytes: number;
      maxActiveProcesses: number;
    }
  | {
      schema: typeof WINDOWS_JOB_STATUS_SCHEMA;
      status: "unavailable";
      mode: "windows-job-object";
      reasonCode: "native_setup_failed";
      hresult?: string;
    };

export type WindowsJobObjectPlanFailureCode = "native_helper_missing" | "native_setup_failed";

export class WindowsJobObjectPlanError extends Error {
  readonly reasonCode: WindowsJobObjectPlanFailureCode;

  constructor(reasonCode: WindowsJobObjectPlanFailureCode, message: string) {
    super(message);
    this.name = "WindowsJobObjectPlanError";
    this.reasonCode = reasonCode;
  }
}

/**
 * Stage a shell-free JSON request for the trusted PowerShell/C# host launcher. The already-admitted
 * scratch directory is the only writable control boundary; packages never supply these paths or
 * limits.
 */
export async function createWindowsJobObjectLaunchPlan(input: {
  executable: string;
  args: string[];
  workingDirectory: string;
  scratchRoot: string;
  maxJobMemoryBytes: number;
  maxActiveProcesses?: number;
  helperPath?: string;
}): Promise<WindowsJobObjectLaunchPlan> {
  const helperPath = resolve(input.helperPath ?? WINDOWS_JOB_HELPER_PATH);
  let canonicalHelper: string;
  try {
    canonicalHelper = await realpath(helperPath);
  } catch {
    throw new WindowsJobObjectPlanError(
      "native_helper_missing",
      "Motion Windows Job Object helper is unavailable."
    );
  }

  try {
    const [canonicalExecutable, canonicalWorkingDirectory, canonicalScratchRoot] = await Promise.all([
      realpath(input.executable),
      realpath(input.workingDirectory),
      realpath(input.scratchRoot),
    ]);
    const [helperFacts, executableFacts, workingDirectoryFacts, scratchFacts] = await Promise.all([
      lstat(canonicalHelper), lstat(canonicalExecutable), lstat(canonicalWorkingDirectory), lstat(canonicalScratchRoot)
    ]);
    if (!helperFacts.isFile() || helperFacts.isSymbolicLink() || canonicalHelper !== helperPath) {
      throw new Error("Motion Windows Job Object helper must be one canonical regular file.");
    }
    if (!isAbsolute(input.executable) || !executableFacts.isFile()) {
      throw new Error("Motion Windows Job Object child executable must be an existing absolute file.");
    }
    if (!workingDirectoryFacts.isDirectory() || !scratchFacts.isDirectory()) {
      throw new Error("Motion Windows Job Object working and scratch roots must be existing directories.");
    }
    if (!Array.isArray(input.args) || input.args.length > MAX_WINDOWS_ARGUMENTS || input.args.some((argument) => typeof argument !== "string")) {
      throw new Error(`Motion Windows Job Object arguments exceed the ${MAX_WINDOWS_ARGUMENTS}-argument budget.`);
    }
    const argumentChars = input.args.reduce((total, argument) => total + argument.length, 0);
    if (argumentChars > MAX_WINDOWS_ARGUMENT_CHARS) {
      throw new Error(`Motion Windows Job Object arguments exceed the ${MAX_WINDOWS_ARGUMENT_CHARS}-character budget.`);
    }
    if (!Number.isSafeInteger(input.maxJobMemoryBytes) || input.maxJobMemoryBytes < MIN_JOB_MEMORY_BYTES || input.maxJobMemoryBytes > MAX_JOB_MEMORY_BYTES) {
      throw new Error("Motion Windows Job Object memory limit is invalid.");
    }
    const maxActiveProcesses = input.maxActiveProcesses ?? 4_096;
    if (!Number.isSafeInteger(maxActiveProcesses) || maxActiveProcesses < 1 || maxActiveProcesses > 4_096) {
      throw new Error("Motion Windows Job Object active-process limit is invalid.");
    }

    const identity = randomUUID();
    const requestPath = join(canonicalScratchRoot, `windows-job-${identity}.request.json`);
    const statusPath = join(canonicalScratchRoot, `windows-job-${identity}.status.json`);
    const helperBytes = await readFile(canonicalHelper);
    const helperSha256 = createHash("sha256").update(helperBytes).digest("hex");
    const request = {
      schema: WINDOWS_JOB_REQUEST_SCHEMA,
      executable: canonicalExecutable,
      arguments: [...input.args],
      workingDirectory: canonicalWorkingDirectory,
      statusPath,
      maxJobMemoryBytes: input.maxJobMemoryBytes,
      maxActiveProcesses,
    };
    const launcherExecutable = process.platform === "win32"
      ? resolveWindowsSystemExecutable("powershell")
      : windowsSystemExecutableCandidate("powershell");
    await writeFile(requestPath, `${JSON.stringify(request)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });

    return {
      executable: launcherExecutable,
      args: [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", canonicalHelper, "-RequestPath", requestPath,
      ],
      requestPath,
      statusPath,
      helperPath: canonicalHelper,
      helperSha256,
      maxJobMemoryBytes: input.maxJobMemoryBytes,
      maxActiveProcesses,
    };
  } catch (error) {
    if (error instanceof WindowsJobObjectPlanError) throw error;
    throw new WindowsJobObjectPlanError(
      "native_setup_failed",
      error instanceof Error ? error.message : "Motion Windows Job Object launch planning failed."
    );
  }
}

/** Wait until the suspended child has either entered the Job Object or failed before resume. */
export async function waitForWindowsJobObjectStatus(
  plan: WindowsJobObjectLaunchPlan,
  options: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<WindowsJobObjectStatus> {
  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
  while (Date.now() <= deadline) {
    if (options.signal?.aborted) throw options.signal.reason;
    if (existsSync(plan.statusPath)) {
      const parsed = parseWindowsJobObjectStatus(await readFile(plan.statusPath, "utf8"), plan);
      if (parsed) return parsed;
      throw new Error("Motion Windows Job Object helper wrote invalid status evidence.");
    }
    await abortableDelay(10, options.signal);
  }
  return {
    schema: WINDOWS_JOB_STATUS_SCHEMA,
    status: "unavailable",
    mode: "windows-job-object",
    reasonCode: "native_setup_failed",
  };
}

export function windowsJobObjectContainmentEvidence(
  plan: WindowsJobObjectLaunchPlan,
  status: WindowsJobObjectStatus
): LocalMotionProcessContainmentEvidence {
  if (status.status === "enforced") {
    return {
      schema: "shellx-motion/process-containment@1",
      mode: "windows-job-object",
      status: "enforced",
      killTree: true,
      memoryLimit: "job-commit",
      maxJobMemoryBytes: status.maxJobMemoryBytes,
      maxActiveProcesses: status.maxActiveProcesses,
      launcher: { kind: "powershell-csharp", sha256: plan.helperSha256 },
    };
  }
  return {
    schema: "shellx-motion/process-containment@1",
    mode: "direct-child",
    status: "unavailable",
    killTree: false,
    memoryLimit: "none",
    launcher: { kind: "powershell-csharp", sha256: plan.helperSha256 },
    reasonCode: status.reasonCode,
  };
}

export async function cleanupWindowsJobObjectLaunchPlan(plan: WindowsJobObjectLaunchPlan): Promise<void> {
  await Promise.all([
    rm(plan.requestPath, { force: true }),
    rm(plan.statusPath, { force: true }),
  ]);
}

function parseWindowsJobObjectStatus(raw: string, plan: WindowsJobObjectLaunchPlan): WindowsJobObjectStatus | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, "").trim());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record.schema !== WINDOWS_JOB_STATUS_SCHEMA || record.mode !== "windows-job-object") return null;
  if (record.status === "enforced") {
    const childPid = Number(record.childPid);
    const maxJobMemoryBytes = Number(record.maxJobMemoryBytes);
    const maxActiveProcesses = Number(record.maxActiveProcesses);
    if (
      !Number.isSafeInteger(childPid) || childPid <= 0
      || maxJobMemoryBytes !== plan.maxJobMemoryBytes
      || maxActiveProcesses !== plan.maxActiveProcesses
    ) return null;
    return { schema: WINDOWS_JOB_STATUS_SCHEMA, status: "enforced", mode: "windows-job-object", childPid, maxJobMemoryBytes, maxActiveProcesses };
  }
  if (record.status === "unavailable" && record.reasonCode === "native_setup_failed") {
    const hresult = typeof record.hresult === "string" && /^0x[A-F0-9]{8}$/.test(record.hresult) ? record.hresult : undefined;
    return { schema: WINDOWS_JOB_STATUS_SCHEMA, status: "unavailable", mode: "windows-job-object", reasonCode: "native_setup_failed", ...(hresult ? { hresult } : {}) };
  }
  return null;
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveDelay, rejectDelay) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolveDelay();
    };
    const timer = setTimeout(finish, ms);
    timer.unref?.();
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      rejectDelay(signal?.reason ?? new Error("Motion Windows Job Object status wait was cancelled."));
    };
    if (!signal) return;
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
