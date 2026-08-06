/**
 * Bounded discovery of receipt-shaped JSON inside a receipt store.
 *
 * Role: walk a receipts root and hand back the `.json` files under it, then the subset of those that
 * are platform-verification documents. Every read path in the debug API — receipts read/list, agent
 * transcript, the prompt queue, the platform panel — starts here.
 *
 * The four caps are the whole point of the module having a name. A receipts root is a directory a
 * host declared, not a directory Motion created, so it may be enormous, deeply nested, or pointed at
 * a filesystem the operator did not think about. Unbounded recursion over one turns a read command
 * into an accidental filesystem crawl that never returns, and the caps are shared state threaded
 * through the recursion so a wide tree and a deep tree are both bounded by ONE budget rather than
 * one budget per directory. Sorting is `compareCodeUnits` and not the default comparator: the order
 * these files come back in reaches receipt listings, so it must not depend on the machine's locale.
 *
 * Extracted from `index.ts` rather than left inline: that file carries a declared non-growth
 * baseline in `scripts/module-size-gate.mjs`, and "how a receipt store is enumerated, and how much
 * of it we are willing to look at" is a coherent unit.
 *
 * Primary caller: `index.ts`.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { compareCodeUnits } from "@shellx-motion/core";

export const MAX_DEBUG_JSON_DISCOVERY_DEPTH = 16;
export const MAX_DEBUG_JSON_DISCOVERY_FILES = 10_000;
export const MAX_DEBUG_JSON_DISCOVERY_ENTRIES = 20_000;
/** Refuse to buffer a "receipt" larger than this; a receipt is metadata, never a payload. */
export const MAX_DEBUG_RECEIPT_BYTES = 4 * 1024 * 1024;

export interface PlatformReceiptEntry {
  path: string;
  receipt: Record<string, unknown>;
}

/**
 * List the `.json` files under a root, depth- and count-bounded.
 *
 * @param root directory to walk. A missing or unreadable directory yields an empty list rather than
 *   throwing: a read command over a store that does not exist yet is an empty read, not an error.
 * @param state shared budget across the whole walk; callers pass nothing.
 * @param depth current recursion depth; callers pass nothing.
 */
export async function discoverJsonFiles(
  root: string,
  state: { fileCount: number; entryCount: number } = { fileCount: 0, entryCount: 0 },
  depth = 0
): Promise<string[]> {
  if (depth > MAX_DEBUG_JSON_DISCOVERY_DEPTH
    || state.fileCount >= MAX_DEBUG_JSON_DISCOVERY_FILES
    || state.entryCount >= MAX_DEBUG_JSON_DISCOVERY_ENTRIES) return [];
  try {
    const dirents = (await readdir(root, { withFileTypes: true, encoding: "utf8" }))
      .sort((left, right) => compareCodeUnits(left.name, right.name));
    const files: string[] = [];
    for (const dirent of dirents) {
      if (state.fileCount >= MAX_DEBUG_JSON_DISCOVERY_FILES || state.entryCount >= MAX_DEBUG_JSON_DISCOVERY_ENTRIES) break;
      state.entryCount += 1;
      const path = join(root, dirent.name);
      if (dirent.isDirectory()) {
        files.push(...await discoverJsonFiles(path, state, depth + 1));
      } else if (dirent.isFile() && dirent.name.endsWith(".json")) {
        files.push(path);
        state.fileCount += 1;
      }
    }
    return files;
  } catch {
    return [];
  }
}

/** Parse a file only if it declares one of the two platform-verification schemas. */
export async function readPlatformReceiptFile(path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const record = Object.fromEntries(Object.entries(parsed as Record<string, unknown>));
    return record.schema === "shellx-motion/platform-verification@1" || record.schema === "shellx-motion/platform-verification-aggregate@1"
      ? record
      : null;
  } catch {
    return null;
  }
}

/** Every platform-verification document under a root, in stable path order. */
export async function readPlatformReceiptEntries(receiptsRoot: string): Promise<PlatformReceiptEntry[]> {
  const files = await discoverJsonFiles(receiptsRoot);
  const entries: PlatformReceiptEntry[] = [];
  for (const path of files) {
    const receipt = await readPlatformReceiptFile(path);
    if (receipt) entries.push({ path, receipt });
  }
  return entries.sort((a, b) => compareCodeUnits(a.path, b.path));
}
