import type { LocalMotionRuntimeSandboxEvidence } from "@shellx-motion/core";
import type {
  BrowserFrameOptions,
  BrowserFrameResult,
  BrowserRenderSessionOptions,
  MotionBrowserRenderSession
} from "./index";

export interface InternalBrowserStreamingJobContext {
  readonly admission: "pre-acquired";
  readonly jobId: string;
  readonly scratchRoot: string;
  readonly signal: AbortSignal;
  watchProcess(pid: number): void;
  /**
   * A browser-only streaming owner reports its own sandbox. A GPU-hybrid
   * capture borrows the already-contained GPU browser and therefore leaves
   * sandbox attestation with that runtime rather than manufacturing a second
   * browser-launch claim.
   */
  reportSandbox?(evidence: LocalMotionRuntimeSandboxEvidence): void;
}

export interface InternalBrowserStreamingFrame {
  result: BrowserFrameResult;
  png: Buffer;
}

type InternalBrowserStreamingRender = (
  options: Omit<BrowserFrameOptions, "networkAccess">,
  job: InternalBrowserStreamingJobContext
) => Promise<InternalBrowserStreamingFrame>;

const cacheDisabledSessionOptions = new WeakSet<object>();
const admittedFrameRenders = new WeakMap<object, InternalBrowserStreamingRender>();

export function markBrowserStreamingSessionOptions(options: BrowserRenderSessionOptions): void {
  cacheDisabledSessionOptions.add(options);
}

export function isBrowserStreamingSessionOptions(options: BrowserRenderSessionOptions): boolean {
  return cacheDisabledSessionOptions.has(options);
}

export function registerBrowserStreamingFrameRender(
  session: MotionBrowserRenderSession,
  render: InternalBrowserStreamingRender
): void {
  admittedFrameRenders.set(session, render);
}

export function renderBrowserStreamingFrame(
  session: MotionBrowserRenderSession,
  options: Omit<BrowserFrameOptions, "networkAccess">,
  job: InternalBrowserStreamingJobContext
): Promise<InternalBrowserStreamingFrame> {
  const render = admittedFrameRenders.get(session);
  if (!render) throw new Error("Browser session was not created for internal streamed frame production.");
  return render(options, job);
}
