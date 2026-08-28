/** One closed pre-store GPU host verdict; Browser bootstrap remains opaque. */
import { createHash } from "node:crypto";
import {
  canonicalJson,
  hashFile,
  motionBrowserExecutableVerificationProblem,
  resolveMotionBrowserExecutable,
  type LocalMotionJobContext,
  type MotionBrowserExecutableLocation
} from "@shellx-motion/core";
import {
  bootstrapGpuSegmentedHybridAdmission,
  createGpuFrameRenderSession,
  isGpuBrowserProcess,
  isPrecontainedGpuBrowser,
  type GpuSegmentedHybridAdmission,
  type GpuSegmentedHybridPreparation
} from "@shellx-motion/renderer-browser";
import type { PreparedAdmittedGpuDelivery } from "./streaming-final-gpu.js";
import type { SegmentedGpuHostPolicy } from "./segmented-final-gpu-host-types.js";
import type { RenderSegmentGpuContainmentProfile, RenderSegmentGpuHostVerdict } from "./segmented-final-internal/render-segment-store-types.js";

const HOST_VERDICT_SCHEMA = "shellx-motion/gpu-segmented-host-verdict@1" as const;
const SHA256 = /^[a-f0-9]{64}$/;

export async function createClosedSegmentedGpuHostVerdict(input: {
  resources: PreparedAdmittedGpuDelivery;
  location: MotionBrowserExecutableLocation;
  executableSha256: string;
  job: LocalMotionJobContext;
  maxProcessTreeRssBytes: number;
  policy?: SegmentedGpuHostPolicy;
  hybridPreparation?: GpuSegmentedHybridPreparation;
}): Promise<{ verdict: RenderSegmentGpuHostVerdict; hybridAdmission?: GpuSegmentedHybridAdmission }> {
  const openRuntime = input.policy?.openRuntime
    ?? ((images: Parameters<typeof createGpuFrameRenderSession>[0], fonts: Parameters<typeof createGpuFrameRenderSession>[1], options: Parameters<typeof createGpuFrameRenderSession>[2]) => createGpuFrameRenderSession(images, fonts, options));
  input.job.reportSandbox({ schema: "shellx-motion/runtime-sandbox@1", provider: "chromium", status: "requested", scope: "browser-process" });
  const opened = await openRuntime(input.resources.resources.sessionImages, input.resources.resources.sessionFonts, {
    finalBrowser: { scratchRoot: input.job.scratchRoot, maxProcessTreeRssBytes: input.maxProcessTreeRssBytes, signal: input.job.signal },
    browserLocation: input.location,
    ...(input.hybridPreparation ? { dynamicImages: [input.hybridPreparation.dynamicTexture] } : {})
  });
  if (!opened.ok) throw new Error(opened.failure.message);
  let primary: unknown;
  try {
    const runtime = opened.session.runtimeEvidence;
    const browser = opened.session.browserProcess;
    const version = opened.session.browserVersion?.trim();
    if (!runtime || !SHA256.test(runtime.adapterFingerprint) || !version || runtime.browserSource !== input.location.source) {
      throw new Error("GPU segmented delivery could not bind a complete trusted browser/runtime identity.");
    }
    if (!isGpuBrowserProcess(browser) || !isPrecontainedGpuBrowser(browser.containment, browser.pid, input.maxProcessTreeRssBytes)) {
      throw new Error("GPU segmented delivery requires pre-launch Chromium containment before durable identity admission.");
    }
    input.job.watchProcess(browser.pid);
    const verdict: RenderSegmentGpuHostVerdict = Object.freeze({
      schema: HOST_VERDICT_SCHEMA,
      platform: process.platform as RenderSegmentGpuHostVerdict["platform"],
      browser: Object.freeze({ source: input.location.source, executableSha256: input.executableSha256, version }),
      launchProfileSha256: sha256Canonical({ source: input.location.source, sandbox: true, ignoredDefaultArgs: ["--enable-unsafe-swiftshader"], containment: "precontained-direct-chromium" }),
      runtimeEvidenceSha256: sha256Canonical(runtime), adapterFingerprint: runtime.adapterFingerprint,
      containment: hostContainment(browser.containment),
      session: Object.freeze({ purpose: "pre-store-identity", emittedFrames: 0, cleanup: "complete" })
    });
    const hybridAdmission = input.hybridPreparation
      ? await bootstrapGpuSegmentedHybridAdmission({
        preparation: input.hybridPreparation, runtime: opened.session,
        job: { admission: "pre-acquired", scratchRoot: input.job.scratchRoot, maxProcessTreeRssBytes: input.maxProcessTreeRssBytes, signal: input.job.signal, watchProcess: input.job.watchProcess }
      })
      : undefined;
    return Object.freeze({ verdict, ...(hybridAdmission ? { hybridAdmission } : {}) });
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    try {
      await opened.session.close();
    } catch (cleanup) {
      if (primary !== undefined) throw new AggregateError([primary, cleanup], "GPU segmented host bootstrap and browser cleanup both failed.");
      throw new Error("GPU segmented host-identity browser cleanup failed before a durable store could be opened.", { cause: cleanup });
    }
  }
}

export async function assertResolvedSegmentedGpuBrowserIdentity(expected: MotionBrowserExecutableLocation, expectedSha256: string): Promise<void> {
  const current = resolveMotionBrowserExecutable();
  if (current.executable !== expected.executable || current.source !== expected.source
    || motionBrowserExecutableVerificationProblem(current) || await hashFile(current.executable) !== expectedSha256) {
    throw new Error("GPU segmented delivery refused because its trusted Chromium identity changed during pre-store host admission.");
  }
}

function hostContainment(value: import("@shellx-motion/renderer-browser").GpuBrowserProcessTreeContainment): RenderSegmentGpuContainmentProfile {
  if (value.mode === "unix-process-group") return Object.freeze({ mode: value.mode, memoryLimit: value.memoryLimit, maxProcessTreeRssBytes: value.maxProcessTreeRssBytes });
  return Object.freeze({ mode: value.mode, memoryLimit: value.memoryLimit, maxProcessTreeRssBytes: value.maxProcessTreeRssBytes, maxActiveProcesses: value.maxActiveProcesses, launcherSha256: value.launcher.sha256 });
}

function sha256Canonical(value: unknown): string { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }
