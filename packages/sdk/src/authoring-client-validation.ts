import type { MotionSdkError, MotionSdkOperation } from "./types.js";
import {
  isCompositingOperation,
  validateCompositingOutput,
  validateCompositingRequest,
} from "./compositing-client.js";
import { validateGltfOutput, validateGltfRequest } from "./gltf-client.js";
import {
  isProceduralOperation,
  validateProceduralOutput,
  validateProceduralRequest,
} from "./procedural-client.js";

export function validateAuthoringRequest(
  operation: MotionSdkOperation,
  input: Record<string, unknown>,
): MotionSdkError | null {
  return validateCompositingRequest(operation, input)
    ?? validateGltfRequest(operation, input)
    ?? validateProceduralRequest(operation, input);
}

export function validateAuthoringOutput(
  operation: MotionSdkOperation,
  output: Record<string, unknown>,
  requestInput: unknown,
): MotionSdkError | null {
  return validateCompositingOutput(operation, output, requestInput)
    ?? validateGltfOutput(operation, output, requestInput)
    ?? validateProceduralOutput(operation, output, requestInput);
}

export function isAuthoringPackageOperation(operation: MotionSdkOperation): boolean {
  return operation === "gltfImport" || isCompositingOperation(operation) || isProceduralOperation(operation);
}
