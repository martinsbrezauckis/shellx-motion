/**
 * Internal exact-tree capability for Motion-owned COW producers.
 *
 * This is deliberately not part of the ordinary Core SDK barrel: callers must already own a
 * private, identity-bound stage, and the only supported package surface is the explicit internal
 * subpath declared in package.json.
 */
export {
  assertCompleteExactDirectoryInventoryWithEmptyDirectoriesSnapshotAt,
  assertExactDirectoryInventorySnapshotAt,
  captureCompleteExactDirectoryInventoryWithEmptyDirectoriesSnapshotAt,
  captureCompleteExactDirectoryInventorySnapshotAt,
  isClosedDirectoryInventoryAmbiguity
} from "./derived-output-publication-private";
export {
  captureTrustedWorkspaceCompleteDirectoryInventory,
  captureTrustedWorkspaceCompleteDirectoryInventoryWithEmptyDirectories
} from "./closed-directory-inventory-trusted-workspace";
export { assertClosedDirectoryInventoryAvailable } from "./closed-directory-inventory-observe";
export type {
  TrustedWorkspaceDirectoryInventoryRequest
} from "./closed-directory-inventory-trusted-workspace";
export type {
  CompleteDirectoryInventoryEntry,
  CompleteDirectoryInventorySnapshot,
  ExactDirectoryInventoryEntry,
  ExactDirectoryInventorySnapshot
} from "./derived-output-publication-private";
