import { hashBuffer } from "@shellx-motion/core";

export interface PreparedStaticVectorFile {
  path: string;
  bytes: Uint8Array;
  sha256: string;
}

export interface PreparedStaticVectorSource {
  primaryPath: string;
  primarySha256: string;
  loweringPath: string;
  loweringText: string;
  files: PreparedStaticVectorFile[];
  /** Bounded package-local sidecars admitted by a format-specific atomic authoring route. */
  packageFiles?: PreparedStaticVectorFile[];
  /** Package-visible media paths required by the lowered Motion document. */
  manifestAssets?: string[];
  manifestData?: Record<string, unknown>;
}

export function staticVectorPreparedFiles(prepared: PreparedStaticVectorSource): PreparedStaticVectorFile[] {
  return [...prepared.files, ...(prepared.packageFiles ?? [])];
}

export function assertPreparedStaticVectorSource(prepared: PreparedStaticVectorSource, formatLabel: string): void {
  const files = staticVectorPreparedFiles(prepared);
  if (prepared.files.length === 0 || files.length > 256) throw new Error(`${formatLabel} prepared source file count is invalid.`);
  const seen = new Set<string>();
  for (const file of prepared.files) assertPath(file, /^(?:source|assets)\/[A-Za-z0-9][A-Za-z0-9._/-]*$/, `${formatLabel} prepared source path is unsafe.`);
  for (const file of prepared.packageFiles ?? []) assertPath(file, /^(?:assets|scene3d|receipts)\/[A-Za-z0-9][A-Za-z0-9._/-]*$/, `${formatLabel} prepared package sidecar path is unsafe.`);
  for (const file of files) {
    const key = file.path.normalize("NFC").toLocaleLowerCase("en-US");
    if (seen.has(key)) throw new Error(`${formatLabel} prepared source paths are duplicated.`);
    seen.add(key);
    if (hashBuffer(Buffer.from(file.bytes)) !== file.sha256) throw new Error(`${formatLabel} prepared source hash does not match its bytes.`);
  }
  const primary = prepared.files.find((file) => file.path === prepared.primaryPath);
  const lowering = prepared.files.find((file) => file.path === prepared.loweringPath);
  if (!primary || primary.sha256 !== prepared.primarySha256 || !lowering) throw new Error(`${formatLabel} prepared source identity is incomplete.`);
  if (hashBuffer(Buffer.from(prepared.loweringText, "utf8")) !== lowering.sha256) throw new Error(`${formatLabel} lowering text does not match preserved bytes.`);
  const manifestAssets = prepared.manifestAssets ?? [];
  if (manifestAssets.length > 254 || new Set(manifestAssets).size !== manifestAssets.length) throw new Error(`${formatLabel} prepared manifest assets are invalid.`);
  for (const assetPath of manifestAssets) {
    if (!assetPath.startsWith("assets/") || !files.some((file) => file.path === assetPath)) throw new Error(`${formatLabel} prepared manifest asset ${assetPath} is not backed by prepared bytes.`);
  }
}

function assertPath(file: PreparedStaticVectorFile, pattern: RegExp, message: string): void {
  if (!pattern.test(file.path) || file.path.includes("\\") || file.path.split("/").some((part) => part === "." || part === ".." || part === "")) throw new Error(message);
}
