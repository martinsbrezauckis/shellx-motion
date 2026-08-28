/** Read-only v1 flat-record compatibility for static layouts created before pair journaling. */
import { join } from "node:path";
import {
  assertCurrentAuthorityDirectory,
  readImmutableJson,
  type TrustedAuthorityDirectory,
} from "./timeline-layout-application-authority-store.js";

export async function readLegacyStaticAuthority(
  directory: TrustedAuthorityDirectory,
  authorityKey: string,
  maximumBytes: number,
): Promise<unknown> {
  await assertCurrentAuthorityDirectory(directory);
  const value = await readImmutableJson(join(directory.path, `${authorityKey}.authority.json`), maximumBytes);
  await assertCurrentAuthorityDirectory(directory);
  return value;
}

export async function readLegacyStaticReceipt(
  directory: TrustedAuthorityDirectory,
  authorityKey: string,
  maximumBytes: number,
): Promise<unknown> {
  const value = await readImmutableJson(join(directory.path, `${authorityKey}.receipt.json`), maximumBytes);
  await assertCurrentAuthorityDirectory(directory);
  return value;
}
