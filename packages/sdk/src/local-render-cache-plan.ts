/** Local SDK bridge for the non-mutating Debug v2 render-cache observation. */
import { dispatchDebugCommand } from "@shellx-motion/debug-api";
import { dirname, resolve } from "node:path";
import { localDebugContext } from "./local-debug-context";
import { LocalMotionSdkError } from "./local-result";
import { renderCachePlanDebugArgs, renderCachePlanRequestError, validRenderCachePlanOutput } from "./render-cache-plan-client";
import type { MotionSdkRenderCachePlanRequest, MotionSdkRenderCachePlanResponse } from "./render-cache-plan-types";
import type { LocalMotionSdkOptions } from "./local";

export async function renderLocalCachePlan(
  input: MotionSdkRenderCachePlanRequest,
  options: LocalMotionSdkOptions,
): Promise<MotionSdkRenderCachePlanResponse> {
  const request = input as unknown as Record<string, unknown>;
  const requestError = renderCachePlanRequestError(request);
  if (requestError) throw new LocalMotionSdkError("invalid_request", requestError, false);
  const typed = request as unknown as MotionSdkRenderCachePlanRequest;
  const inputRoots = [
    resolve(typed.packageRoot),
    ...(typed.workflowPath ? [dirname(resolve(typed.workflowPath))] : []),
    ...(typed.qualityManifestPath ? [dirname(resolve(typed.qualityManifestPath))] : []),
  ];
  const debug = await dispatchDebugCommand(
    "motion.render.cache.plan",
    renderCachePlanDebugArgs(typed),
    localDebugContext("render_motion", options, undefined, inputRoots),
  );
  if (!debug.ok) throw new LocalMotionSdkError(debug.error.code, debug.error.message, false, debug.error.detail);
  const result = debug.result && typeof debug.result === "object" && !Array.isArray(debug.result)
    ? { ...(debug.result as Record<string, unknown>), warnings: debug.warnings }
    : null;
  if (!result || !validRenderCachePlanOutput(result)) {
    throw new LocalMotionSdkError("invalid_response", "Render cache plan returned an invalid path-free result.", false);
  }
  return result;
}
