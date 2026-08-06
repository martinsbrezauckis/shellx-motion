/** Runtime identity guards for render artifacts and explicit Cut handoffs. */
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
