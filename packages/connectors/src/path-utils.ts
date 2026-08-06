import { resolve } from "node:path";

export function normalizeWindowsExtendedPath(path: string): string {
  return path
    .replace(/^\\+\?\\+UNC\\+/i, "\\\\")
    .replace(/^\\+\?\\+/, "");
}

export function resolveConnectorPath(path: string): string {
  const normalizedPath = normalizeWindowsExtendedPath(path);
  if (isWindowsAbsolutePath(normalizedPath)) return normalizedPath;
  return resolve(normalizedPath);
}

function isWindowsAbsolutePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\]/.test(path);
}
