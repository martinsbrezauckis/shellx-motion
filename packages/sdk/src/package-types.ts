/** Shared package and persisted receipt identities for SDK domain modules. */
export interface MotionSdkPackageIdentity {
  packageId: string;
  motionId: string;
  durationMs: number;
  fps: number;
  width: number;
  height: number;
  manifestSha256: string;
  motionSha256: string;
}

export interface MotionSdkPersistedReceipt<Operation extends string> {
  schema: "shellx-motion/receipt@1";
  id: string;
  packageId: string;
  operation: Operation;
  status: "passed";
  path: string;
  sha256: string;
}
