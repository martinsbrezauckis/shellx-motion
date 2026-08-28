/** Path-free SDK shape for the non-mutating v2 attested render-cache observation. */
import type { MotionSdkResult } from "./types.js";

export interface MotionSdkRenderCachePlanRequest {
  packageRoot: string;
  outputPath: string;
  preset: string;
  /** GPU post-render identity is evidence only and never authorizes cache planning or reuse. */
  frameLane?: "browser" | "native";
  atMs?: number;
  minUniqueFrameHashes?: number;
  workflowPath?: string;
  qualityManifestPath?: string;
}

export type MotionSdkRenderCachePlanReason =
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
  | "fill_busy";

export type MotionSdkRenderCachePlanChecked = "static_admission" | "identity_inputs" | "output_root" | "entry_presence" | "attestation";
export type MotionSdkRenderCachePlanMissOnlyCheck =
  | "output_root_materialization"
  | "exclusive_fill_lock"
  | "producer_and_tool_readiness"
  | "script_provenance_resolution"
  | "quality_execution"
  | "receipt_artifact_descriptor_publication"
  | "post_render_input_recheck";

export interface MotionSdkRenderCachePlanResponse {
  schema: "shellx-motion/render-cache-plan@1";
  observedAt: string;
  authorization: "none";
  identity?: {
    digest: string;
    inputCategories: Array<"package_bytes" | "resolved_render_plan" | "workflow_file_bytes" | "quality_manifest_and_baselines">;
  };
  decision: {
    kind: "hit" | "miss" | "refused";
    reason: MotionSdkRenderCachePlanReason;
  };
  checked: MotionSdkRenderCachePlanChecked[];
  missOnlyChecks: MotionSdkRenderCachePlanMissOnlyCheck[];
  source?: {
    descriptorId: string;
    receipt: { role: "render"; status: "passed" | "warning"; sha256: string };
    artifact: { sha256: string };
  };
  warnings: string[];
}

declare module "./types.js" {
  interface MotionSdkRequestMap {
    renderCachePlan: MotionSdkRenderCachePlanRequest;
  }

  interface MotionSdkResponseMap {
    renderCachePlan: MotionSdkRenderCachePlanResponse;
  }

  interface MotionSdkClient {
    renderCachePlan(
      input: MotionSdkRenderCachePlanRequest,
    ): Promise<MotionSdkResult<MotionSdkRenderCachePlanResponse>>;
  }
}
