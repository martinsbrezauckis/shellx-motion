import { activeScriptLayers, agentScriptExecutionEvidenceForDataOnly, matchRendererCapability, motionBehaviorLaneRefusal, motionLayoutGapAnimationLaneRefusal, motionRelationLaneRefusal, motionScene3DAnimationLaneRefusal, type LocalMotionRuntimeSandboxEvidence } from "@shellx-motion/core";
import { browserTypographyAttestationRefusal, createBrowserStreamingFrameProducer } from "@shellx-motion/renderer-browser";
import { NATIVE_CAPABILITY, nativeTextDeliveryIssues, nativeTextDeliveryMessage, produceNativeFrameStream } from "@shellx-motion/renderer-native";
import { cloneScriptExecutionEvidence } from "./segmented-final-internal/render-segment-producer-evidence.js";
import type { RenderSegmentSpoolTimelineFacts } from "./segmented-final-internal/render-segment-spool-types.js";
import type { RenderSegmentedFinalInput } from "./segmented-final.js";

/** GPU selection is strict; this checks only lane-owned prerequisite facts before any output I/O. */
export function segmentedFrameLaneRefusal(input: RenderSegmentedFinalInput): string | undefined {
  const layoutGapAnimationRefusal = motionLayoutGapAnimationLaneRefusal(input.pkg.motion, input.frameLane === "browser"
    ? "ffmpeg-browser"
    : input.frameLane === "native"
      ? "ffmpeg-native"
      : "ffmpeg-gpu");
  if (layoutGapAnimationRefusal) return layoutGapAnimationRefusal.message;
  const scene3dAnimationRefusal = motionScene3DAnimationLaneRefusal(input.pkg.motion, input.frameLane === "browser"
    ? "ffmpeg-browser"
    : input.frameLane === "native"
      ? "ffmpeg-native"
      : "ffmpeg-gpu");
  if (scene3dAnimationRefusal) return scene3dAnimationRefusal.message;
  if (input.toolPolicy?.browser?.workflow) return "Segmented final delivery does not support captured browser workflows.";
  const relationRefusal = motionRelationLaneRefusal(input.pkg.motion, input.frameLane === "browser"
    ? "ffmpeg-browser"
    : input.frameLane === "native"
      ? "ffmpeg-native"
      : "ffmpeg-gpu");
  if (relationRefusal) return relationRefusal.message;
  if (input.frameLane === "gpu") return undefined;
  const behaviorRefusal = motionBehaviorLaneRefusal(input.pkg.motion, input.frameLane === "browser" ? "ffmpeg-browser" : "ffmpeg-native");
  if (behaviorRefusal) return behaviorRefusal.message;
  if (input.frameLane === "browser") {
    const typography = browserTypographyAttestationRefusal(input.pkg);
    if (typography) return typography.message;
    return activeScriptLayers(input.pkg.motion).length > 0
      && (input.toolPolicy?.browser?.activeScriptSessionAvailable !== true || !input.toolPolicy.browser.sessionFactory)
      ? "Active package scripts require a host-bound browser session with approved-agent authority; segmented delivery was not started."
      : undefined;
  }
  const capability = matchRendererCapability(input.pkg.motion, NATIVE_CAPABILITY);
  if (!capability.ok) return "Native renderer cannot deliver this package without an unsupported-feature fallback.";
  const issues = nativeTextDeliveryIssues(input.pkg.motion);
  return issues.length > 0 ? nativeTextDeliveryMessage(issues) : undefined;
}

/** Returns only the selected lane's producer. GPU never enters a browser/native branch. */
export function createSegmentedRangeProducer(input: RenderSegmentedFinalInput) {
  return ({ range, timeline, frameLane }: { range: { index: number; startFrameIndex: number; endFrameIndexExclusive: number }; timeline: RenderSegmentSpoolTimelineFacts; frameLane: "browser" | "native" | "gpu" }) => {
    if (frameLane === "gpu") {
      throw new Error("GPU segmented range production must be created by the admitted segmented-final host.");
    }
    if (frameLane === "browser") {
      const producer = createBrowserStreamingFrameProducer({
        pkg: input.pkg, range,
        ...(input.toolPolicy?.browser?.networkAccess ? { networkAccess: input.toolPolicy.browser.networkAccess } : {}),
        ...(input.toolPolicy?.browser?.launchBrowser ? { launchBrowser: input.toolPolicy.browser.launchBrowser } : {}),
        ...(input.toolPolicy?.browser?.sessionFactory ? { sessionFactory: input.toolPolicy.browser.sessionFactory } : {})
      });
      return {
        get evidence() {
          const evidence = producer.evidence;
          return evidence.scriptExecution ? { schema: "shellx-motion/segment-range-producer@1" as const, frameLane: "browser" as const, scriptExecution: evidence.scriptExecution, warningUnion: [...evidence.warningUnion], warningsOmitted: evidence.warningsOmitted } : undefined;
        },
        produce: async (sink: { write(frame: { index: number; atMs: number; png: Buffer }): Promise<void> }, job: { admission: "pre-acquired"; jobId: string; scratchRoot: string; signal: AbortSignal; watchProcess(pid: number): void; reportSandbox(evidence: LocalMotionRuntimeSandboxEvidence): void }) => await producer.produce(sink, job)
      };
    }
    return {
      evidence: { schema: "shellx-motion/segment-range-producer@1" as const, frameLane: "native" as const, warningUnion: [], warningsOmitted: 0 },
      produce: async (sink: { write(frame: { index: number; atMs: number; png: Buffer }): Promise<void> }, job: { admission: "pre-acquired"; jobId: string; scratchRoot: string; signal: AbortSignal }) => {
        const result = await produceNativeFrameStream({ packageRoot: input.pkg.root, frameCount: timeline.frameCount, durationMs: timeline.durationMs, fps: timeline.fps, range, ...(input.toolPolicy?.native?.now ? { now: input.toolPolicy.native.now } : {}) }, sink, { signal: job.signal, job });
        if (!result.ok) throw new Error(result.error.message);
      }
    };
  };
}

export async function segmentedProducerFacts(input: RenderSegmentedFinalInput) {
  if (input.frameLane === "gpu") {
    throw new Error("GPU segmented producer facts must be created by the admitted segmented-final host.");
  }
  if (input.frameLane === "native") return { frameLane: "native" as const };
  if (activeScriptLayers(input.pkg.motion).length === 0) return { frameLane: "browser" as const, scriptExecution: agentScriptExecutionEvidenceForDataOnly(input.pkg.motion) };
  const sessionFactory = input.toolPolicy?.browser?.sessionFactory;
  if (!sessionFactory) throw new Error("Active browser segments require a host-bound script-verdict session.");
  const session = await sessionFactory(input.pkg, { ...(input.toolPolicy?.browser?.networkAccess ? { networkAccess: input.toolPolicy.browser.networkAccess } : {}), ...(input.toolPolicy?.browser?.launchBrowser ? { launchBrowser: input.toolPolicy.browser.launchBrowser } : {}) });
  try { return { frameLane: "browser" as const, scriptExecution: cloneScriptExecutionEvidence(session.scriptExecution) }; }
  finally { await session.close(); }
}
