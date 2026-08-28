/** Internal closed-inventory capture for a host-anchored package, not a private output stage. */

import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  captureCompleteExactDirectoryInventoryAt,
  captureCompleteExactDirectoryInventoryWithEmptyDirectoriesAt,
  type CompleteDirectoryInventorySnapshot,
  type ExactDirectoryInventorySnapshot
} from "./closed-directory-inventory";
import { assertTrustedWorkspaceAnchorPath, withTrustedWorkspaceAnchor, type TrustedWorkspaceAnchor } from "./output-path-trusted-workspace";
import type { OutputPathIdentity } from "./output-path-topology";

export interface TrustedWorkspaceDirectoryInventoryRequest {
  readonly workspaceRoot: string;
  readonly workspaceAuthority: TrustedWorkspaceAnchor;
  readonly directory: string;
  readonly identity: OutputPathIdentity;
  readonly label: string;
}

/** Capture the complete descriptor-relative inventory of one strict host-workspace descendant. */
export async function captureTrustedWorkspaceCompleteDirectoryInventory(
  request: TrustedWorkspaceDirectoryInventoryRequest,
): Promise<ExactDirectoryInventorySnapshot> {
  const workspace = resolve(request.workspaceRoot), directory = resolve(request.directory);
  if (!strictDescendant(workspace, directory)) throw new Error(`${request.label} must be a strict descendant of its trusted workspace.`);
  await assertTrustedWorkspaceAnchorPath(request.workspaceAuthority, workspace);
  return await withTrustedWorkspaceAnchor(request.workspaceAuthority, async () =>
    await captureCompleteExactDirectoryInventoryAt(directory, request.identity, request.label));
}

/** Explicit opt-in trusted-workspace capture retaining empty package directories. */
export async function captureTrustedWorkspaceCompleteDirectoryInventoryWithEmptyDirectories(
  request: TrustedWorkspaceDirectoryInventoryRequest,
): Promise<CompleteDirectoryInventorySnapshot> {
  const workspace = resolve(request.workspaceRoot), directory = resolve(request.directory);
  if (!strictDescendant(workspace, directory)) throw new Error(`${request.label} must be a strict descendant of its trusted workspace.`);
  await assertTrustedWorkspaceAnchorPath(request.workspaceAuthority, workspace);
  return await withTrustedWorkspaceAnchor(request.workspaceAuthority, async () =>
    await captureCompleteExactDirectoryInventoryWithEmptyDirectoriesAt(directory, request.identity, request.label));
}

function strictDescendant(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix !== "" && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}
