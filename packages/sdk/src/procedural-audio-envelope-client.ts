/** SDK transport guards for the bounded procedural audio-envelope action. */

export function proceduralAudioEnvelopeRequestProblem(input: Record<string, unknown>): string | null {
  if (!safeId(input.sourceLayerId) || !safeId(input.envelopeId)) {
    return "SDK proceduralAudioEnvelopeProduce requires safe sourceLayerId and envelopeId.";
  }
  if (input.sampleEveryMs !== undefined && !numberInRange(input.sampleEveryMs, 16, 1_000)) {
    return "SDK proceduralAudioEnvelopeProduce sampleEveryMs must be a finite number from 16 to 1000.";
  }
  return input.channel !== undefined && input.channel !== "mix"
    ? 'SDK proceduralAudioEnvelopeProduce channel must be "mix".'
    : null;
}

export function hasMatchingProceduralAudioEnvelopeEvidence(
  value: unknown,
  request: Record<string, unknown>,
): boolean {
  const evidence = plainRecord(value);
  const sampleEveryMs = request.sampleEveryMs ?? 50;
  return Boolean(evidence
    && evidence.id === request.envelopeId
    && evidence.sourceLayerId === request.sourceLayerId
    && evidence.channel === "mix"
    && evidence.sampleEveryMs === sampleEveryMs
    && positiveInteger(evidence.sampleCount)
    && sha256(evidence.samplesSha256));
}

export function hasPersistedProceduralAudioEnvelope(
  output: Record<string, unknown>,
  request: Record<string, unknown>,
): boolean {
  const state = plainRecord(output.state);
  const graph = plainRecord(state?.graph);
  const envelopes = Array.isArray(graph?.audioEnvelopes) ? graph.audioEnvelopes : [];
  return envelopes.some((item) => {
    const envelope = plainRecord(item);
    return envelope !== null && envelope.id === request.envelopeId
      && envelope.sourceLayerId === request.sourceLayerId && envelope.channel === "mix";
  });
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  const descriptors = Object.values(Object.getOwnPropertyDescriptors(value));
  return (prototype === Object.prototype || prototype === null)
    && descriptors.every((descriptor) => "value" in descriptor)
    ? value as Record<string, unknown>
    : null;
}
function safeId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value); }
function numberInRange(value: unknown, min: number, max: number): boolean { return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max; }
function positiveInteger(value: unknown): boolean { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function sha256(value: unknown): boolean { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
