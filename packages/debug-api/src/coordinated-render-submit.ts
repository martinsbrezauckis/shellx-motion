/**
 * Coordinator submission admits only cancellation-proven final-video stream or segmented routes.
 *
 * `motion.render.final` deliberately supports materialized compatibility paths. A durable job
 * owns an AbortSignal only for the streamed producer/FFmpeg path, so forwarding arbitrary final
 * render arguments here would make `motion.job.cancel` promise more than it can do. Build a new
 * render argument object rather than removing a few known fields: new compatibility arguments are
 * refused by default until their cancellation semantics have been proven.
 */
export interface CoordinatedRenderSubmit {
  jobId?: string;
  /** Safe final-render arguments. Deliberately excludes the coordinator's own jobId. */
  renderArgs: Record<string, unknown>;
}

export type CoordinatedRenderSubmitParseResult =
  | { ok: true; value: CoordinatedRenderSubmit }
  | { ok: false; message: string };

const RENDER_FIELDS = ["packageRoot", "outputPath", "preset", "frameLane", "receiptsRoot", "segmented"] as const;
const SUBMIT_FIELDS = ["jobId", ...RENDER_FIELDS] as const;

export function parseCoordinatedRenderSubmit(args: unknown): CoordinatedRenderSubmitParseResult {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return { ok: false, message: "motion.job.submit requires an object with packageRoot and outputPath." };
  }
  const requested = args as Record<string, unknown>;
  const unsupported = Object.keys(requested).find((field) => !SUBMIT_FIELDS.includes(field as typeof SUBMIT_FIELDS[number]));
  if (unsupported) {
    return {
      ok: false,
      message: `motion.job.submit does not admit ${unsupported}; coordinator jobs support only the streamed final-video route. Use the blocking motion.render.final compatibility command for materialized rendering.`
    };
  }
  if (typeof requested.packageRoot !== "string" || !requested.packageRoot) {
    return { ok: false, message: "motion.job.submit requires packageRoot." };
  }
  if (typeof requested.outputPath !== "string" || !requested.outputPath) {
    return { ok: false, message: "motion.job.submit requires outputPath." };
  }
  if (requested.jobId !== undefined && (typeof requested.jobId !== "string" || !requested.jobId)) {
    return { ok: false, message: "motion.job.submit jobId must be a non-empty string when supplied." };
  }
  for (const field of ["preset", "receiptsRoot"] as const) {
    if (requested[field] !== undefined && typeof requested[field] !== "string") {
      return { ok: false, message: `motion.job.submit ${field} must be a string when supplied.` };
    }
  }
  if (requested.frameLane !== undefined && requested.frameLane !== "browser" && requested.frameLane !== "native" && requested.frameLane !== "gpu") {
    return { ok: false, message: "motion.job.submit frameLane must be browser, native, or gpu when supplied." };
  }
  if (!validSegmented(requested.segmented)) {
    return { ok: false, message: "motion.job.submit segmented must be { segmentFrames: positive safe integer, resume?: boolean } with no additional properties." };
  }

  const renderArgs: Record<string, unknown> = {};
  for (const field of RENDER_FIELDS) {
    if (requested[field] !== undefined) renderArgs[field] = requested[field];
  }
  return {
    ok: true,
    value: {
      ...(typeof requested.jobId === "string" ? { jobId: requested.jobId } : {}),
      renderArgs
    }
  };
}

function validSegmented(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return keys.length >= 1
    && keys.length <= 2
    && keys.includes("segmentFrames")
    && keys.every((key) => key === "segmentFrames" || key === "resume")
    && Number.isSafeInteger(record.segmentFrames)
    && (record.segmentFrames as number) > 0
    && (record.resume === undefined || typeof record.resume === "boolean");
}
