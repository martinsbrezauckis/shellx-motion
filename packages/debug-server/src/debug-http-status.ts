/**
 * HTTP status policy for the bare `POST /debug` transport only.
 *
 * Debug commands deliberately carry typed result envelopes on every transport. This module changes
 * only the outer status of the raw HTTP route: MCP and JSON-RPC retain their protocol envelopes and
 * statuses, while HTTP callers can distinguish correctable requests from unavailable host services
 * and unhandled engine failures without parsing every code first.
 */
import type { MotionDebugResult } from "@shellx-motion/debug-api";

const NOT_FOUND_CODES = new Set([
  "agent_unknown",
  "job_not_visible",
  "job_unknown",
  "pending_not_found",
  "receipt_not_found",
  "unknown_command"
]);

const CONFLICT_CODES = new Set([
  "cache_busy",
  "derived_output_busy",
  "derived_output_exists",
  "frame_transport_plan_conflict",
  "immutable_conflict",
  "output_dir_not_empty",
  "output_not_empty",
  "output_path_exists",
  "package_archive_output_busy",
  "package_archive_output_exists",
  "package_archive_output_paths_conflict",
  "segment_store_busy",
  "streaming_evidence_conflict"
]);

const HOST_UNAVAILABLE_CODES = new Set([
  "action.lifecycle_unavailable",
  "agent_unavailable",
  "capability_unavailable",
  "encoder_unavailable",
  "ffmpeg_not_configured",
  "gpu_adapter_identity_unavailable",
  "gpu_browser_pid_unavailable",
  "gpu_browser_unavailable",
  "gpu_device_unavailable",
  "gpu_hardware_unavailable",
  "gpu_process_containment_unavailable",
  "gpu_trace_runtime_unavailable",
  "job_process_containment_unavailable",
  "sandbox_unavailable"
]);

const AUTHORITY_DENIAL_CODES = new Set([
  "authoring_path_not_approved",
  "approved_agent_entry_refused",
  "chromium_sandbox_opt_out_refused",
  "render_path_not_approved",
  "untrusted_browser_launcher_override_refused",
  "untrusted_network_configuration_refused"
]);

const PATH_TOPOLOGY_CODES = new Set([
  "derived_output_unsafe_parent",
  "job_scratch_path_unsafe",
  "output_path_unsafe_parent",
  "package_archive_output_unsafe_parent",
  "unsafe_input_path",
  "unsafe_output"
]);

/**
 * These are audited, caller-correctable refusals. Keep this closed: a code's spelling alone does
 * not say whether the caller can repair the request or the host must acquire a missing capability.
 */
const CALLER_CORRECTABLE_REFUSAL_CODES = new Set([
  "audio_master_invalid",
  "audio_master_unavailable",
  "browser_html_typography_unverified",
  "browser_motion_typography_unverified",
  "gpu_resource_refused",
  "motion_behaviors_unavailable",
  "motion_relations_unavailable",
  "motion_scene3d_animation_unavailable",
  "native_text_not_deliverable",
  "property.unsupported",
  "render_resource_preflight_exceeded",
  "render_static_sequence_limit_exceeded",
  "unsupported_frame_lane",
  "unsupported_layer"
]);

/** Error thrown only when the bounded JSON reader has consumed too many body bytes. */
export class RawDebugRequestBodyTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`Motion debug request body exceeds ${maxBytes} bytes.`);
    this.name = "RawDebugRequestBodyTooLargeError";
  }
}

/**
 * Classify a typed command result for raw `POST /debug`, without changing its result body.
 *
 * `job_not_visible` is deliberately 404 so a caller cannot use the status to enumerate another
 * principal's work. `job_expired` is 410: current hosts document a distinct receipt-fallback action
 * for retention expiry. Host-configured authority fences are 403, while path topology supplied by an
 * already authenticated caller is 422 and can be corrected without obtaining a new grant.
 */
export function statusForRawDebugResult(result: MotionDebugResult): number {
  if (result.ok) return 200;

  const { code } = result.error;
  if (code === "permission_denied" || AUTHORITY_DENIAL_CODES.has(code)) return 403;
  if (NOT_FOUND_CODES.has(code)) return 404;
  if (code === "job_expired") return 410;
  if (code === "invalid_args") return 400;
  if (CONFLICT_CODES.has(code) || code === "job_not_terminal" || code === "job_not_retryable") return 409;
  if (code === "job_queue_full" || code === "job_queue_timeout" || code === "too_many_requests") return 429;
  if (HOST_UNAVAILABLE_CODES.has(code)) return 503;
  if (PATH_TOPOLOGY_CODES.has(code) || CALLER_CORRECTABLE_REFUSAL_CODES.has(code)) return 422;
  return 500;
}
