/** Shared browser-frame batching and bounded workflow evidence for CLI render delivery paths. */
import type { MotionPackage, OperationReceipt } from "@shellx-motion/core";
import type { BrowserFrameRenderer } from "@shellx-motion/debug-api";
import {
  renderMotionBrowserFrame,
  type BrowserCaptureWorkflow,
  type MotionBrowserRenderSession
} from "@shellx-motion/renderer-browser";
import { throwIfCancelled } from "./render-cancelled";
import type { BrowserWorkflowRenderEvidence } from "./render-receipt-file";

export async function renderBrowserFrameBatch(
  pkg: MotionPackage,
  frames: Array<{ outDir: string; outputPath: string; atMs: number; workflow?: BrowserCaptureWorkflow }>,
  session: MotionBrowserRenderSession | undefined,
  injected: BrowserFrameRenderer | undefined,
  signal: AbortSignal | undefined
): Promise<Awaited<ReturnType<typeof renderMotionBrowserFrame>>[]> {
  if (!injected) return session!.renderFrames(frames, signal ? { signal } : {});
  const results: Awaited<ReturnType<typeof renderMotionBrowserFrame>>[] = [];
  for (const frame of frames) {
    throwIfCancelled(signal, "browser frame rendering");
    results.push(await injected(pkg, frame));
  }
  return results;
}

export function browserWorkflowEvidenceFromFrame(frame: { output?: unknown; receipt?: unknown }): BrowserWorkflowRenderEvidence | undefined {
  const output = record(frame.output);
  const receipt = record(frame.receipt);
  const inputHashes = record(receipt?.inputHashes);
  const workflow = output?.workflow;
  const workflowTrace = output?.workflowTrace;
  const trace = record(workflowTrace);
  const workflowHash = typeof inputHashes?.workflow === "string" ? inputHashes.workflow : typeof trace?.workflowHash === "string" ? trace.workflowHash : undefined;
  if (workflow === undefined && workflowTrace === undefined && !workflowHash) return undefined;
  return { ...(workflow !== undefined ? { workflow } : {}), ...(workflowTrace !== undefined ? { workflowTrace } : {}), ...(workflowHash ? { workflowHash } : {}) };
}

export function enrichRenderReceiptWithBrowserWorkflow(receipt: OperationReceipt, evidence: BrowserWorkflowRenderEvidence | undefined): void {
  if (!evidence) return;
  if (evidence.workflowHash) receipt.inputHashes = { ...receipt.inputHashes, workflow: evidence.workflowHash };
  const output = record(receipt.output) ?? {};
  receipt.output = {
    ...output,
    ...(evidence.workflow !== undefined ? { workflow: evidence.workflow } : {}),
    ...(evidence.workflowTrace !== undefined ? { workflowTrace: evidence.workflowTrace } : {})
  };
}

export function browserWorkflowResultFields(evidence: BrowserWorkflowRenderEvidence | undefined): Record<string, unknown> {
  if (!evidence) return {};
  return { ...(evidence.workflow !== undefined ? { workflow: evidence.workflow } : {}), ...(evidence.workflowTrace !== undefined ? { workflowTrace: evidence.workflowTrace } : {}) };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
