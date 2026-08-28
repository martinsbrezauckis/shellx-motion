/** Opt-in v2 reuse around the existing blocking final-render handlers. */
import {
  attestedRenderReuseCacheKey,
  assertStableRenderPackageLineage,
  canonicalJsonSha256,
  createAttestedArtifactHandle,
  createAttestedRenderReuseDescriptor,
  loadStableRenderPackage,
  packageRenderLineageInputHashes,
  verifyAttestedArtifactHandle,
  verifyAttestedRenderReuse,
  writeAttestedRenderReuseDescriptor,
  type AttestedRenderReuseInputs,
  type AttestedRenderReusePlan,
  type OperationReceipt,
} from "@shellx-motion/core";
import { resolveMotionExportPreset, type MotionExportPreset } from "@shellx-motion/renderer-ffmpeg";
import { realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { MotionDebugResult } from "../command-registry.js";
import type { FinalRenderRequest } from "./render-final.js";
import type { AttestedRenderReuseIdentityRequest } from "./attested-render-reuse-identity.js";
import { deriveAttestedRenderReuseIdentity } from "./attested-render-reuse-identity.js";
import { attestHostPersistedRenderReceipt } from "./attested-render-reuse-receipt-origin.js";
import {
  ATTESTED_REUSE_DIRECTORY,
  acquireAttestedReuseFillLock,
  AttestedReuseRootRequestError,
  attestedReuseDirectoryInsideRootExists,
  attestedReusePathExists,
  attestedReuseRootRelativePath,
  ensureAttestedReuseDirectoryInsideRoot,
  invalidAttestedReuseArgs,
  isInside,
  prepareAttestedReuseOutputRoot,
  releaseAttestedReuseFillLock,
} from "./attested-render-reuse-root.js";
import {
  issueAndWriteAttestedRenderReuseProducerProof,
  verifyAttestedRenderReuseProducerProof,
  type AttestedRenderReuseProducerAuthority,
} from "./attested-render-reuse-producer-authority.js";

export interface AttestedRenderReuseServices {
  /** Injected by Debug; Core intentionally has no dependency on its generated version constant. */
  engineVersion: string;
  /** Current structural capability checks. Tool executable readiness stays in the real render on a miss. */
  staticAdmission: (request: FinalRenderRequest) => Promise<MotionDebugResult | null>;
  execute: (request: FinalRenderRequest) => Promise<MotionDebugResult>;
  writeReceipt: (root: string, receipt: OperationReceipt) => Promise<string>;
  /** Opaque host-held producer authority. Never accepted from command arguments or package data. */
  producerAuthority?: AttestedRenderReuseProducerAuthority;
}

/**
 * Preserve ordinary final rendering by default. An opted-in hit verifies every v2 attestation but
 * deliberately starts no Browser/FFmpeg producer; a miss is the same normal render plus an
 * exclusively-published descriptor.
 */
export async function executeWithAttestedRenderReuse(
  request: FinalRenderRequest,
  services: AttestedRenderReuseServices,
): Promise<MotionDebugResult> {
  if (!request.reuseAttested) return await services.execute(request);
  // GPU output evidence is intentionally not cacheable until this identity gains its scene,
  // pipeline, adapter-limit, and producer bindings. Keep this guard here for direct host callers
  // that bypass the public argument dispatcher.
  if (!hasCacheableFrameLane(request)) {
    return invalidAttestedReuseArgs("GPU final rendering cannot use reuseAttested: its post-render identity is evidence only and never authorizes cache planning or reuse.");
  }
  if (!services.producerAuthority) {
    return cacheIntegrity("This host did not configure producer authentication, so no reuse entry can be trusted or published.");
  }

  const refusal = await services.staticAdmission(request);
  if (refusal) return refusal;

  try {
    const packageRoot = await realpath(resolve(request.packageRoot));
    const outputPath = resolve(request.outputPath);
    const root = await prepareAttestedReuseOutputRoot(packageRoot, dirname(outputPath));
    const outputRootRelativePath = attestedReuseRootRelativePath(root, outputPath, "render output");
    const identity = await deriveAttestedRenderReuseIdentity({
      request,
      packageRoot,
      outputRootRelativePath,
      engineVersion: services.engineVersion,
    });
    const { inputs, plan, cacheKey: key } = identity;
    const descriptorPath = join(root, ATTESTED_REUSE_DIRECTORY, `${key}.json`);
    const lockPath = join(root, ATTESTED_REUSE_DIRECTORY, `${key}.lock`);

    if (await attestedReuseDirectoryInsideRootExists(root, join(root, ATTESTED_REUSE_DIRECTORY), "attested-reuse directory") && await attestedReusePathExists(descriptorPath)) {
      const receiptsRoot = await resolveReceiptsRoot(request.receiptsRoot, root);
      return await cacheHit({ root, descriptorPath, plan, inputs, request, receiptsRoot, services });
    }
    if (await attestedReusePathExists(outputPath)) return cacheIntegrity("A render output already exists without a matching attested-reuse descriptor; Motion will not overwrite it.");
    const receiptsRoot = await resolveReceiptsRoot(request.receiptsRoot, root);
    await ensureAttestedReuseDirectoryInsideRoot(root, join(root, ATTESTED_REUSE_DIRECTORY), "attested-reuse directory");

    const lock = await acquireAttestedReuseFillLock(lockPath);
    if (lock === "busy") return cacheBusy();
    if (lock === "invalid") return cacheIntegrity("The attested-reuse fill lock is not a regular root-local file.");

    try {
      // A concurrent producer may have committed while this call was acquiring its lock. Never
      // start a second producer or overwrite the same caller-selected output.
      if (await attestedReusePathExists(descriptorPath)) return await cacheHit({ root, descriptorPath, plan, inputs, request, receiptsRoot, services });
      if (await attestedReusePathExists(outputPath)) return cacheIntegrity("A render output appeared without a matching attested-reuse descriptor; Motion will not overwrite it.");

      const rendered = await services.execute({ ...request, receiptsRoot });
      if (!rendered.ok) return rendered;
      const stored = await storeRenderedReuse({ rendered, root, packageRoot, outputPath, descriptorPath, plan, inputs, receiptsRoot, request, services });
      return stored;
    } finally {
      await releaseAttestedReuseFillLock(lockPath);
    }
  } catch (error) {
    if (error instanceof AttestedReuseRootRequestError) return invalidAttestedReuseArgs(error.message);
    return cacheIntegrity(error instanceof Error ? error.message : "Attested render reuse could not be verified.");
  }
}

function hasCacheableFrameLane(
  request: FinalRenderRequest,
): request is FinalRenderRequest & AttestedRenderReuseIdentityRequest {
  return request.frameLane === "browser" || request.frameLane === "native";
}

async function cacheHit(input: {
  root: string;
  descriptorPath: string;
  plan: AttestedRenderReusePlan;
  inputs: AttestedRenderReuseInputs;
  request: AttestedRenderReuseIdentityRequest;
  receiptsRoot: string;
  services: AttestedRenderReuseServices;
}): Promise<MotionDebugResult> {
  try {
    const verified = await verifyAttestedRenderReuse({ root: input.root, descriptorPath: input.descriptorPath, plan: input.plan, inputs: input.inputs });
    await verifyAttestedRenderReuseProducerProof({
      authority: input.services.producerAuthority!,
      root: input.root,
      descriptor: verified.descriptor,
    });
    const source = verified.artifact.receipts.find((entry) => entry.attestation.role === "render")?.receipt;
    if (!source) return cacheIntegrity("The attested-reuse descriptor has no verified source render receipt.");
    const reuseReceipt: OperationReceipt = {
      schema: "shellx-motion/receipt@1",
      id: `render-reuse-${randomUUID().replaceAll("-", "").slice(0, 20)}`,
      operation: "render.reuse",
      status: "passed",
      packageId: verified.descriptor.artifact.packageId,
      inputHashes: {
        cacheKey: verified.descriptor.cacheKey,
        package: input.inputs.packageSha256,
        artifact: verified.descriptor.artifact.sha256,
        sourceReceipt: verified.descriptor.sourceReceipt.sha256,
        ...(input.inputs.workflowSha256 ? { workflow: input.inputs.workflowSha256 } : {}),
        ...(input.inputs.workflowPathSha256 ? { workflowPath: input.inputs.workflowPathSha256 } : {}),
        ...(input.inputs.qualityManifestSha256 ? { qualityManifest: input.inputs.qualityManifestSha256 } : {}),
        ...(input.inputs.qualityBaselinesSha256 ? { qualityBaselines: input.inputs.qualityBaselinesSha256 } : {})
      },
      createdAt: new Date().toISOString(),
      lane: "attested-reuse",
      output: {
        path: input.request.outputPath,
        sha256: verified.descriptor.artifact.sha256,
        preset: input.request.preset,
        cache: {
          schema: "shellx-motion/attested-render-reuse-result@2",
          status: "hit",
          descriptorId: verified.descriptor.id,
          sourceReceiptId: verified.descriptor.sourceReceipt.id,
          sourceCreatedAt: verified.descriptor.createdAt,
          verifiedAt: new Date().toISOString(),
          freshRender: false
        }
      },
      artifacts: [{ role: "rendered_media", path: input.request.outputPath, status: "available", primary: true }],
      warnings: ["Reused a verified attested render; no browser or FFmpeg producer was started."]
    };
    const receiptPath = await input.services.writeReceipt(input.receiptsRoot, reuseReceipt);
    const sourceOutput = objectRecord(source.output) ?? {};
    return {
      ok: true,
      receiptId: reuseReceipt.id,
      visibleState: { panel: "receipts", operation: "render.reuse", packageId: reuseReceipt.packageId, outputPath: input.request.outputPath, status: "passed" },
      result: {
        ok: true,
        lane: "attested-reuse",
        frameLane: input.request.frameLane,
        preset: input.request.preset,
        packageId: reuseReceipt.packageId,
        outputPath: input.request.outputPath,
        output: { ...sourceOutput, path: input.request.outputPath, sha256: verified.descriptor.artifact.sha256 },
        receipt: reuseReceipt,
        receiptPath,
        sourceRender: {
          receiptId: verified.descriptor.sourceReceipt.id,
          createdAt: verified.descriptor.createdAt,
          lane: source.lane,
          output: source.output
        },
        artifact: verified.descriptor.artifact,
        reuseAttested: { status: "hit", descriptorId: verified.descriptor.id, sourceReceiptId: verified.descriptor.sourceReceipt.id },
        warnings: reuseReceipt.warnings
      },
      warnings: reuseReceipt.warnings
    };
  } catch (error) {
    return cacheIntegrity(error instanceof Error ? error.message : "Attested render reuse verification failed.");
  }
}

async function storeRenderedReuse(input: {
  rendered: Extract<MotionDebugResult, { ok: true }>;
  root: string;
  packageRoot: string;
  outputPath: string;
  descriptorPath: string;
  plan: AttestedRenderReusePlan;
  inputs: AttestedRenderReuseInputs;
  receiptsRoot: string;
  request: AttestedRenderReuseIdentityRequest;
  services: AttestedRenderReuseServices;
}): Promise<MotionDebugResult> {
  const payload = objectRecord(input.rendered.result);
  const rawReceipt = receiptRecord(payload?.receipt);
  const receiptPath = typeof payload?.receiptPath === "string" ? payload.receiptPath : undefined;
  if (!rawReceipt || !receiptPath || rawReceipt.operation !== "render.final") {
    return cacheIntegrity("The successful render did not return a persisted render.final receipt required for attested reuse.");
  }
  if (!isInside(input.root, receiptPath)) return cacheIntegrity("The source render receipt is outside the attested-reuse root.");
  // `verifyAttestedArtifactHandle` requires its operation hash to be present in the actual source
  // receipt. Preserve renderer evidence and add only this server-derived cache identity before the
  // already-successful receipt is atomically persisted again.
  const operationHash = attestedRenderReuseCacheKey(input.plan, input.inputs);
  rawReceipt.inputHashes = { ...rawReceipt.inputHashes, operationHash };
  const { pkg, lineage: packageLineage } = await loadStableRenderPackage(input.packageRoot);
  const packageHashes = packageRenderLineageInputHashes(packageLineage);
  if (!Object.entries(packageHashes).every(([key, value]) => rawReceipt.inputHashes[key] === value)) {
    return cacheIntegrity("The source render receipt does not bind the current package lineage.");
  }
  // Attested artifacts require their source receipt's operation identity plus package lineage as
  // an exact record. Preserve the renderer's detailed frame/media hashes under output evidence.
  const rendererInputHashes = { ...rawReceipt.inputHashes };
  rawReceipt.inputHashes = {
    operationHash,
    ...packageHashes,
  };
  rawReceipt.output = { ...(objectRecord(rawReceipt.output) ?? {}), rendererInputHashes };
  const sourceReceipt = await attestHostPersistedRenderReceipt({ root: input.root, receiptsRoot: input.receiptsRoot, receipt: rawReceipt, writeReceipt: input.services.writeReceipt });
  await assertStableRenderPackageLineage(pkg, packageLineage);
  const spec = resolveMotionExportPreset(input.plan.preset as MotionExportPreset);
  const artifact = await createAttestedArtifactHandle({
    root: input.root,
    artifactPath: input.outputPath,
    packageId: pkg.manifest.id,
    motionId: pkg.motion.id,
    operationHash: rawReceipt.inputHashes.operationHash!,
    preset: input.plan.preset,
    mediaType: spec.mimeType,
    receipts: [sourceReceipt],
    packageLineage,
    createdAt: rawReceipt.createdAt,
    probe: false
  });
  await verifyAttestedArtifactHandle(input.root, artifact, {
    expected: { operationHash: rawReceipt.inputHashes.operationHash, packageLineage },
    requiredReceiptRoles: ["render"],
    probe: false
  });
  await assertStableRenderPackageLineage(pkg, packageLineage);
  const refreshedInputs = await deriveAttestedRenderReuseIdentity({
    request: input.request,
    packageRoot: input.packageRoot,
    outputRootRelativePath: input.plan.outputRootRelativePath,
    engineVersion: input.plan.engineVersion,
  });
  if (canonicalJsonSha256(refreshedInputs.inputs) !== canonicalJsonSha256(input.inputs)) {
    return cacheIntegrity("Render inputs changed while the producer ran; the successful output was not published for reuse.");
  }
  const descriptor = createAttestedRenderReuseDescriptor({
    plan: input.plan,
    inputs: input.inputs,
    artifact,
    sourceReceipt,
    createdAt: rawReceipt.createdAt
  });
  await writeAttestedRenderReuseDescriptor({ root: input.root, descriptorPath: input.descriptorPath, descriptor });
  await issueAndWriteAttestedRenderReuseProducerProof({
    authority: input.services.producerAuthority!,
    root: input.root,
    descriptor,
  });
  return {
    ...input.rendered,
    result: {
      ...payload,
      artifact,
      reuseAttested: {
        status: "stored",
        descriptorId: descriptor.id,
        sourceReceiptId: sourceReceipt.id,
        artifact
      }
    }
  };
}

async function resolveReceiptsRoot(requested: string | undefined, root: string): Promise<string> {
  const candidate = resolve(requested ?? join(root, ".shellx-motion", "receipts"));
  return await ensureAttestedReuseDirectoryInsideRoot(root, candidate, "receiptsRoot", true);
}

function receiptRecord(value: unknown): OperationReceipt | null {
  const receipt = objectRecord(value);
  if (!receipt || receipt.schema !== "shellx-motion/receipt@1" || receipt.operation !== "render.final" || !objectRecord(receipt.inputHashes)) return null;
  return receipt as OperationReceipt;
}

function objectRecord(value: unknown): Record<string, any> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : null;
}

function cacheIntegrity(message: string): MotionDebugResult {
  return {
    ok: false,
    error: {
      code: "cache_integrity_failed",
      message: `Attested render reuse refused: ${message}`,
      suggestedAction: "Run without reuseAttested to request a fresh render, or inspect the current output and receipt root."
    },
    warnings: []
  };
}

function cacheBusy(): MotionDebugResult {
  return {
    ok: false,
    error: {
      code: "cache_busy",
      message: "An attested render reuse fill for this exact output is already active or its lock needs host inspection.",
      suggestedAction: "Wait and retry. Motion never automatically breaks an attested-reuse lock."
    },
    warnings: []
  };
}
