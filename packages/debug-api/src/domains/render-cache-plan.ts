/** Non-mutating, non-authorising observation of the exact v2 attested-render-reuse authority. */
import { canonicalJson, verifyAttestedRenderReuse } from "@shellx-motion/core";
import { readImageSequenceExportPreset, readMotionExportPreset } from "@shellx-motion/renderer-ffmpeg";
import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { attestedRenderReuseStaticAdmission } from "./attested-render-reuse-host.js";
import { deriveAttestedRenderReuseIdentity } from "./attested-render-reuse-identity.js";
import {
  ATTESTED_REUSE_DIRECTORY,
  attestedReuseDirectoryInsideRootExists,
  attestedReusePathExists,
} from "./attested-render-reuse-root.js";
import {
  inspectAttestedReuseFillLockReadOnly,
  inspectAttestedReuseOutputRootReadOnly,
} from "./attested-render-reuse-root-inspect.js";
import { isInsideAnyRoot, type FinalRenderRequest, type RenderFinalServices } from "./render-final.js";
import { parseBrowserWorkflow } from "./integration-browser-workflow.js";
import { readRenderCachePlanInput, type RenderCachePlanInput } from "./render-cache-plan-input.js";
import { MOTION_ENGINE_VERSION } from "../version.js";
import {
  verifyAttestedRenderReuseProducerProof,
  type AttestedRenderReuseProducerAuthority,
} from "./attested-render-reuse-producer-authority.js";

export const RENDER_CACHE_PLAN_SCHEMA = "shellx-motion/render-cache-plan@1" as const;
export const MAX_RENDER_CACHE_PLAN_BYTES = 4_096;

const MISS_ONLY_CHECKS = [
  "output_root_materialization",
  "exclusive_fill_lock",
  "producer_and_tool_readiness",
  "script_provenance_resolution",
  "quality_execution",
  "receipt_artifact_descriptor_publication",
  "post_render_input_recheck",
] as const;

type RenderCachePlanChecked = "static_admission" | "identity_inputs" | "output_root" | "entry_presence" | "attestation";
type RenderCachePlanReason =
  | "verified_attested_entry"
  | "entry_absent"
  | "output_root_unmaterialized"
  | "unsupported_request"
  | "static_admission_refused"
  | "untrusted_external_input"
  | "input_fingerprint_unavailable"
  | "unsafe_output_root"
  | "output_exists_without_entry"
  | "descriptor_or_artifact_unverified"
  | "producer_authority_unavailable"
  | "fill_busy";

export interface RenderCachePlanResult {
  schema: typeof RENDER_CACHE_PLAN_SCHEMA;
  observedAt: string;
  authorization: "none";
  identity?: {
    digest: string;
    inputCategories: Array<"package_bytes" | "resolved_render_plan" | "workflow_file_bytes" | "quality_manifest_and_baselines">;
  };
  decision: { kind: "hit" | "miss" | "refused"; reason: RenderCachePlanReason };
  checked: RenderCachePlanChecked[];
  missOnlyChecks: typeof MISS_ONLY_CHECKS[number][];
  source?: {
    descriptorId: string;
    receipt: { role: "render"; status: "passed" | "warning"; sha256: string };
    artifact: { sha256: string };
  };
}

export interface RenderCachePlanServices extends Pick<RenderFinalServices, "scratchRoot" | "qualityInputRoots" | "isPathInsideTrustedRoot" | "readJson"> {
  /** Injectable so tests can prove this timestamp does not affect the v2 identity digest. */
  now?: () => Date;
  /** Same opaque producer authority used by execution; a public descriptor alone is never a hit. */
  producerAuthority?: AttestedRenderReuseProducerAuthority;
}

/**
 * Observe a v2 reuse entry without creating its output root, descriptor directory, fill lock,
 * receipt, or artifact. It is intentionally not accepted by `motion.render.final`.
 */
export async function dispatchRenderCachePlanCommand(
  command: MotionDebugCommand,
  args: unknown,
  services: RenderCachePlanServices,
): Promise<MotionDebugResult | null> {
  if (command !== "motion.render.cache.plan") return null;
  const input = readRenderCachePlanInput(args);
  if (!input.ok) return invalid(input.message);
  const observedAt = observedTime(services.now);
  if (!observedAt) return unavailable();
  if (!readMotionExportPreset(input.value.preset) || readImageSequenceExportPreset(input.value.preset)) {
    return result(observedAt, { kind: "refused", reason: "unsupported_request" }, []);
  }

  const resolved = await resolvePathBackedWorkflow(input.value, services, observedAt);
  if (!resolved.ok) return resolved.result;
  const request: FinalRenderRequest & RenderCachePlanInput = {
    ...input.value,
    preset: readMotionExportPreset(input.value.preset)!,
    dryRun: false,
    reuseAttested: true,
    ...(resolved.workflow ? { workflow: resolved.workflow } : {}),
  };

  const staticRefusal = await attestedRenderReuseStaticAdmission(request, invalid);
  if (staticRefusal) {
    return result(observedAt, { kind: "refused", reason: "static_admission_refused" }, ["static_admission"]);
  }

  let root;
  try {
    const packageRoot = await realpath(resolve(request.packageRoot));
    root = await inspectAttestedReuseOutputRootReadOnly(packageRoot, request.outputPath);
  } catch {
    return result(observedAt, { kind: "refused", reason: "unsafe_output_root" }, ["static_admission", "output_root"]);
  }

  let identity;
  try {
    identity = await deriveAttestedRenderReuseIdentity({
      request,
      packageRoot: root.packageRoot,
      outputRootRelativePath: root.outputRootRelativePath,
      engineVersion: MOTION_ENGINE_VERSION,
    });
  } catch {
    return result(observedAt, { kind: "refused", reason: "input_fingerprint_unavailable" }, ["static_admission", "output_root"]);
  }
  const checked: RenderCachePlanChecked[] = ["static_admission", "output_root", "identity_inputs"];
  const identitySummary = identityResult(identity.cacheKey, request);
  if (root.state === "unmaterialized") {
    return result(observedAt, { kind: "miss", reason: "output_root_unmaterialized" }, checked, identitySummary);
  }

  const descriptorPath = join(root.root, ATTESTED_REUSE_DIRECTORY, `${identity.cacheKey}.json`);
  try {
    const hasDirectory = await attestedReuseDirectoryInsideRootExists(
      root.root,
      join(root.root, ATTESTED_REUSE_DIRECTORY),
      "attested-reuse directory",
    );
    const hasDescriptor = hasDirectory && await attestedReusePathExists(descriptorPath);
    if (hasDescriptor) {
      checked.push("entry_presence");
      if (!services.producerAuthority) {
        return result(observedAt, { kind: "refused", reason: "producer_authority_unavailable" }, checked, identitySummary);
      }
      try {
        const verified = await verifyAttestedRenderReuse({
          root: root.root,
          descriptorPath,
          plan: identity.plan,
          inputs: identity.inputs,
        });
        await verifyAttestedRenderReuseProducerProof({
          authority: services.producerAuthority,
          root: root.root,
          descriptor: verified.descriptor,
        });
        checked.push("attestation");
        return result(observedAt, { kind: "hit", reason: "verified_attested_entry" }, checked, identitySummary, {
          descriptorId: verified.descriptor.id,
          receipt: {
            role: "render",
            status: verified.descriptor.sourceReceipt.status === "warning" ? "warning" : "passed",
            sha256: verified.descriptor.sourceReceipt.sha256,
          },
          artifact: { sha256: verified.descriptor.artifact.sha256 },
        });
      } catch {
        return result(observedAt, { kind: "refused", reason: "descriptor_or_artifact_unverified" }, checked, identitySummary);
      }
    }
    checked.push("entry_presence");
    if (await attestedReusePathExists(root.outputPath)) {
      return result(observedAt, { kind: "refused", reason: "output_exists_without_entry" }, checked, identitySummary);
    }
    if (hasDirectory) {
      const lock = await inspectAttestedReuseFillLockReadOnly(root.root, identity.cacheKey);
      if (lock === "busy") return result(observedAt, { kind: "refused", reason: "fill_busy" }, checked, identitySummary);
      if (lock === "unsafe") return result(observedAt, { kind: "refused", reason: "descriptor_or_artifact_unverified" }, checked, identitySummary);
    }
    return result(observedAt, { kind: "miss", reason: "entry_absent" }, checked, identitySummary);
  } catch {
    return result(observedAt, { kind: "refused", reason: "descriptor_or_artifact_unverified" }, checked, identitySummary);
  }
}

async function resolvePathBackedWorkflow(
  input: RenderCachePlanInput,
  services: RenderCachePlanServices,
  observedAt: string,
): Promise<{ ok: true; workflow?: FinalRenderRequest["workflow"] } | { ok: false; result: MotionDebugResult }> {
  const readPaths = [input.workflowPath, input.qualityManifestPath].filter((path): path is string => Boolean(path));
  if (readPaths.length === 0) return { ok: true };
  const readJson = services.readJson;
  if (!services.isPathInsideTrustedRoot || (input.workflowPath && !readJson)) return { ok: false, result: unavailable() };
  const roots = [input.packageRoot, services.scratchRoot ?? ".scratch", ...(services.qualityInputRoots ?? [])];
  for (const path of readPaths) {
    if (!await isInsideAnyRoot(path, roots, services.isPathInsideTrustedRoot)) {
      return { ok: false, result: result(observedAt, { kind: "refused", reason: "untrusted_external_input" }, []) };
    }
  }
  if (!input.workflowPath) return { ok: true };
  try {
    const workflow = parseBrowserWorkflow(await readJson!(input.workflowPath));
    return workflow ? { ok: true, workflow } : { ok: false, result: result(observedAt, { kind: "refused", reason: "static_admission_refused" }, []) };
  } catch {
    return { ok: false, result: result(observedAt, { kind: "refused", reason: "static_admission_refused" }, []) };
  }
}

function identityResult(digest: string, request: RenderCachePlanInput): NonNullable<RenderCachePlanResult["identity"]> {
  return {
    digest,
    inputCategories: [
      "package_bytes",
      "resolved_render_plan",
      ...(request.workflowPath ? ["workflow_file_bytes" as const] : []),
      ...(request.qualityManifestPath ? ["quality_manifest_and_baselines" as const] : []),
    ],
  };
}

export function projectRenderCachePlan(
  observedAt: string,
  decision: RenderCachePlanResult["decision"],
  checked: RenderCachePlanChecked[],
  identity?: RenderCachePlanResult["identity"],
  source?: RenderCachePlanResult["source"],
  maxBytes = MAX_RENDER_CACHE_PLAN_BYTES,
): MotionDebugResult {
  const payload: RenderCachePlanResult = {
    schema: RENDER_CACHE_PLAN_SCHEMA,
    observedAt,
    authorization: "none",
    ...(identity ? { identity } : {}),
    decision,
    checked,
    missOnlyChecks: [...MISS_ONLY_CHECKS],
    ...(source ? { source } : {}),
  };
  return Buffer.byteLength(canonicalJson(payload), "utf8") <= maxBytes
    ? { ok: true, result: payload, warnings: [] }
    : { ok: false, error: { code: "cache_plan_too_large", message: "Render cache plan exceeded its fixed response budget." }, warnings: [] };
}

function result(
  observedAt: string,
  decision: RenderCachePlanResult["decision"],
  checked: RenderCachePlanChecked[],
  identity?: RenderCachePlanResult["identity"],
  source?: RenderCachePlanResult["source"],
): MotionDebugResult {
  return projectRenderCachePlan(observedAt, decision, checked, identity, source);
}

function observedTime(now: RenderCachePlanServices["now"]): string | null {
  const value = now ? now() : new Date();
  return value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : null;
}

function invalid(message: string): MotionDebugResult {
  return { ok: false, error: { code: "invalid_args", message }, warnings: [] };
}

function unavailable(): MotionDebugResult {
  return {
    ok: false,
    error: { code: "capability_unavailable", message: "Render cache planning is unavailable on this host." },
    warnings: [],
  };
}
