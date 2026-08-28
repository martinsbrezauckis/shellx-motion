import { matchRendererCapability } from "@shellx-motion/core";
import { createBrowserStreamingFrameProducer, type BrowserStreamingFrameProducer } from "@shellx-motion/renderer-browser";
import { getNativeFrameProducerFailureEvidence, NATIVE_CAPABILITY, nativeTextDeliveryIssues, nativeTextDeliveryMessage, produceNativeFrameStream, type NativeFrameProducerEvidence } from "@shellx-motion/renderer-native";
import type { StreamingFfmpegFinalInput } from "./streaming-foundation-types.js";
import type { RenderStreamingFinalInput } from "./streaming-final-adapter-types.js";

class NativeStreamingTerminalRefusal extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "NativeStreamingTerminalRefusal"; }
}

export function browserProducer(input: RenderStreamingFinalInput, observe: (evidence: BrowserStreamingFrameProducer["evidence"]) => void, failed: (error: unknown) => void): NonNullable<StreamingFfmpegFinalInput["produce"]> {
  const producer = createBrowserStreamingFrameProducer({ pkg: input.pkg, ...(input.toolPolicy?.browser?.workflow ? { workflow: input.toolPolicy.browser.workflow } : {}), ...(input.toolPolicy?.browser?.networkAccess ? { networkAccess: input.toolPolicy.browser.networkAccess } : {}), ...(input.toolPolicy?.browser?.launchBrowser ? { launchBrowser: input.toolPolicy.browser.launchBrowser } : {}), ...(input.toolPolicy?.browser?.sessionFactory ? { sessionFactory: input.toolPolicy.browser.sessionFactory } : {}) });
  return async (sink, context) => await context.runAdmitted(async (job) => {
    try { await producer.produce(sink, job); } catch (error) { failed(error); throw error; } finally { observe(producer.evidence); }
  });
}

export function nativeProducer(input: RenderStreamingFinalInput, observe: (evidence: NativeFrameProducerEvidence) => void, failed: (error: unknown) => void): NonNullable<StreamingFfmpegFinalInput["produce"]> {
  return async (sink, context) => await context.runAdmitted(async (job) => {
    try {
      const now = input.toolPolicy?.native?.now ?? input.now;
      const result = await produceNativeFrameStream({ packageRoot: input.pkg.root, frameCount: Math.ceil((input.pkg.motion.durationMs / 1_000) * input.pkg.motion.fps), fps: input.pkg.motion.fps, durationMs: input.pkg.motion.durationMs, ...(now ? { now } : {}) }, sink, { signal: context.signal, job });
      observe(result.evidence);
      if (!result.ok) throw new NativeStreamingTerminalRefusal(result.error.code, result.error.message);
    } catch (error) {
      const evidence = getNativeFrameProducerFailureEvidence(error);
      if (evidence) observe(evidence);
      failed(error);
      throw error;
    }
  });
}

export function preflightNativeDelivery(input: RenderStreamingFinalInput): { code: string; message: string } | undefined {
  const capability = matchRendererCapability(input.pkg.motion, NATIVE_CAPABILITY);
  if (!capability.ok) {
    const layerCount = new Set(capability.unsupported.map((item) => item.layerId)).size;
    return { code: "unsupported_layer", message: `Native renderer cannot render ${capability.unsupported.length} unsupported ${capability.unsupported.length === 1 ? "feature" : "features"} across ${layerCount} ${layerCount === 1 ? "layer" : "layers"}.` };
  }
  const issues = nativeTextDeliveryIssues(input.pkg.motion);
  return issues.length ? { code: "native_text_not_deliverable", message: nativeTextDeliveryMessage(issues) } : undefined;
}

export function unpreparedGpuProducer(): NonNullable<StreamingFfmpegFinalInput["produce"]> {
  return async () => { throw new Error("GPU streamed final producer was invoked before its admitted resource preparation."); };
}
