import type { MotionSdkError, MotionSdkOperation } from "./types.js";

export function validateGltfRequest(
  operation: MotionSdkOperation,
  input: Record<string, unknown>,
): MotionSdkError | null {
  if (operation !== "gltfImport") return null;
  if (!absolutePath(input.sourcePath) || !/\.(?:gltf|glb)$/i.test(String(input.sourcePath))) {
    return invalid("SDK gltfImport sourcePath must be an absolute .gltf or .glb path.");
  }
  if (!absolutePath(input.outDir)) {
    return invalid("SDK gltfImport outDir must be an absolute path.");
  }
  return null;
}

export function validateGltfOutput(
  operation: MotionSdkOperation,
  output: Record<string, unknown>,
  requestInput: unknown,
): MotionSdkError | null {
  if (operation !== "gltfImport") return null;
  const request = plainRecord(requestInput);
  const receipt = plainRecord(output.receipt);
  const pkg = plainRecord(output.package);
  const expectedFormat = typeof request?.sourcePath === "string" && /\.glb$/i.test(request.sourcePath)
    ? "glb"
    : "gltf";
  if (!request
    || output.packageRoot !== request.outDir
    || !pkg
    || output.format !== expectedFormat
    || !absolutePath(output.sourcePath)
    || !absolutePath(output.normalizedSourcePath)
    || !sha256(output.sourceSha256)
    || !sha256Array(output.bufferSha256, 4)
    || !positiveInteger(output.sourceByteLength)
    || !receipt
    || receipt.schema !== "shellx-motion/receipt@1"
    || receipt.operation !== "adapter.lower"
    || receipt.packageId !== pkg.packageId
    || (receipt.status !== "passed" && receipt.status !== "warning")
    || !nonEmpty(receipt.id)
    || !absolutePath(receipt.path)
    || !sha256(receipt.sha256)) {
    return invalidTransport("SDK gltfImport output requires matching package, source, and receipt evidence.");
  }
  return null;
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  if (Object.getOwnPropertySymbols(value).length > 0) return null;
  const descriptors = Object.values(Object.getOwnPropertyDescriptors(value));
  return descriptors.every((descriptor) => "value" in descriptor)
    ? value as Record<string, unknown>
    : null;
}

function absolutePath(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 1
    && !value.includes("\0")
    && (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value));
}

function sha256(value: unknown): boolean {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function sha256Array(value: unknown, max: number): boolean {
  return Array.isArray(value) && value.length > 0 && value.length <= max && value.every(sha256);
}

function nonEmpty(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function positiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function invalid(message: string): MotionSdkError {
  return { code: "invalid_request", message, retryable: false };
}

function invalidTransport(message: string): MotionSdkError {
  return { code: "invalid_transport_response", message, retryable: false };
}
