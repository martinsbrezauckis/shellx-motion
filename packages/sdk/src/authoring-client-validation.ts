import type { MotionSdkError, MotionSdkOperation } from "./types.js";
import {
  isCompositingOperation,
  validateCompositingOutput,
  validateCompositingRequest,
} from "./compositing-client.js";
import { validateGltfOutput, validateGltfRequest } from "./gltf-client.js";
import { isAudioOperation, validateAudioOutput, validateAudioRequest } from "./audio-client.js";
import {
  isCutoutRigOperation,
  validateCutoutRigOutput,
  validateCutoutRigRequest,
} from "./cutout-rig-client.js";
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
    ?? validateAudioRequest(operation, input)
    ?? validateProceduralRequest(operation, input)
    ?? validateCutoutRigRequest(operation, input);
}

export function validateAuthoringOutput(
  operation: MotionSdkOperation,
  output: Record<string, unknown>,
  requestInput: unknown,
): MotionSdkError | null {
  return validateCompositingOutput(operation, output, requestInput)
    ?? validateGltfOutput(operation, output, requestInput)
    ?? validateAudioOutput(operation, output, requestInput)
    ?? validateProceduralOutput(operation, output, requestInput)
    ?? validateCutoutRigOutput(operation, output, requestInput);
}

export function isAuthoringPackageOperation(operation: MotionSdkOperation): boolean {
  return operation === "gltfImport" || isCompositingOperation(operation) || isAudioOperation(operation)
    || isProceduralOperation(operation) || isCutoutRigOperation(operation);
}
