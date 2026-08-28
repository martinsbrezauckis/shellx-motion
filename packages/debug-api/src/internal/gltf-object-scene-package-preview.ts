/** Workspace-private C7A3f output-only package preview. Package mutation never imports this module. */
import {
  compileGltfObjectRetainedRenderFramePlan,
  evaluateGltfObjectSceneAtUs,
  readGltfObjectRetainedRenderFrameUpload,
  readGltfObjectRetainedRenderStaticUpload,
} from "@shellx-motion/core/internal/scene-recipe";
import {
  createGpuGltfObjectRetainedRenderSession,
  type GpuGltfObjectRetainedRenderResult,
  type GpuGltfObjectRetainedRenderSession,
} from "@shellx-motion/renderer-browser/internal/gltf-object-retained-render";
import {
  reopenGltfObjectScenePackagePreviewInput,
  type GltfObjectScenePackageInstalledOutput,
  type GltfObjectScenePackageOutputHost,
} from "../domains/gltf-object-scene-package-materialize-private/gltf-object-scene-package-output-private.js";

export interface GltfObjectScenePackagePreviewOptions { readonly timeoutMs?: number }
type SuccessfulRender = Extract<GpuGltfObjectRetainedRenderResult, { readonly ok: true }>;
export interface GltfObjectScenePackagePreviewResult {
  readonly schema: "shellx-motion/private-gltf-object-scene-package-preview-result@1";
  readonly installed: GltfObjectScenePackageInstalledOutput;
  readonly receiptFingerprint: string;
  readonly framePlanFingerprint: string;
  readonly frame: SuccessfulRender["frame"];
  readonly metrics: SuccessfulRender["metrics"];
  readonly release: Awaited<ReturnType<GpuGltfObjectRetainedRenderSession["close"]>>;
}

export async function renderGltfObjectScenePackagePreviewAtUs(host: GltfObjectScenePackageOutputHost, atUs: number, options: GltfObjectScenePackagePreviewOptions = {}): Promise<GltfObjectScenePackagePreviewResult> {
  if (!Number.isSafeInteger(atUs) || atUs < 0) throw new Error("Imported-object package preview atUs must be a non-negative integer microsecond.");
  const input = await reopenGltfObjectScenePackagePreviewInput(host), evaluated = evaluateGltfObjectSceneAtUs(input.evaluationPlan, atUs);
  if (!evaluated.ok) throw new Error(evaluated.message);
  const framePlan = compileGltfObjectRetainedRenderFramePlan(input.retainedRenderPlan, evaluated.frame);
  const opened = await createGpuGltfObjectRetainedRenderSession(readGltfObjectRetainedRenderStaticUpload(input.retainedRenderPlan));
  if (!opened.ok) throw new Error(opened.failure.message);
  let rendered: Awaited<ReturnType<typeof opened.session.render>> | undefined;
  let release: Awaited<ReturnType<typeof opened.session.close>>;
  try { rendered = await opened.session.render(readGltfObjectRetainedRenderFrameUpload(input.retainedRenderPlan, framePlan), options); }
  finally { release = await opened.session.close(); }
  if (!rendered.ok) throw new Error(rendered.failure.message);
  return Object.freeze({ schema: "shellx-motion/private-gltf-object-scene-package-preview-result@1" as const, installed: input.installed, receiptFingerprint: input.receiptFingerprint, framePlanFingerprint: framePlan.fingerprint, frame: rendered.frame, metrics: rendered.metrics, release });
}
