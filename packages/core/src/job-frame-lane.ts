/**
 * The raster lane chosen inside a final-video host job.
 *
 * `lane` on a host job remains the delivery/governor lane (for example, `ffmpeg`).
 * This separate optional field keeps the stricter rasterizer choice visible without
 * changing the meaning of historical job records.
 */
export const MOTION_JOB_FRAME_LANES = ["browser", "native", "gpu"] as const;

export type MotionJobFrameLane = typeof MOTION_JOB_FRAME_LANES[number];

export function isMotionJobFrameLane(value: unknown): value is MotionJobFrameLane {
  return typeof value === "string" && (MOTION_JOB_FRAME_LANES as readonly string[]).includes(value);
}
