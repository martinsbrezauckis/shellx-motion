/** Race-resistant verification for package-local operation receipts. */
import { hashBuffer, type OperationReceipt } from "@shellx-motion/core";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const MAX_RECEIPT_BYTES = 4 * 1024 * 1024;

export async function verifyPersistedReceipt(
  root: string,
  path: string,
  expected: Pick<OperationReceipt, "id" | "operation" | "status" | "packageId">,
  label = "operation receipt",
): Promise<string> {
  if (!inside(root, path)) throw new Error(`${label} must stay inside the output package.`);
  const [canonicalRoot, info] = await Promise.all([realpath(root), lstat(path)]);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_RECEIPT_BYTES) {
    throw new Error(`${label} must be a bounded regular file.`);
  }
  const canonicalPath = await realpath(path);
  if (!inside(canonicalRoot, canonicalPath)) throw new Error(`${label} path is not canonical inside the output package.`);
  const handle = await open(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  let openedBefore: Stats;
  let openedAfter: Stats;
  try {
    openedBefore = await handle.stat();
    if (!openedBefore.isFile() || openedBefore.size > MAX_RECEIPT_BYTES) throw new Error(`${label} must be a bounded regular file.`);
    bytes = await handle.readFile();
    openedAfter = await handle.stat();
  } finally {
    await handle.close();
  }
  const after = await lstat(canonicalPath);
  if (info.dev !== openedBefore.dev || info.ino !== openedBefore.ino
    || openedBefore.dev !== openedAfter.dev || openedBefore.ino !== openedAfter.ino
    || openedBefore.size !== openedAfter.size || openedBefore.mtimeMs !== openedAfter.mtimeMs
    || openedAfter.dev !== after.dev || openedAfter.ino !== after.ino
    || openedAfter.size !== after.size || openedAfter.mtimeMs !== after.mtimeMs) {
    throw new Error(`${label} changed while it was being verified.`);
  }
  const disk = dataRecord(JSON.parse(bytes.toString("utf8")), `${label} file`);
  if (disk.schema !== "shellx-motion/receipt@1" || disk.id !== expected.id || disk.operation !== expected.operation
    || disk.status !== expected.status || disk.packageId !== expected.packageId) {
    throw new Error(`${label} file does not match the operation result.`);
  }
  return hashBuffer(bytes);
}

function dataRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function inside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}
