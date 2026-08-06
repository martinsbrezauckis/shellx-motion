import type { MotionSdkPackageIdentity } from "./package-types.js";

export interface MotionSdkGltfImportRequest {
  sourcePath: string;
  outDir: string;
  createdBy?: string;
  createdAt?: string;
}

export interface MotionSdkGltfImportReceipt {
  schema: "shellx-motion/receipt@1";
  id: string;
  packageId: string;
  operation: "adapter.lower";
  status: "passed" | "warning";
  path: string;
  sha256: string;
}

export interface MotionSdkGltfImportResponse {
  packageRoot: string;
  package: MotionSdkPackageIdentity;
  format: "gltf" | "glb";
  sourcePath: string;
  normalizedSourcePath: string;
  sourceSha256: string;
  bufferSha256: string[];
  sourceByteLength: number;
  receipt: MotionSdkGltfImportReceipt;
  warnings: string[];
}

declare module "./types.js" {
  interface MotionSdkRequestMap {
    gltfImport: MotionSdkGltfImportRequest;
  }

  interface MotionSdkResponseMap {
    gltfImport: MotionSdkGltfImportResponse;
  }

  interface MotionSdkClient {
    gltfImport(
      input: MotionSdkGltfImportRequest,
    ): Promise<MotionSdkResult<MotionSdkGltfImportResponse>>;
  }
}
