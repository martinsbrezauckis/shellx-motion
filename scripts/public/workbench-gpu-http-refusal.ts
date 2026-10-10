import { statusForRawDebugResult } from "../../packages/debug-server/src/debug-http-status";

/** Accept only a typed GPU refusal whose HTTP status matches the raw Debug API policy. */
export function isExpectedGpuHttpRefusal(status: number, bodyOk: unknown, code: string): boolean {
  if (bodyOk !== false || !code.startsWith("gpu_") || (status !== 500 && status !== 503)) return false;
  return statusForRawDebugResult({ ok: false, error: { code, message: "" }, warnings: [] }) === status;
}
