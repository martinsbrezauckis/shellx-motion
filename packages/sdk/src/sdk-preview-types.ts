/** SDK contract for normal browser previews and the strict general GPU PNG preview. */
export interface MotionSdkPreviewRequest {
  packageRoot: string;
  outDir: string;
  /** browser is the browser preview lane; gpu is strict general hardware WebGPU PNG with no CPU/browser fallback. */
  lane?: "browser" | "gpu";
  atMs?: number;
  workflowPath?: string;
}

export interface MotionSdkPreviewResponse {
  packageId: string;
  motionId: string;
  lane: "browser" | "gpu";
  frame: {
    path: string;
    sha256: string;
    width: number;
    height: number;
    atMs: number;
    mediaType: "image/png" | "image/jpeg";
  };
  receiptId: string;
  receiptPath?: string;
  warnings: string[];
}
