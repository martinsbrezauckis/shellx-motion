import { isPublicationCommitUncertain, type PublicationCommitUncertainEvidence } from "@shellx-motion/core";

export interface DebugPublicationUncertainty {
  readonly possiblyCommitted: true;
  readonly publicationCommitPhase?: string;
  readonly publicPaths: readonly string[];
  readonly expectedPublications: readonly PublicationCommitUncertainEvidence[];
}

/** Translate only Core-authenticated post-commit failures into a public envelope. */
export function corePublicationUncertainty(error: unknown): DebugPublicationUncertainty | undefined {
  if (!isPublicationCommitUncertain(error)) return undefined;
  return {
    possiblyCommitted: true,
    publicPaths: [error.evidence.publicPath],
    expectedPublications: [error.evidence]
  };
}

/**
 * Batch resume data predates the plural evidence envelope. Read its narrow migration aliases,
 * but always emit canonical plural fields to new receipts and responses.
 */
export function normalizePublicationUncertainty(...values: unknown[]): DebugPublicationUncertainty | undefined {
  const paths: string[] = [];
  const evidence: PublicationCommitUncertainEvidence[] = [];
  let marked = false;
  let phase: string | undefined;
  for (const value of values) {
    const record = recordOf(value);
    if (!record || record.possiblyCommitted !== true) continue;
    marked = true;
    if (phase === undefined && typeof record.publicationCommitPhase === "string") phase = record.publicationCommitPhase;
    addStrings(paths, record.publicPaths);
    addStrings(paths, record.publicPath);
    addStrings(paths, record.outputPath);
    addEvidence(evidence, record.expectedPublications);
    addEvidence(evidence, record.expectedPublication);
    addEvidence(evidence, record.expected);
  }
  if (!marked || paths.length === 0) return undefined;
  return {
    possiblyCommitted: true,
    ...(phase ? { publicationCommitPhase: phase } : {}),
    publicPaths: [...new Set(paths)],
    ...(evidence.length > 0 ? { expectedPublications: dedupeEvidence(evidence) } : { expectedPublications: [] })
  };
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function addStrings(target: string[], value: unknown): void {
  if (typeof value === "string") target.push(value);
  else if (Array.isArray(value)) target.push(...value.filter((item): item is string => typeof item === "string"));
}

function addEvidence(target: PublicationCommitUncertainEvidence[], value: unknown): void {
  if (Array.isArray(value)) target.push(...value.filter(isEvidence));
  else if (isEvidence(value)) target.push(value);
}

function isEvidence(value: unknown): value is PublicationCommitUncertainEvidence {
  const record = recordOf(value);
  return typeof record?.publicPath === "string" && (record.kind === "file" || record.kind === "directory") && record.expected !== undefined;
}

function dedupeEvidence(items: readonly PublicationCommitUncertainEvidence[]): PublicationCommitUncertainEvidence[] {
  const unique = new Map<string, PublicationCommitUncertainEvidence>();
  for (const item of items) unique.set(`${item.kind}:${item.publicPath}`, item);
  return [...unique.values()];
}
