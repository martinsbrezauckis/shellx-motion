import { lstat, mkdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { activeTrustedWorkspaceAnchorForTarget, type TrustedWorkspaceAnchorRoute } from "./output-path-trusted-workspace";

export type TrustedWorkspaceCapturedDirectory = {
  path: string;
  dev: number;
  ino: number;
  requiresChildWrite: boolean;
};

export type TrustedWorkspaceParentRoute = {
  directories: TrustedWorkspaceCapturedDirectory[];
  trustedWorkspaceAnchor: TrustedWorkspaceAnchorRoute;
};

/** Captures only the route below a currently scoped host anchor. */
export async function captureTrustedWorkspaceParentRoute(
  parentPath: string,
  targetPath: string,
  createMissing: boolean,
  inspectDirectory: (path: string, requiresChildWrite: boolean) => Promise<{ dev: number; ino: number }>
): Promise<TrustedWorkspaceParentRoute | undefined> {
  const trustedWorkspaceAnchor = await activeTrustedWorkspaceAnchorForTarget(targetPath);
  if (!trustedWorkspaceAnchor) return undefined;
  const directories: TrustedWorkspaceCapturedDirectory[] = [{
    path: trustedWorkspaceAnchor.path,
    ...trustedWorkspaceAnchor.identity,
    requiresChildWrite: parentPath === trustedWorkspaceAnchor.path
  }];
  let current = trustedWorkspaceAnchor.path;
  for (const part of relative(current, parentPath).split(sep).filter(Boolean)) {
    current = join(current, part);
    const existing = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!existing) {
      if (!createMissing) return { directories, trustedWorkspaceAnchor };
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    const facts = await inspectDirectory(current, current === parentPath);
    directories.push({ path: current, ...facts, requiresChildWrite: current === parentPath });
  }
  return { directories, trustedWorkspaceAnchor };
}
