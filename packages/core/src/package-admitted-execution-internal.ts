/**
 * Internal renderer lookup for Core-minted admitted package snapshots.
 *
 * The public Core barrel deliberately omits this module. It exposes only a WeakMap lookup; the
 * registrar stays module-private to Core's admitted-file loader, so a caller cannot mint an
 * execution authority for an arbitrary MotionPackage.
 */
export { admittedPackageExecutionSnapshot } from "./package-admitted-execution-store";
export type { AdmittedPackageExecutionSnapshot } from "./package-admitted-execution-store";
