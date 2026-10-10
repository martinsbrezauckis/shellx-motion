import { mkdir, realpath } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { canonicalJsonSha256 } from "./canonical-json";
import { MAX_BATCH_QUALITY_ROWS } from "./data-file-load";
import { hashBuffer } from "./receipts";
import {
  BoundedResourceBudget,
  readBudgetedStableFile,
  readBoundedStableFile,
  writeVerifiedBoundedFile,
  type StableFileReadResult,
} from "./stable-file-read";

const MAX_QUALITY_INPUT_BYTES = 4 * 1024 * 1024;
const MAX_QUALITY_MATERIALIZED_BYTES = MAX_QUALITY_INPUT_BYTES;
const MAX_QUALITY_BASELINES = 64;
const MAX_QUALITY_AGGREGATE_BYTES = 64 * 1024 * 1024;
export const MAX_BATCH_QUALITY_REQUEST_BYTES = 256 * 1024 * 1024;

/** Charges retained, expanded manifests across all rows in one batch request. */
export class BatchQualityDerivedBudget {
  private bytes = 0;

  constructor(readonly maxBytes = MAX_BATCH_QUALITY_REQUEST_BYTES) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("Batch quality derived byte limit is invalid.");
  }

  remaining(): number { return this.maxBytes - this.bytes; }

  reserve(bytes: number): void {
    if (bytes > this.remaining()) throw new Error(`Batch quality materialized manifests exceed the ${this.maxBytes}-byte aggregate limit.`);
    this.bytes += bytes;
  }
}

export function createBatchQualityRequestBudget(): BoundedResourceBudget {
  return new BoundedResourceBudget({
    maxFileBytes: MAX_QUALITY_INPUT_BYTES,
    maxFiles: MAX_BATCH_QUALITY_ROWS * (MAX_QUALITY_BASELINES + 1),
    maxPathDepth: 16,
    maxAggregateBytes: MAX_BATCH_QUALITY_REQUEST_BYTES,
    maxConcurrentReads: 1,
  }, "batch quality request input closure");
}

export interface BatchQualityManifestContext {
  values: Readonly<Record<string, unknown>>;
  rowId: string;
  rowIndex: number;
  rowHash: string;
  rowKey?: string;
  packageId: string;
  packageDir: string;
  outputPath: string;
}

export interface BatchQualityBaselineSnapshot {
  sampleIndex: number;
  sourcePath: string;
  sourceReference: string;
  bytes: Buffer;
  byteLength: number;
  sha256: string;
}

export interface PreparedBatchQualityManifestSnapshot {
  sourcePath: string;
  sourceSha256: string;
  materializedManifest: Record<string, unknown>;
  materializedManifestSha256: string;
  baselinesSha256: string;
  closureSha256: string;
  baselines: readonly BatchQualityBaselineSnapshot[];
}

export interface PublishedBatchQualityManifestSnapshot {
  path: string;
  appliedPath: string;
  appliedManifestSha256: string;
  sourceSha256: string;
  materializedManifestSha256: string;
  baselinesSha256: string;
  closureSha256: string;
  baselines: ReadonlyArray<{ sampleIndex: number; sourcePath: string; appliedPath: string; sha256: string }>;
}

export interface BatchQualityInputEvidence {
  manifestSha256: string;
  materializedManifestSha256: string;
  baselinesSha256: string;
  closureSha256: string;
}

export function batchQualityInputEvidence(
  snapshot: PreparedBatchQualityManifestSnapshot,
): BatchQualityInputEvidence {
  return {
    manifestSha256: snapshot.sourceSha256,
    materializedManifestSha256: snapshot.materializedManifestSha256,
    baselinesSha256: snapshot.baselinesSha256,
    closureSha256: snapshot.closureSha256,
  };
}

/** Retain one exact per-row manifest and every baseline byte before resume identity is decided. */
export async function prepareBatchQualityManifestSnapshot(input: {
  sourcePath: string;
  context: BatchQualityManifestContext;
  requestBudget?: BoundedResourceBudget;
  derivedBudget?: BatchQualityDerivedBudget;
  interpolate?: boolean;
}): Promise<PreparedBatchQualityManifestSnapshot> {
  const sourcePath = resolve(input.sourcePath);
  const sourceRoot = await realpath(dirname(sourcePath));
  const budget = input.requestBudget ?? new BoundedResourceBudget({
    maxFileBytes: MAX_QUALITY_INPUT_BYTES,
    maxFiles: MAX_QUALITY_BASELINES + 1,
    maxPathDepth: 16,
    maxAggregateBytes: MAX_QUALITY_AGGREGATE_BYTES,
    maxConcurrentReads: 1,
  }, "batch quality input closure");
  const source = await readBudgetedStableFile(sourcePath, {
    label: "batch quality manifest",
    budget,
    withinRoot: sourceRoot,
  });
  const parsed = parseManifest(source.bytes);
  const remaining = input.derivedBudget?.remaining();
  const aggregateBound = remaining !== undefined && remaining < MAX_QUALITY_MATERIALIZED_BYTES;
  const limit = Math.min(MAX_QUALITY_MATERIALIZED_BYTES, remaining ?? MAX_QUALITY_MATERIALIZED_BYTES);
  const materialization = new ManifestMaterializationBudget(limit, aggregateBound
    ? `Batch quality materialized manifests exceed the ${input.derivedBudget!.maxBytes}-byte aggregate limit before expansion or hashing.`
    : `Batch quality materialized manifest exceeds its ${MAX_QUALITY_MATERIALIZED_BYTES}-byte serialized JSON limit before expansion or hashing.`);
  const materialized = interpolateValue(parsed, input.interpolate === false ? null : {
    ...input.context.values,
    rowId: input.context.rowId,
    rowIndex: input.context.rowIndex,
    rowHash: input.context.rowHash,
    rowKey: input.context.rowKey,
    packageId: input.context.packageId,
    packageDir: input.context.packageDir,
    outputPath: input.context.outputPath,
  }, materialization);
  const manifest = objectRecord(materialized);
  if (!manifest || manifest.schema !== "shellx-motion/quality-manifest@1"
    || !Array.isArray(manifest.samples) || manifest.samples.length === 0) {
    throw new Error("Batch quality manifest must be a non-empty shellx-motion/quality-manifest@1 samples array.");
  }
  input.derivedBudget?.reserve(materialization.bytes);

  const baselines: BatchQualityBaselineSnapshot[] = [];
  for (let sampleIndex = 0; sampleIndex < manifest.samples.length; sampleIndex += 1) {
    const sample = objectRecord(manifest.samples[sampleIndex]);
    const reference = typeof sample?.baseline === "string" ? sample.baseline.trim() : "";
    if (!reference) continue;
    if (baselines.length >= MAX_QUALITY_BASELINES) {
      throw new Error(`Batch quality manifest exceeds its ${MAX_QUALITY_BASELINES}-baseline snapshot budget.`);
    }
    const baselinePath = isAbsolute(reference) ? resolve(reference) : resolve(sourceRoot, reference);
    const baseline = await readBudgetedStableFile(baselinePath, {
      label: `batch quality baseline ${sampleIndex + 1}`,
      budget,
      withinRoot: sourceRoot,
    });
    baselines.push({ sampleIndex, sourcePath: baseline.canonicalPath, sourceReference: reference, ...baseline });
  }

  const materializedManifestSha256 = canonicalJsonSha256(manifest);
  const baselinesSha256 = canonicalJsonSha256({
    schema: "shellx-motion/batch-quality-baselines@1",
    baselines: baselines.map(({ sampleIndex, sourceReference, byteLength, sha256 }) => ({
      sampleIndex, sourceReference, byteLength, sha256,
    })),
  });
  const sourceSha256 = source.sha256;
  const closureSha256 = canonicalJsonSha256({
    schema: "shellx-motion/batch-quality-inputs@1",
    sourceSha256,
    materializedManifestSha256,
    baselinesSha256,
  });
  return {
    sourcePath,
    sourceSha256,
    materializedManifest: manifest,
    materializedManifestSha256,
    baselinesSha256,
    closureSha256,
    baselines,
  };
}

/** Publish the retained bytes into a private content-addressed directory used by evaluation. */
export async function publishBatchQualityManifestSnapshot(input: {
  snapshot: PreparedBatchQualityManifestSnapshot;
  targetRoot: string;
}): Promise<PublishedBatchQualityManifestSnapshot> {
  const root = resolve(input.targetRoot);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const baselinePaths = new Map<number, string>();
  const publishedBaselines: Array<{ sampleIndex: number; sourcePath: string; appliedPath: string; sha256: string }> = [];
  for (const baseline of input.snapshot.baselines) {
    const extension = safeExtension(baseline.sourcePath);
    const path = join(root, `baseline-${String(baseline.sampleIndex).padStart(3, "0")}-${baseline.sha256.slice(0, 16)}${extension}`);
    await publishOrVerify(path, baseline.bytes, root, `batch quality baseline ${baseline.sampleIndex + 1}`, baseline.sha256);
    baselinePaths.set(baseline.sampleIndex, path);
    publishedBaselines.push({ sampleIndex: baseline.sampleIndex, sourcePath: baseline.sourcePath, appliedPath: path, sha256: baseline.sha256 });
  }
  const manifest = {
    ...input.snapshot.materializedManifest,
    samples: (input.snapshot.materializedManifest.samples as unknown[]).map((sample, sampleIndex) => {
      const record = objectRecord(sample);
      const baseline = baselinePaths.get(sampleIndex);
      return record && baseline ? { ...record, baseline } : sample;
    }),
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const appliedManifestSha256 = hashBuffer(manifestBytes);
  const path = join(root, `manifest-${input.snapshot.closureSha256.slice(0, 24)}.json`);
  await publishOrVerify(path, manifestBytes, root, "batch quality manifest snapshot", appliedManifestSha256);
  return {
    path,
    appliedPath: path,
    appliedManifestSha256,
    sourceSha256: input.snapshot.sourceSha256,
    materializedManifestSha256: input.snapshot.materializedManifestSha256,
    baselinesSha256: input.snapshot.baselinesSha256,
    closureSha256: input.snapshot.closureSha256,
    baselines: publishedBaselines,
  };
}

function parseManifest(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Batch quality manifest contains invalid JSON.");
  }
}

function interpolateValue(value: unknown, context: Record<string, unknown> | null, budget: ManifestMaterializationBudget): unknown {
  if (typeof value === "string") {
    if (!context) { budget.reserve(Buffer.byteLength(JSON.stringify(value), "utf8")); return value; }
    const pattern = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;
    const parts: string[] = [];
    const counter = new JsonStringByteCounter();
    let cursor = 0;
    for (let match = pattern.exec(value); match; match = pattern.exec(value)) {
      const literal = value.slice(cursor, match.index);
      counter.append(literal); parts.push(literal);
      const replacement = context[match[1]];
      const text = replacement === undefined || replacement === null ? "" :
        typeof replacement === "string" ? replacement : JSON.stringify(replacement);
      counter.append(text); parts.push(text);
      budget.assertCanReserve(counter.bytes + 2);
      cursor = match.index + match[0].length;
    }
    const tail = value.slice(cursor);
    counter.append(tail); parts.push(tail);
    budget.reserve(counter.finish() + 2);
    return parts.join("");
  }
  if (Array.isArray(value)) {
    budget.reserve(2 + Math.max(0, value.length - 1));
    return value.map((entry) => interpolateValue(entry, context, budget));
  }
  const record = objectRecord(value);
  if (record) {
    const entries = Object.entries(record);
    budget.reserve(2 + Math.max(0, entries.length - 1));
    return Object.fromEntries(entries.map(([key, entry]) => {
      budget.reserve(Buffer.byteLength(JSON.stringify(key), "utf8") + 1);
      return [key, interpolateValue(entry, context, budget)];
    }));
  }
  budget.reserve(Buffer.byteLength(JSON.stringify(value), "utf8"));
  return value;
}

class ManifestMaterializationBudget {
  bytes = 0;
  constructor(private readonly limit: number, private readonly error: string) {}
  assertCanReserve(bytes: number): void {
    if (this.bytes + bytes > this.limit) throw new Error(this.error);
  }
  reserve(bytes: number): void { this.assertCanReserve(bytes); this.bytes += bytes; }
}

/** Count JSON string bytes across fragments, including escaping and split surrogate pairs. */
class JsonStringByteCounter {
  bytes = 0;
  private highSurrogate = false;
  append(part: string): void {
    for (let index = 0; index < part.length; index += 1) {
      const code = part.charCodeAt(index);
      if (this.highSurrogate) {
        this.bytes += code >= 0xdc00 && code <= 0xdfff ? 4 : 6;
        this.highSurrogate = false;
        if (code >= 0xdc00 && code <= 0xdfff) continue;
      }
      if (code >= 0xd800 && code <= 0xdbff) { this.highSurrogate = true; continue; }
      if (code >= 0xdc00 && code <= 0xdfff) this.bytes += 6;
      else if (code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13) this.bytes += 2;
      else if (code < 32) this.bytes += 6;
      else if (code < 128) this.bytes += 1;
      else if (code < 2048) this.bytes += 2;
      else this.bytes += 3;
    }
  }
  finish(): number { return this.bytes + (this.highSurrogate ? 6 : 0); }
}

async function publishOrVerify(path: string, bytes: Buffer, root: string, label: string, sha256: string): Promise<StableFileReadResult> {
  try {
    return await writeVerifiedBoundedFile(path, bytes, { label, maxBytes: MAX_QUALITY_INPUT_BYTES, withinRoot: root, expectedSha256: sha256 });
  } catch (error) {
    if (objectRecord(error)?.code !== "EEXIST") throw error;
    const existing = await readBoundedStableFile(path, { label, maxBytes: MAX_QUALITY_INPUT_BYTES, withinRoot: root });
    if (existing.sha256 !== sha256 || existing.byteLength !== bytes.byteLength) throw new Error(`${label} conflicts with its retained snapshot.`);
    return existing;
  }
}

function safeExtension(path: string): string {
  const extension = extname(path).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(extension) ? extension : ".bin";
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
