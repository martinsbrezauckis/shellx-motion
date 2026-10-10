import { constants } from "node:fs";
import { lstat, open, opendir, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { compareCodeUnits } from "./canonical-json";
import {
  activeReviewBundleReceiptTraversalTestHooks,
  type ReviewBundleReceiptTraversalTestHooks
} from "./internal/review-bundle-receipt-traversal-test-hooks";
import { ExistingDirectoryAuthority, type RetainedDirectoryAuthority } from "./output-path-topology";
import {
  BoundedResourceBudget,
  DEFAULT_HOST_INTERCHANGE_LIMITS,
  readBudgetedStableFile,
  type BoundedResourceLimits
} from "./stable-file-read";
import {
  assertApprovedReviewBundleReceiptsRoot,
  bindLoadedReviewBundleReceipt,
  MAX_REVIEW_BUNDLE_RECEIPT_BYTES,
  readReviewBundleReceipt,
  reviewReceiptRelativePath
} from "./review-bundle-stable-receipts";
import type { ReviewBundleReceiptEntry } from "./review-bundle-types";

export { MAX_REVIEW_BUNDLE_RECEIPT_BYTES } from "./review-bundle-stable-receipts";

/** Direct CLI receipt directories share the bounded host-interchange file/byte/depth contract. */
export const REVIEW_BUNDLE_RECEIPT_TRAVERSAL_LIMITS: Readonly<BoundedResourceLimits> = Object.freeze({
  ...DEFAULT_HOST_INTERCHANGE_LIMITS,
  maxFileBytes: MAX_REVIEW_BUNDLE_RECEIPT_BYTES,
  maxConcurrentReads: 1
});

/** Bound non-receipt directory noise before it can become unbounded traversal work. */
export const MAX_REVIEW_BUNDLE_RECEIPT_TREE_ENTRIES = 4_096;
/** Bound opened directories independently of candidate receipt-file admission. */
export const MAX_REVIEW_BUNDLE_RECEIPT_TREE_DIRECTORIES = 256;

/**
 * Read only receipt JSON files beneath one retained, approved root. This is the direct CLI
 * counterpart to Debug-to-Core stable-snapshot binding: the root retains its authority through
 * enumeration and every accepted leaf keeps its root-relative path, opened-file identity, and
 * digest private to Core for the publication recheck.
 */
export async function readReviewBundleReceiptEntries(
  receiptsRoot: string,
  retainedRootAuthority?: RetainedDirectoryAuthority
): Promise<ReviewBundleReceiptEntry[]> {
  return await readReviewBundleReceiptEntriesInternal(
    receiptsRoot,
    retainedRootAuthority,
    activeReviewBundleReceiptTraversalTestHooks()
  );
}

async function readReviewBundleReceiptEntriesInternal(
  receiptsRoot: string,
  retainedRootAuthority: RetainedDirectoryAuthority | undefined,
  hooks: ReviewBundleReceiptTraversalTestHooks
): Promise<ReviewBundleReceiptEntry[]> {
  const lexicalRoot = resolve(receiptsRoot);
  const rootAuthority = retainedRootAuthority
    ?? await ExistingDirectoryAuthority.acquire(await realpath(lexicalRoot));
  await assertApprovedReviewBundleReceiptsRoot(lexicalRoot, rootAuthority);
  const canonicalRoot = rootAuthority.path;
  const paths = await listJsonFiles(canonicalRoot, rootAuthority, hooks);
  const budget = new BoundedResourceBudget(REVIEW_BUNDLE_RECEIPT_TRAVERSAL_LIMITS, "Review bundle receipt traversal");
  const entries: ReviewBundleReceiptEntry[] = [];
  for (const path of paths) {
    await assertApprovedReviewBundleReceiptsRoot(lexicalRoot, rootAuthority);
    const source = await readBudgetedStableFile(path, {
      label: "Review bundle receipt",
      budget,
      withinRoot: canonicalRoot,
      captureIdentity: true,
      ...(hooks.afterReceiptPreflight ? { afterPreflight: async () => await hooks.afterReceiptPreflight!(path) } : {})
    });
    await assertApprovedReviewBundleReceiptsRoot(lexicalRoot, rootAuthority);
    const receipt = readReviewBundleReceipt(JSON.parse(source.bytes.toString("utf8")));
    if (receipt) {
      const entry = {
        path: source.canonicalPath,
        relativePath: reviewReceiptRelativePath(canonicalRoot, source.canonicalPath),
        receipt
      } satisfies ReviewBundleReceiptEntry;
      bindLoadedReviewBundleReceipt(entry, canonicalRoot, source);
      entries.push(entry);
    }
  }
  await assertApprovedReviewBundleReceiptsRoot(lexicalRoot, rootAuthority);
  // Code-unit order, not localeCompare: this ordering IS the review bundle's identity. It fixes
  // the order of `copiedArtifacts`, whose sha256 list is hashed into the receipt id below, so a
  // locale-sensitive comparator here gave the same bundle two different ids on two machines.
  return entries.sort((a, b) => compareCodeUnits(a.path ?? "", b.path ?? ""));
}

async function listJsonFiles(
  root: string,
  rootAuthority: RetainedDirectoryAuthority,
  hooks: ReviewBundleReceiptTraversalTestHooks
): Promise<string[]> {
  const files: string[] = [];
  let directoryCount = 0;
  let treeEntryCount = 0;

  const admitDirectory = (): void => {
    if (directoryCount >= MAX_REVIEW_BUNDLE_RECEIPT_TREE_DIRECTORIES) {
      throw new Error(`Review bundle receipt traversal exceeds the ${MAX_REVIEW_BUNDLE_RECEIPT_TREE_DIRECTORIES}-directory limit.`);
    }
    directoryCount += 1;
  };
  const admitTreeEntry = (): void => {
    if (treeEntryCount >= MAX_REVIEW_BUNDLE_RECEIPT_TREE_ENTRIES) {
      throw new Error(`Review bundle receipt traversal exceeds the ${MAX_REVIEW_BUNDLE_RECEIPT_TREE_ENTRIES}-entry limit.`);
    }
    treeEntryCount += 1;
  };
  const admitReceiptFile = (path: string): void => {
    if (files.length >= REVIEW_BUNDLE_RECEIPT_TRAVERSAL_LIMITS.maxFiles) {
      throw new Error(`Review bundle receipt traversal exceeds the ${REVIEW_BUNDLE_RECEIPT_TRAVERSAL_LIMITS.maxFiles}-file limit.`);
    }
    files.push(path);
  };

  if (canTraverseReviewReceiptDirectoriesByDescriptor()) {
    const rootDirectory = await openReviewReceiptDirectory(root);
    try {
      await rootAuthority.assertCurrent();
      const visit = async (directory: FileHandle, relativePath: string, directoryDepth: number): Promise<void> => {
        await rootAuthority.assertCurrent();
        admitDirectory();
        const cursor = await opendir(reviewReceiptDirectoryCapabilityPath(directory), { bufferSize: 1 });
        try {
          await rootAuthority.assertCurrent();
          for await (const entry of cursor) {
            await rootAuthority.assertCurrent();
            admitTreeEntry();
            const path = join(reviewReceiptDirectoryCapabilityPath(directory), entry.name);
            const childRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
              if (directoryDepth >= REVIEW_BUNDLE_RECEIPT_TRAVERSAL_LIMITS.maxPathDepth - 1) {
                throw new Error(`Review bundle receipt traversal exceeds the ${REVIEW_BUNDLE_RECEIPT_TRAVERSAL_LIMITS.maxPathDepth}-component path-depth limit.`);
              }
              const admission = await admitReviewReceiptDirectory(path);
              await hooks.afterDirectoryClassifiedBeforeOpen?.(path);
              const child = await openReviewReceiptDirectory(path);
              try {
                await assertCurrentReviewReceiptDirectoryEntry(directory, entry.name, child, admission);
                await visit(child, childRelativePath, directoryDepth + 1);
                await hooks.afterDirectoryTraversedBeforeRecheck?.(path);
                await assertCurrentReviewReceiptDirectoryEntry(directory, entry.name, child, admission);
              } finally {
                await child.close().catch(() => undefined);
              }
            } else if (entry.isFile() && entry.name.endsWith(".json")) {
              admitReceiptFile(join(root, ...childRelativePath.split("/")));
            }
          }
        } finally {
          await cursor.close().catch(() => undefined);
        }
      };
      await visit(rootDirectory, "", 0);
    } finally {
      await rootDirectory.close().catch(() => undefined);
    }
    return files;
  }

  // Node exposes no no-follow directory open on these hosts. Preserve the established nested
  // receipt contract by binding a path identity before `opendir`, then rechecking the exact
  // directory and canonical in-root route before iterating and after recursion. This fails closed
  // on observed swaps, but cannot prevent an unobservable same-user ABA around the OS-level open:
  // that residual can expose replacement entry names to the bounded scan. Stable receipt reads
  // still resolve and revalidate the approved lexical root, so replacement bytes are not admitted.
  const visit = async (
    directoryPath: string,
    relativePath: string,
    directoryDepth: number,
    afterDirentClassification: boolean
  ): Promise<ReviewReceiptDirectoryIdentity> => {
    await rootAuthority.assertCurrent();
    admitDirectory();
    const admission = await admitReviewReceiptDirectory(directoryPath);
    if (afterDirentClassification) await hooks.afterDirectoryClassifiedBeforeOpen?.(directoryPath);
    const directory = await openReviewReceiptDirectoryByPath(directoryPath, root, admission);
    try {
      await rootAuthority.assertCurrent();
      for await (const entry of directory) {
        await rootAuthority.assertCurrent();
        admitTreeEntry();
        const path = join(directoryPath, entry.name);
        const childRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (directoryDepth >= REVIEW_BUNDLE_RECEIPT_TRAVERSAL_LIMITS.maxPathDepth - 1) {
            throw new Error(`Review bundle receipt traversal exceeds the ${REVIEW_BUNDLE_RECEIPT_TRAVERSAL_LIMITS.maxPathDepth}-component path-depth limit.`);
          }
          const childAdmission = await visit(path, childRelativePath, directoryDepth + 1, true);
          await hooks.afterDirectoryTraversedBeforeRecheck?.(path);
          await assertCurrentReviewReceiptDirectoryPath(path, root, childAdmission);
        } else if (entry.isFile() && entry.name.endsWith(".json")) {
          admitReceiptFile(path);
        }
      }
      await assertCurrentReviewReceiptDirectoryPath(directoryPath, root, admission);
      return admission;
    } finally {
      await directory.close().catch(() => undefined);
    }
  };
  await visit(root, "", 0, false);
  return files;
}

function canTraverseReviewReceiptDirectoriesByDescriptor(): boolean {
  // `/proc/self/fd` is the retained-directory capability path used below.
  return process.platform === "linux" && Number.isInteger(constants.O_DIRECTORY) && Number.isInteger(constants.O_NOFOLLOW);
}

async function openReviewReceiptDirectory(path: string): Promise<FileHandle> {
  let directory: FileHandle | undefined;
  try {
    directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const facts = await directory.stat();
    if (!facts.isDirectory() || facts.isSymbolicLink()) throw new Error("not a directory");
    return directory;
  } catch (error) {
    await directory?.close().catch(() => undefined);
    throw new Error(`Review bundle receipt traversal directory changed while it was opened (${error instanceof Error ? error.message : String(error)}).`);
  }
}

type ReviewReceiptDirectoryIdentity = Readonly<{ dev: number; ino: number }>;

async function admitReviewReceiptDirectory(path: string): Promise<ReviewReceiptDirectoryIdentity> {
  try {
    const facts = await lstat(path);
    if (!facts.isDirectory() || facts.isSymbolicLink()) throw new Error("not a non-symlink directory");
    return { dev: facts.dev, ino: facts.ino };
  } catch (error) {
    throw new Error(`Review bundle receipt traversal directory changed while it was admitted (${error instanceof Error ? error.message : String(error)}).`);
  }
}

async function assertCurrentReviewReceiptDirectoryEntry(
  parent: FileHandle,
  name: string,
  child: FileHandle,
  admission: ReviewReceiptDirectoryIdentity
): Promise<void> {
  const path = join(reviewReceiptDirectoryCapabilityPath(parent), name);
  const [named, opened] = await Promise.all([lstat(path), child.stat()]);
  if (!named.isDirectory() || named.isSymbolicLink()
    || !sameReviewReceiptDirectoryIdentity(named, admission)
    || !sameReviewReceiptDirectoryIdentity(opened, admission)) {
    throw new Error("Review bundle receipt traversal directory changed while it was verified.");
  }
}

async function openReviewReceiptDirectoryByPath(
  path: string,
  root: string,
  admission: ReviewReceiptDirectoryIdentity
): Promise<Awaited<ReturnType<typeof opendir>>> {
  let directory: Awaited<ReturnType<typeof opendir>> | undefined;
  try {
    directory = await opendir(path, { bufferSize: 1 });
  } catch (error) {
    throw new Error(`Review bundle receipt traversal directory changed while it was opened (${error instanceof Error ? error.message : String(error)}).`);
  }
  try {
    await assertCurrentReviewReceiptDirectoryPath(path, root, admission);
    return directory;
  } catch (error) {
    await directory.close().catch(() => undefined);
    throw error;
  }
}

async function assertCurrentReviewReceiptDirectoryPath(
  path: string,
  root: string,
  admission: ReviewReceiptDirectoryIdentity
): Promise<void> {
  try {
    const [named, canonical] = await Promise.all([lstat(path), realpath(path)]);
    if (!named.isDirectory() || named.isSymbolicLink()
      || !sameReviewReceiptDirectoryIdentity(named, admission)
      || resolve(canonical) !== resolve(path)
      || !isReviewReceiptPathInsideRoot(root, canonical)) {
      throw new Error("directory identity or canonical route changed");
    }
  } catch (error) {
    throw new Error(`Review bundle receipt traversal directory changed while it was verified (${error instanceof Error ? error.message : String(error)}).`);
  }
}

function sameReviewReceiptDirectoryIdentity(
  facts: { dev: number | bigint; ino: number | bigint },
  expected: ReviewReceiptDirectoryIdentity
): boolean {
  return facts.dev === expected.dev && facts.ino === expected.ino;
}

function isReviewReceiptPathInsideRoot(root: string, candidate: string): boolean {
  const relation = relative(resolve(root), resolve(candidate));
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

function reviewReceiptDirectoryCapabilityPath(directory: FileHandle): string {
  return `/proc/self/fd/${directory.fd}`;
}
