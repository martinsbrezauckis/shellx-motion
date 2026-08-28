import type { OperationReceipt } from "@shellx-motion/core";
import type { CanvasPackageAssetEvidence } from "./package-writer";

interface CanvasPackageReceiptEvidence {
  manifestRef: string;
  motionRef: string;
  receiptRef: string;
  resourceCatalogRef: string;
  packageContentHashes: Record<string, { sha256: string; byteLength: number }>;
  assetRefs: string[];
  copiedAssetRefs: string[];
  missingAssetRefs: string[];
  assetEvidence: CanvasPackageAssetEvidence[];
}

/** The in-package receipt must remain valid when a caller rematerializes the closed package tree. */
export function enrichCanvasPackageReceipt(
  receipt: OperationReceipt,
  paths: CanvasPackageReceiptEvidence
): OperationReceipt {
  const output = readRecord(receipt.output) ?? {};
  const { packageDir: _discardCallerPackageDir, ...receiptOutput } = output;
  const inputHashes = packageRelativeInputHashes(receipt.inputHashes);
  const selectionPath = Object.keys(inputHashes)[0] ?? "input/canvas-selection.json";
  // Caller-side artifacts can legitimately be host locators. A rematerializable package receipt
  // carries only the two package-local roles it owns, never an upstream path claim.
  const artifacts: NonNullable<OperationReceipt["artifacts"]> = [
    { role: "motion_package", path: ".", status: "available", primary: true },
    { role: "canvas_frame_selection", path: selectionPath, status: "available" }
  ];
  return {
    ...receipt,
    inputHashes,
    output: {
      ...receiptOutput,
      packageRoot: ".",
      manifestPath: paths.manifestRef,
      motionPath: paths.motionRef,
      receiptPath: paths.receiptRef,
      resourceCatalogPath: paths.resourceCatalogRef,
      packageContentHashes: paths.packageContentHashes,
      assetRefs: paths.assetRefs,
      copiedAssetRefs: paths.copiedAssetRefs,
      missingAssetRefs: [],
      assetEvidence: paths.assetEvidence
    },
    artifacts,
    warnings: [...receipt.warnings]
  };
}

/** Keep content-address evidence while replacing a host path key with an opaque package locator. */
function packageRelativeInputHashes(inputHashes: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [index, [locator, sha256]] of Object.entries(inputHashes).entries()) {
    const relative = packageRelativeLocator(locator);
    const fallback = index === 0 ? "input/canvas-selection.json" : `input/evidence-${index + 1}`;
    const target = relative && result[relative] === undefined ? relative : fallback;
    result[target] = sha256;
  }
  return result;
}

function packageRelativeLocator(locator: string): string | undefined {
  const normalized = locator.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return undefined;
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return undefined;
  return normalized;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}
