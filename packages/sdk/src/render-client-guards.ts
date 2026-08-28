/** Runtime identity guards for render artifacts and explicit Cut handoffs. */
import { FFMPEG_EXPORT_PRESETS } from "@shellx-motion/core";

/** Refuse retention where a render cannot produce final-video frame diagnostics. */
export function renderKeepFramesRequestError(input: Record<string, unknown>): string {
  if (input.keepFrames !== undefined && typeof input.keepFrames !== "boolean") return "SDK render keepFrames must be boolean.";
  if (input.keepFrames === true && (typeof input.preset !== "string" || !FFMPEG_EXPORT_PRESETS.includes(input.preset as typeof FFMPEG_EXPORT_PRESETS[number]))) {
    return "SDK render keepFrames: true requires a final-video FFmpeg preset.";
  }
  return "";
}

export function validRenderArtifact(
  value: unknown,
  render: Record<string, unknown>,
): boolean {
  const artifact = plainRecord(value);
  return Boolean(
    artifact
    && artifact.schema === "shellx-motion/artifact-handle@1"
    && nonEmpty(artifact.id)
    && artifact.packageId === render.packageId
    && artifact.motionId === render.motionId
    && artifact.preset === render.preset
    && sha256(artifact.sha256)
    && sha256(artifact.operationHash)
    && positive(artifact.byteLength)
    && nonEmpty(artifact.mediaType)
    && nonEmpty(artifact.createdAt)
    && Number.isFinite(Date.parse(String(artifact.createdAt)))
    && (artifact.packageLineage === undefined || validPackageLineage(artifact.packageLineage)),
  );
}

export function validRequestedCutHandoff(
  output: Record<string, unknown>,
  requestInput: unknown,
): boolean {
  const request = plainRecord(requestInput);
  const requested = plainRecord(request?.cutHandoff);
  if (!requested) {
    return output.artifactReference === undefined && output.cutHandoff === undefined;
  }
  if (requested.target !== "shellx-cut" || requested.mode !== "rendered_media") return false;
  const artifact = plainRecord(output.artifact);
  const reference = plainRecord(output.artifactReference);
  const cut = plainRecord(output.cutHandoff);
  return Boolean(
    artifact
    && reference
    && cut
    && reference.schema === "shellx-motion/artifact-handle-ref@1"
    && reference.id === artifact.id
    && reference.operationHash === artifact.operationHash
    && sameJson(reference.packageLineage, artifact.packageLineage)
    && nonEmpty(reference.rootRelativePath)
    && sha256(reference.sha256)
    && cut.schema === "shellx-motion/cut-handoff@1"
    && cut.target === "shellx-cut"
    && cut.mode === "rendered_media"
    && nonEmpty(cut.path)
    && sha256(cut.sha256)
    && cut.packageId === output.packageId
    && cut.motionId === output.motionId
    && cut.artifactHandleId === artifact.id,
  );
}

/** A remote render may disclose a retained-frame location only when its request explicitly asked for it. */
export function validRequestedRenderFrames(
  output: Record<string, unknown>,
  requestInput: unknown,
): boolean {
  const request = plainRecord(requestInput);
  if (request?.keepFrames !== true) return output.frames === undefined;
  const frames = plainRecord(output.frames);
  return Boolean(
    frames
    && Object.keys(frames).length === 2
    && nonEmpty(frames.dir)
    && typeof frames.count === "number"
    && Number.isSafeInteger(frames.count)
    && frames.count > 0,
  );
}

/** A remote host may report a GPU post-render identity only for the completed GPU artifact it returned. */
export function validRequestedGpuPostRenderReuse(output: Record<string, unknown>, requestInput: unknown): boolean {
  const request = plainRecord(requestInput);
  const identity = output.gpuPostRenderReuse;
  if (request?.frameLane !== "gpu") return identity === undefined;
  // A durable segmented receipt has its own complete checkpoint transport evidence. It is never
  // eligible for the direct final-video post-render identity, which exists solely as evidence and
  // must not become a cache/reuse capability through the public SDK response.
  if (request.segmented !== undefined) return identity === undefined;
  if (identity === undefined) return true;
  const value = plainRecord(identity);
  const source = plainRecord(value?.source);
  const artifact = plainRecord(value?.artifact);
  const staticScene = plainRecord(value?.staticScene);
  const transport = plainRecord(value?.frameTransport);
  const runtime = plainRecord(value?.runtime);
  const video = value?.video === null ? null : plainRecord(value?.video);
  const quality = plainRecord(value?.quality);
  const outputArtifact = plainRecord(output.artifact);
  return Boolean(
    value && exactFields(value, ["schema", "mode", "source", "artifact", "loadedInputsSha256", "staticScene", "frameTransport", "runtime", "video", "quality", "identitySha256"])
    && value.schema === "shellx-motion/gpu-post-render-reuse-identity@1" && value.mode === "post-render-only"
    && sha256(value.loadedInputsSha256) && sha256(value.identitySha256)
    && source && exactFields(source, ["receiptId", "receiptSha256"]) && nonEmpty(source.receiptId) && source.receiptId === output.receiptId && sha256(source.receiptSha256)
    && artifact && exactFields(artifact, ["sha256", "byteLength", "authoritySha256"]) && sha256(artifact.sha256) && positive(artifact.byteLength) && sha256(artifact.authoritySha256)
    && outputArtifact && artifact.sha256 === outputArtifact.sha256 && artifact.byteLength === outputArtifact.byteLength
    && hashFields(staticScene, ["pipelineCatalogSha256", "staticPlanFingerprint", "documentFingerprint", "resourceReferencesSha256", "staticSceneSha256", "resourceBudgetSha256"])
    && hashFields(transport, ["transportSha256", "frameSequenceSha256", "framePlanSequenceSha256"])
    && hashFields(runtime, ["adapterFingerprint", "runtimeProfileSha256", "sessionResourcesSha256", "containmentProfileSha256"])
    && (video === null || hashFields(video, ["stagingLedgerSha256", "pcmSha256"]))
    && quality && exactFields(quality, ["closureSha256", "exactSourceInputsSha256"]) && sha256(quality.closureSha256) && (quality.exactSourceInputsSha256 === null || sha256(quality.exactSourceInputsSha256)),
  );
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const descriptors = Object.values(Object.getOwnPropertyDescriptors(value));
  return descriptors.every((descriptor) => "value" in descriptor)
    ? value as Record<string, unknown>
    : null;
}

function nonEmpty(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function positive(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function sha256(value: unknown): boolean {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function hashFields(value: Record<string, unknown> | null, keys: string[]): boolean {
  return Boolean(value && exactFields(value, keys) && keys.every((key) => sha256(value[key])));
}

function exactFields(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function validPackageLineage(value: unknown): boolean {
  const lineage = plainRecord(value);
  if (!lineage || lineage.schema !== "shellx-motion/package-render-lineage@1"
    || !sha256(lineage.manifestSha256) || !sha256(lineage.motionSha256)) return false;
  const allowed = ["schema", "manifestSha256", "motionSha256", "adapterId", "sourceSha256", "normalizedSourceSha256", "loweringReceiptSha256"];
  if (Object.keys(lineage).some((key) => !allowed.includes(key))) return false;
  const gltfFields = [lineage.sourceSha256, lineage.normalizedSourceSha256, lineage.loweringReceiptSha256];
  if (lineage.adapterId === undefined) return gltfFields.every((field) => field === undefined);
  return lineage.adapterId === "adapter.gltf" && gltfFields.every(sha256);
}

function sameJson(left: unknown, right: unknown): boolean {
  const leftRecord = plainRecord(left);
  const rightRecord = plainRecord(right);
  if (!leftRecord || !rightRecord) return left === right;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && leftRecord[key] === rightRecord[key]);
}
