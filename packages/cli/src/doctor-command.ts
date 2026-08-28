/**
 * `shellx-motion doctor` — is this machine able to render, and if not, what is missing?
 *
 * Role: Motion depends on external programs it does not ship. When FFmpeg is absent every final
 * render fails with `spawn ffmpeg ENOENT`, which is accurate and useless to someone who does not
 * know FFmpeg is a prerequisite. ShellX Cut hit this with new users, who concluded the product was
 * broken when a single missing binary was the entire problem.
 *
 * This is the command that answers it directly, before anything is rendered. It reports what each
 * tool is needed FOR, so a user who only wants preview frames learns they are already fine, and it
 * prints commands that can be pasted rather than telling them to go and find an installer.
 *
 * It DERIVES NOTHING ITSELF. The answer comes from `checkMotionPlatformRequirements` in
 * `@shellx-motion/renderer-ffmpeg`, the same call the `motion.platform.requirements` debug/MCP
 * command makes, and both return that result unchanged. Before the readiness-parity invariant this command
 * decided for itself: it returned `{ ok:false, checks, missingCount }` with no `satisfied` field
 * while MCP returned `ok:true` with `result.satisfied:false`, and the published Cut integration
 * spec promised they matched. Two surfaces answering the same question differently is worse than
 * either answer.
 *
 * `ok` reports whether the PROBE ran, not whether the machine is ready — `satisfied` is the
 * capability answer. The previous conflation made "FFmpeg is missing" look like "doctor failed",
 * which is precisely the report a user cannot act on.
 *
 * `satisfied` answers about the DEFAULT invocation, and that is load-bearing for `render.final`:
 * `render` rasterizes in a Chrome/Chromium that Motion does not ship unless `--frame-lane native`
 * is passed, so a machine with FFmpeg and no browser is reported NOT satisfied — a plain `render`
 * there really does fail, and this command is the pre-flight that has to say so. It does not
 * overshoot into "cannot render" either: the operation carries `possible: true` and an
 * `alternative` naming the flag, and the printed report puts that flag beside the "NO". The model
 * lives in `platform-operations.ts`; nothing about the distinction is decided here.
 *
 * Dependencies: `@shellx-motion/renderer-ffmpeg` for the shared probe and the rendered report.
 * Primary caller: the command dispatch in `main.ts`.
 */
import { randomUUID } from "node:crypto";
import { readdir, rmdir } from "node:fs/promises";
import { join } from "node:path";
import {
  defaultLocalMotionJobGovernor,
  localMotionJobPolicyFromEnvironment,
  OutputDirectoryReservation,
  type LocalMotionJobContext
} from "@shellx-motion/core";
import {
  checkMotionPlatformRequirements,
  motionOperationReadiness,
  motionRequirementsReport,
  MOTION_REQUIREMENT_OPERATIONS,
  type FfmpegRunner,
  type MotionRequirementOperation
} from "@shellx-motion/renderer-ffmpeg";
import {
  assessGpuHardwareReadiness,
  gpuBrowserProcessContainmentEvidence,
  isGpuBrowserProcess,
  isPrecontainedGpuBrowser,
  runGpuActiveHardwareProbe,
  type GpuActiveHardwareProbeResult,
  type GpuActiveHostProof,
  type GpuBrowserProcessTreeContainment
} from "@shellx-motion/renderer-browser";

type DoctorResult = Record<string, unknown> & { ok: boolean; command?: string };

export interface DoctorCommandOptions {
  /** Test seam applied to every tool probe; production spawns the real binaries. */
  ffmpegRunner?: FfmpegRunner;
  /**
   * Host/test-only active WebGPU proof. CLI arguments cannot supply this: a
   * caller must not turn an old receipt into a hardware-ready claim.
   */
  gpuHardwareProof?: GpuActiveHostProof;
  /** Test/embedding seam for the explicit `--probe-gpu` operation. Never CLI input. */
  gpuHardwareProbeRunner?: () => Promise<GpuActiveHardwareProbeResult>;
  /** CLI/embedding-owned scratch base; command arguments never choose it. */
  scratchRoot?: string;
  signal?: AbortSignal;
}

/** `shellx-motion doctor [--json] [--operation render.final] [--probe-gpu]` */
export async function doctorCommand(argv: string[], options: DoctorCommandOptions = {}): Promise<DoctorResult> {
  const operation = readOperation(argv);
  if (operation && !MOTION_REQUIREMENT_OPERATIONS.includes(operation)) {
    return {
      ok: false,
      command: "doctor",
      error: {
        code: "invalid_args",
        message: `Unknown operation ${JSON.stringify(operation)}. Expected one of: ${MOTION_REQUIREMENT_OPERATIONS.join(", ")}.`
      }
    };
  }

  const requirements = await checkMotionPlatformRequirements(options.ffmpegRunner ? { runner: options.ffmpegRunner } : {});
  const chromium = requirements.tools.find((tool) => tool.tool === "chromium");
  // This is explicitly opt-in. The ordinary doctor path above and below stays
  // source-only with respect to WebGPU: no adapter request, GPU frame, or
  // active proof occurs unless the operator supplied `--probe-gpu`.
  const gpuProbe = argv.includes("--probe-gpu")
    ? await (options.gpuHardwareProbeRunner ?? (() => runGovernedCliGpuHardwareProbe(options)))()
    : undefined;
  const activeHostProof = gpuProbe?.ok ? gpuProbe.proof : options.gpuHardwareProof;
  // This is deliberately source-only. The readiness assessor opens no browser
  // or adapter; it reports a fresh host proof only when one was injected by a
  // trusted embedding host before this command was called.
  const gpu = await assessGpuHardwareReadiness({
    chromium: chromium ?? { status: "unverified", source: "path" },
    ...(activeHostProof ? { activeHostProof } : {})
  });
  // Asking about ONE operation narrows `satisfied` to that operation, so an agent about to draw a
  // preview is not told "not ready" because a tool it does not need is absent.
  const scoped = operation ? motionOperationReadiness(requirements, operation) : undefined;
  const satisfied = scoped ? scoped.satisfied : requirements.satisfied;

  const base = {
    // `ok` is "did the probe run", never "is the machine ready".
    ok: true,
    command: "doctor",
    satisfied,
    missingCount: requirements.missingCount,
    requirements,
    gpu,
    ...(gpuProbe ? { gpuProbe } : {}),
    ...(scoped ? { operation: scoped } : {}),
    // Retained under its historical name so hosts pinned to the pre-the readiness-parity invariant CLI shape keep working;
    // it is the same array as `requirements.tools`, not a second derivation.
    checks: requirements.tools
  };

  // `--json` for a host reading this programmatically; the default is written for a person.
  if (argv.includes("--json")) return base;

  const closing = satisfied
    ? scoped
      ? `\n\n${scoped.operation} can run on this machine.`
      : "\n\nEverything Motion needs is present. `shellx-motion render --lane ffmpeg` will work."
    : `\n\n${requirements.missingCount} requirement(s) missing. Authoring and preview frames still work; see the list above for what does not.`;
  return { ...base, report: `${motionRequirementsReport(requirements)}${closing}` };
}

/**
 * CLI-owned admission for the explicit probe. The renderer receives only this
 * exact newly reserved child and leaves it to us; removal is non-recursive
 * after Chrome's profile teardown, never a cleanup of the caller's root.
 */
async function runGovernedCliGpuHardwareProbe(options: DoctorCommandOptions): Promise<GpuActiveHardwareProbeResult> {
  try {
    const policy = localMotionJobPolicyFromEnvironment();
    const execution = await defaultLocalMotionJobGovernor.run({
      lane: "gpu",
      operation: "gpu.hardware.probe",
      scratchRoot: gpuProbeScratchRoot(options.scratchRoot),
      ...(options.signal ? { signal: options.signal } : {}),
      policy: { maxProcessTreeRssBytes: policy.maxProcessTreeRssBytes }
    }, async (job) => {
      const authority = await OutputDirectoryReservation.acquire(join(job.scratchRoot, `gpu-hardware-probe-${randomUUID()}`), { requireAbsent: true });
      try {
        return await runGpuActiveHardwareProbe({
          scratchRoot: authority.path,
          scratchAuthority: authority,
          maxProcessTreeRssBytes: policy.maxProcessTreeRssBytes,
          signal: job.signal,
          onBrowserProcess: (browser) => reportGpuProbeBrowser(job, browser, policy.maxProcessTreeRssBytes)
        });
      } finally {
        await removeOwnedEmptyProbeScratch(authority);
      }
    });
    return execution.value;
  } catch {
    return { ok: false, failure: { code: "gpu_browser_launch_failed", message: "Motion could not establish an admitted host-owned scratch child for the GPU hardware probe." } };
  }
}

/** Keep the explicit probe on the same host-owned scratch authority as render jobs. */
export function gpuProbeScratchRoot(option: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  return option ?? (env.SHELLX_MOTION_SCRATCH_ROOT?.trim() || ".scratch");
}

function reportGpuProbeBrowser(
  job: LocalMotionJobContext,
  browser: {
    pid: number;
    launcher: "playwright-launch-server" | "precontained-direct-chromium";
    containment: GpuBrowserProcessTreeContainment | null;
  },
  maxProcessTreeRssBytes: number
): void {
  const containment = browser.containment;
  if (!isGpuBrowserProcess(browser)
    || !isPrecontainedGpuBrowser(containment, browser.pid, maxProcessTreeRssBytes)) {
    throw new Error("GPU hardware probe did not expose enforced pre-launch containment.");
  }
  job.watchProcess(browser.pid);
  job.reportProcessContainment(gpuBrowserProcessContainmentEvidence(containment));
}

async function removeOwnedEmptyProbeScratch(authority: OutputDirectoryReservation): Promise<void> {
  await authority.assertCurrent();
  if ((await readdir(authority.path)).length !== 0) {
    throw new Error("GPU hardware probe scratch still contains files; Motion will not remove it recursively.");
  }
  await rmdir(authority.path);
}

/** Read `--operation <name>`; undefined asks about the whole machine. */
function readOperation(argv: string[]): MotionRequirementOperation | undefined {
  const index = argv.indexOf("--operation");
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value ? (value as MotionRequirementOperation) : undefined;
}
