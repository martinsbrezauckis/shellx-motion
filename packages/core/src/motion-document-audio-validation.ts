import { assertMotionAudioMasterDuration, normalizeMotionAudioMaster } from "./audio-master";

export function validateMotionDocumentAudioMaster(
  value: unknown,
  errors: Array<{ path: string; message: string }>,
  durationMs?: unknown
): void {
  if (value === undefined) return;
  const audio = plainRecord(value);
  if (!audio) {
    errors.push({ path: "/audio", message: "must be an object" });
    return;
  }
  for (const key of Object.keys(audio)) {
    if (key !== "master") errors.push({ path: `/audio/${key}`, message: "unsupported document-audio field" });
  }
  if (audio.master === undefined) return;
  try {
    const master = normalizeMotionAudioMaster(audio.master);
    if (master && isPositiveFiniteNumber(durationMs)) assertMotionAudioMasterDuration(master, durationMs);
  } catch (error) {
    errors.push({ path: "/audio/master", message: error instanceof Error ? error.message : "must be a valid audio master" });
  }
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
