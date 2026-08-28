import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { unsupportedEnumValue } from "./enum-error.js";
import { nonNegativeNumberArg, stringArg } from "./args.js";
import { dispatchRenderLifecycleReadCommand, type RenderLifecycleReadServices } from "./render-lifecycle-read.js";
import { dispatchRenderJobQueryCommand, type RenderJobQueryServices } from "./render-job-query.js";
import { dispatchRenderLifecycleWriteCommand, type RenderLifecycleWriteServices } from "./render-lifecycle-write.js";
import { dispatchRenderPreviewBasicCommand, type RenderPreviewBasicServices } from "./render-preview-basic.js";
import { dispatchRenderPreviewAdvancedCommand, type RenderPreviewAdvancedServices } from "./render-preview-advanced.js";
import { dispatchRenderQualityPanelCommand, type RenderQualityPanelServices } from "./render-quality-panel.js";
import { dispatchRenderQualityCheckCommand, type RenderQualityCheckServices } from "./render-quality-check.js";
import { dispatchRenderFinalCommand, type RenderFinalServices } from "./render-final.js";
import { dispatchRenderCachePlanCommand, type RenderCachePlanServices } from "./render-cache-plan.js";
import { dispatchRenderBatchCommand, type RenderBatchServices } from "./render-batch.js";
import { dispatchRenderCoordinatorSubmitCommand, type RenderCoordinatorSubmitServices } from "./render-coordinator-submit.js";

export interface RenderDomainServices extends RenderJobQueryServices, RenderLifecycleReadServices, RenderLifecycleWriteServices, RenderPreviewBasicServices, RenderPreviewAdvancedServices, RenderQualityPanelServices, RenderQualityCheckServices, RenderFinalServices, RenderCachePlanServices, RenderBatchServices, RenderCoordinatorSubmitServices {}

export async function dispatchRenderCommand(
  command: MotionDebugCommand,
  args: unknown,
  services: RenderDomainServices = {}
): Promise<MotionDebugResult | null> {
  const coordinatorSubmit = await dispatchRenderCoordinatorSubmitCommand(command, args, services);
  if (coordinatorSubmit) return coordinatorSubmit;
  const jobQuery = await dispatchRenderJobQueryCommand(command, args, services);
  if (jobQuery) return jobQuery;
  const lifecycle = await dispatchRenderLifecycleReadCommand(command, args, services);
  if (lifecycle) return lifecycle;
  const lifecycleWrite = await dispatchRenderLifecycleWriteCommand(command, args, services);
  if (lifecycleWrite) return lifecycleWrite;
  const previewBasic = await dispatchRenderPreviewBasicCommand(command, args, services);
  if (previewBasic) return previewBasic;
  const previewAdvanced = await dispatchRenderPreviewAdvancedCommand(command, args, services);
  if (previewAdvanced) return previewAdvanced;
  const qualityPanel = await dispatchRenderQualityPanelCommand(command, args, services);
  if (qualityPanel) return qualityPanel;
  const qualityCheck = await dispatchRenderQualityCheckCommand(command, args, services);
  if (qualityCheck) return qualityCheck;
  const cachePlan = await dispatchRenderCachePlanCommand(command, args, services);
  if (cachePlan) return cachePlan;
  const finalRender = await dispatchRenderFinalCommand(command, args, services);
  if (finalRender) return finalRender;
  const batchRender = await dispatchRenderBatchCommand(command, args, services);
  if (batchRender) return batchRender;
  // motion.screenshot was removed: Motion is a headless engine with no panel of its own, so it
  // could only ever relay a request to the host and report ok:true for something it could not
  // verify. Use motion.preview.frame or capture-browser, which produce a real image and a receipt.
  return null;
}

function invalidArgs(message: string): MotionDebugResult {
  return { ok: false, error: { code: "invalid_args", message }, warnings: [] };
}
