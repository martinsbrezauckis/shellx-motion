import { readMotionLayoutApplications } from "./motion-layout-application";
import type { MotionDocument } from "./types";

/** Validates bounded document-resident layout inverse records independently of the open schema extension surface. */
export function validateMotionLayoutApplicationRecords(
  record: Record<string, unknown>,
  errors: Array<{ path: string; message: string }>
): void {
  if (!("layoutApplications" in record)) return;
  try {
    readMotionLayoutApplications(record as unknown as MotionDocument);
  } catch (error) {
    errors.push({ path: "/layoutApplications", message: error instanceof Error ? error.message : "must contain valid layout application records" });
  }
}
