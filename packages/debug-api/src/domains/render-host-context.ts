/** Host-owned render-root projection and retained batch-read authority. */
import { loadDataRowsFile, loadMotionPackage, type MotionDataRow, type MotionPackage } from "@shellx-motion/core";
import { withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { resolve } from "node:path";
import type { MotionDebugContext } from "../index.js";
import type { BatchRenderRequest } from "./render-batch.js";
import type { RenderRootPolicy } from "./render-root-policy.js";

/** The host-owned context fields which determine render filesystem authority. */
export interface RenderFilesystemRootContext {
  enforceRenderRoots?: boolean;
  renderPackageRoots?: string[];
  renderInputRoots?: string[];
  renderOutputRoots?: string[];
  operatorRenderPackageRoots?: string[];
  operatorRenderInputRoots?: string[];
  operatorRenderOutputRoots?: string[];
  receiptsRoot?: string;
}

export function qualityCheckInputRoots(context: MotionDebugContext): string[] {
  return [...(context.qualityInputRoots ?? []), context.scratchRoot ?? ".scratch"].map((root) => resolve(root));
}

/** Combine only roots the host or its native Workbench chooser supplied. */
export function renderFilesystemRootPolicy(context: RenderFilesystemRootContext): RenderRootPolicy {
  const renderBoundaryActive = context.enforceRenderRoots === true
    || context.renderPackageRoots !== undefined
    || context.renderInputRoots !== undefined
    || context.renderOutputRoots !== undefined
    || context.operatorRenderPackageRoots !== undefined
    || context.operatorRenderInputRoots !== undefined
    || context.operatorRenderOutputRoots !== undefined;
  const packageRoots = renderRoots(context.renderPackageRoots, context.operatorRenderPackageRoots);
  const inputRoots = renderRoots(context.renderInputRoots, context.operatorRenderInputRoots);
  // The server's receipt store is separately host-owned. It remains bounded by
  // the caller-receipts fence; including it here only lets a render write the
  // server-selected default rather than requiring operators to repeat it in a
  // render-output flag.
  const outputRoots = renderRoots(
    [...(context.renderOutputRoots ?? []), ...(renderBoundaryActive && context.receiptsRoot ? [context.receiptsRoot] : [])],
    context.operatorRenderOutputRoots
  );
  return {
    enforce: context.enforceRenderRoots === true,
    ...(packageRoots ? { packageRoots } : {}),
    ...(inputRoots ? { inputRoots } : {}),
    ...(outputRoots ? { outputRoots } : {})
  };
}

function renderRoots(configured: string[] | undefined, granted: string[] | undefined): string[] | undefined {
  const roots = [...(configured ?? []), ...(granted ?? [])];
  return roots.length > 0 ? [...new Set(roots)] : undefined;
}

/** Keep the admitted rows root and POSIX identity authority through Core's stable open. */
export async function loadAdmittedDebugBatchRows(request: BatchRenderRequest): Promise<MotionDataRow[]> {
  if (!request.rowsPath) throw new Error("Batch rowsPath is unavailable after render admission.");
  const read = async () => await loadDataRowsFile(request.rowsPath!, request.rowsInputRoot ? { withinRoot: request.rowsInputRoot.root } : {});
  return request.rowsInputRoot?.workspaceAnchor
    ? await withTrustedWorkspaceAnchor(request.rowsInputRoot.workspaceAnchor, read)
    : await read();
}

/** Keep the admitted package root and POSIX identity authority through document loading. */
export async function loadAdmittedDebugBatchPackage(request: BatchRenderRequest): Promise<MotionPackage> {
  const load = async () => await loadMotionPackage(request.packageRoot);
  return request.packageInputRoot?.workspaceAnchor
    ? await withTrustedWorkspaceAnchor(request.packageInputRoot.workspaceAnchor, load)
    : await load();
}
