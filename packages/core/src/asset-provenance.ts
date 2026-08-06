export type GeneratedAssetRoute = "codex-subscription-cli" | "grok-build-cli" | "bundled-sample";
export type GeneratedAssetStatus = "available" | "planned" | "failed";

export interface GeneratedAssetReceipt {
  schema: "shellx-motion/generated-asset-receipt@1";
  id: string;
  packageId: string;
  generatorRoute: GeneratedAssetRoute;
  assetRef: string;
  mediaType: string;
  promptSummary: string;
  toolLabel: string;
  modelLabel?: string;
  provenanceNote: string;
  contentSha256: string;
  width?: number;
  height?: number;
  durationMs?: number;
  createdAt: string;
  status: GeneratedAssetStatus;
}

export interface BuildGeneratedAssetReceiptInput {
  id?: string;
  packageId: string;
  generatorRoute: GeneratedAssetRoute;
  assetRef: string;
  mediaType: string;
  promptSummary: string;
  toolLabel: string;
  modelLabel?: string;
  provenanceNote: string;
  contentSha256: string;
  width?: number;
  height?: number;
  durationMs?: number;
  createdAt?: string;
  status?: GeneratedAssetStatus;
}

export type GeneratedAssetReceiptValidationResult =
  | { ok: true; receipt: GeneratedAssetReceipt }
  | { ok: false; errors: string[] };

export function buildGeneratedAssetReceipt(input: BuildGeneratedAssetReceiptInput): GeneratedAssetReceipt {
  const receipt: GeneratedAssetReceipt = {
    schema: "shellx-motion/generated-asset-receipt@1",
    id: input.id ?? generatedAssetReceiptId(input.packageId, input.assetRef),
    packageId: input.packageId,
    generatorRoute: input.generatorRoute,
    assetRef: input.assetRef,
    mediaType: input.mediaType,
    promptSummary: input.promptSummary,
    toolLabel: input.toolLabel,
    ...(input.modelLabel !== undefined ? { modelLabel: input.modelLabel } : {}),
    provenanceNote: input.provenanceNote,
    contentSha256: input.contentSha256,
    ...(input.width !== undefined ? { width: input.width } : {}),
    ...(input.height !== undefined ? { height: input.height } : {}),
    ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
    createdAt: input.createdAt ?? new Date().toISOString(),
    status: input.status ?? "available"
  };

  const validated = validateGeneratedAssetReceipt(receipt);
  if (!validated.ok) throw new Error(validated.errors[0] ?? "generated asset receipt is invalid");
  return receipt;
}

export function validateGeneratedAssetReceipt(value: unknown): GeneratedAssetReceiptValidationResult {
  const record = objectRecord(value);
  if (!record) return { ok: false, errors: ["generated asset receipt must be an object."] };

  const errors: string[] = [];
  if (record.schema !== "shellx-motion/generated-asset-receipt@1") {
    errors.push("schema must be shellx-motion/generated-asset-receipt@1.");
  }
  if (!nonEmptyString(record.id)) errors.push("id must be a non-empty string.");
  if (!nonEmptyString(record.packageId)) errors.push("packageId must be a non-empty string.");
  if (!isGeneratedAssetRoute(record.generatorRoute)) {
    errors.push("generatorRoute must be codex-subscription-cli, grok-build-cli, or bundled-sample.");
  }
  if (!isPackageAssetRef(record.assetRef)) errors.push("assetRef must be a package-local assets/ path.");
  if (!nonEmptyString(record.mediaType)) errors.push("mediaType must be a non-empty string.");
  if (!nonEmptyString(record.promptSummary)) errors.push("promptSummary must be a non-empty string.");
  if (!nonEmptyString(record.toolLabel)) errors.push("toolLabel must be a non-empty string.");
  if (record.modelLabel !== undefined && !nonEmptyString(record.modelLabel)) {
    errors.push("modelLabel must be a non-empty string when provided.");
  }
  if (!nonEmptyString(record.provenanceNote)) errors.push("provenanceNote must be a non-empty string.");
  if (!isSha256(record.contentSha256)) errors.push("contentSha256 must be a 64-character lowercase sha256 hash.");
  if (record.width !== undefined && !isPositiveInteger(record.width)) errors.push("width must be a positive integer when provided.");
  if (record.height !== undefined && !isPositiveInteger(record.height)) errors.push("height must be a positive integer when provided.");
  if (record.durationMs !== undefined && !isPositiveInteger(record.durationMs)) {
    errors.push("durationMs must be a positive integer when provided.");
  }
  if (!nonEmptyString(record.createdAt)) errors.push("createdAt must be a non-empty string.");
  if (!isGeneratedAssetStatus(record.status)) errors.push("status must be available, planned, or failed.");

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, receipt: record as unknown as GeneratedAssetReceipt };
}

export function generatedAssetReceiptId(packageId: string, assetRef: string): string {
  return `generated_asset_${slugPart(packageId)}_${slugPart(assetRef)}`;
}

export function isPackageAssetRef(value: unknown): value is string {
  if (!nonEmptyString(value)) return false;
  if (!value.startsWith("assets/")) return false;
  if (value.includes("\\")) return false;
  if (value.startsWith("/") || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return false;
  return !value.split("/").includes("..");
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isGeneratedAssetRoute(value: unknown): value is GeneratedAssetRoute {
  return value === "codex-subscription-cli" || value === "grok-build-cli" || value === "bundled-sample";
}

function isGeneratedAssetStatus(value: unknown): value is GeneratedAssetStatus {
  return value === "available" || value === "planned" || value === "failed";
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function slugPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase();
}
