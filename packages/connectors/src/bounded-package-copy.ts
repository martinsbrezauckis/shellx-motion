import { lstat, mkdir, opendir } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import {
  BoundedResourceBudget,
  DEFAULT_HOST_INTERCHANGE_LIMITS,
  canonicalJsonSha256,
  hashBuffer,
  readBudgetedStableFile,
  writeVerifiedBoundedFile,
  type BoundedResourceLimits
} from "@shellx-motion/core";

export interface AdmittedPackageTreeEntry {
  path: string;
  kind: "directory" | "file";
  sha256?: string;
  byteLength?: number;
}

export interface AdmittedPackageTreeEvidence {
  schema: "shellx-motion/admitted-package-tree@1";
  sha256: string;
  /** Files and subdirectories; the package root is represented but does not consume this budget. */
  entryCount: number;
  fileCount: number;
  aggregateBytes: number;
  entries: readonly AdmittedPackageTreeEntry[];
}

export interface AdmittedPackageTree {
  readonly files: ReadonlyMap<string, Readonly<{ bytes: Buffer; sha256: string }>>;
  readonly evidence: AdmittedPackageTreeEvidence;
  readonly limits: Readonly<BoundedResourceLimits>;
}

/**
 * Read an entire host-provided package before any connector publication.  Every source entry is
 * admitted as a stable regular file; directories, symlinks, special files, depth, tree entries, and
 * aggregate bytes are checked as one tree rather than as a sequence of unrelated fs.cp calls.
 *
 * `limits.maxFiles` is the package-tree entry limit here: every file and subdirectory counts, while
 * the source root does not. The root remains in the evidence so publication can recreate it, but it
 * cannot make an otherwise exact-boundary source fail.
 */
export async function admitBoundedPackageTree(
  sourceRoot: string,
  options: { label: string; limits?: Readonly<BoundedResourceLimits> }
): Promise<AdmittedPackageTree> {
  const root = resolve(sourceRoot);
  const limits = options.limits ?? DEFAULT_HOST_INTERCHANGE_LIMITS;
  const budget = new BoundedResourceBudget(limits, options.label);
  const treeEntries = new BoundedPackageTreeEntryBudget(limits.maxFiles, options.label);
  const files = new Map<string, Readonly<{ bytes: Buffer; sha256: string }>>();
  const directories = new Set<string>([""]);

  await assertNoSymlinkedSourcePath(root, options.label);
  await visitDirectory(root, "");
  return createAdmittedPackageTree(files, directories, limits);

  async function visitDirectory(path: string, relativePath: string): Promise<void> {
    assertDepth(relativePath, limits, options.label);
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`${options.label} contains a symlinked or non-directory entry: ${displayPath(relativePath)}`);
    }
    directories.add(relativePath);
    const names: string[] = [];
    for await (const entry of await opendir(path)) {
      treeEntries.reserve(entry.name);
      names.push(entry.name);
    }
    for (const name of names.sort(comparePaths)) {
      const childRelativePath = relativePath === "" ? name : `${relativePath}/${name}`;
      const childPath = join(path, name);
      assertDepth(childRelativePath, limits, options.label);
      const childInfo = await lstat(childPath);
      if (childInfo.isDirectory()) {
        await visitDirectory(childPath, childRelativePath);
        continue;
      }
      if (!childInfo.isFile() || childInfo.isSymbolicLink()) {
        throw new Error(`${options.label} contains a symlink or special-file entry: ${displayPath(childRelativePath)}`);
      }
      const source = await readBudgetedStableFile(childPath, {
        label: `${options.label} file ${childRelativePath}`,
        budget,
        withinRoot: root
      });
      files.set(childRelativePath, { bytes: source.bytes, sha256: source.sha256 });
    }
  }
}

/** Replace one admitted regular file before publication, preserving the same bounded tree proof. */
export function replaceAdmittedPackageFile(tree: AdmittedPackageTree, relativePath: string, bytes: Buffer): AdmittedPackageTree {
  const existing = tree.files.get(relativePath);
  if (!existing) throw new Error(`Admitted package snapshot has no file at ${relativePath}.`);
  if (bytes.byteLength > tree.limits.maxFileBytes) {
    throw new Error(`Admitted package replacement exceeds the ${tree.limits.maxFileBytes}-byte per-file limit: ${relativePath}`);
  }
  const aggregateBytes = tree.evidence.aggregateBytes - existing.bytes.byteLength + bytes.byteLength;
  if (aggregateBytes > tree.limits.maxAggregateBytes) {
    throw new Error(`Admitted package replacement exceeds the ${tree.limits.maxAggregateBytes}-byte aggregate limit.`);
  }
  const files = new Map(tree.files);
  files.set(relativePath, { bytes, sha256: hashBuffer(bytes) });
  const directories = new Set(tree.evidence.entries.filter((entry) => entry.kind === "directory").map((entry) => entry.path));
  return createAdmittedPackageTree(files, directories, tree.limits);
}

/** Publish only the already-admitted bytes, through no-follow exclusive writes. */
export async function publishAdmittedPackageTree(tree: AdmittedPackageTree, packageDir: string): Promise<void> {
  const root = resolve(packageDir);
  const directories = tree.evidence.entries.filter((entry) => entry.kind === "directory").map((entry) => entry.path);
  for (const relativePath of directories) await ensureDestinationDirectory(root, relativePath);
  for (const entry of tree.evidence.entries) {
    if (entry.kind !== "file") continue;
    const file = tree.files.get(entry.path);
    if (!file || !entry.sha256 || entry.byteLength === undefined) throw new Error(`Admitted package evidence is incomplete for ${entry.path}.`);
    const destination = destinationPath(root, entry.path);
    await writeVerifiedBoundedFile(destination, file.bytes, {
      label: `Admitted package publication ${entry.path}`,
      maxBytes: tree.limits.maxFileBytes,
      withinRoot: root,
      expectedSha256: entry.sha256
    });
  }
}

function createAdmittedPackageTree(
  files: ReadonlyMap<string, Readonly<{ bytes: Buffer; sha256: string }>>,
  directories: ReadonlySet<string>,
  limits: Readonly<BoundedResourceLimits>
): AdmittedPackageTree {
  const entries: AdmittedPackageTreeEntry[] = [
    ...[...directories].sort(comparePaths).map((path) => ({ path, kind: "directory" as const })),
    ...[...files.entries()].sort(([left], [right]) => comparePaths(left, right)).map(([path, file]) => ({
      path,
      kind: "file" as const,
      sha256: file.sha256,
      byteLength: file.bytes.byteLength
    }))
  ];
  const entryCount = entries.length - 1;
  assertTreeEntryCount(entryCount, limits, "Admitted package tree");
  const fileCount = entries.filter((entry) => entry.kind === "file").length;
  const aggregateBytes = entries.reduce((sum, entry) => sum + (entry.byteLength ?? 0), 0);
  const evidence = {
    schema: "shellx-motion/admitted-package-tree@1" as const,
    sha256: canonicalJsonSha256(entries),
    entryCount,
    fileCount,
    aggregateBytes,
    entries: Object.freeze(entries)
  };
  return { files: new Map(files), evidence, limits };
}

/**
 * Bounds names before they join a directory's sort buffer. It deliberately counts the tree rather
 * than just regular files: empty-directory fanout must not evade the same host interchange limit.
 */
class BoundedPackageTreeEntryBudget {
  private entryCount = 0;

  constructor(private readonly maxEntries: number, private readonly label: string) {}

  reserve(path: string): void {
    if (this.entryCount + 1 > this.maxEntries) {
      throw new Error(`${this.label} exceeds the ${this.maxEntries}-entry package-tree limit: ${path}`);
    }
    this.entryCount += 1;
  }
}

function assertTreeEntryCount(entryCount: number, limits: Readonly<BoundedResourceLimits>, label: string): void {
  if (entryCount > limits.maxFiles) {
    throw new Error(`${label} exceeds the ${limits.maxFiles}-entry package-tree limit.`);
  }
}

function assertDepth(relativePath: string, limits: Readonly<BoundedResourceLimits>, label: string): void {
  const depth = relativePath === "" ? 0 : relativePath.split("/").length;
  if (depth > limits.maxPathDepth) {
    throw new Error(`${label} path exceeds the ${limits.maxPathDepth}-component depth limit: ${displayPath(relativePath)}`);
  }
}

async function assertNoSymlinkedSourcePath(path: string, label: string): Promise<void> {
  const resolved = resolve(path);
  const parsed = parse(resolved);
  let current = parsed.root;
  const parts = relative(parsed.root, resolved).split(sep).filter(Boolean);
  for (const part of ["", ...parts]) {
    if (part) current = join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`${label} has a symlinked or non-directory source parent: ${current}`);
    }
  }
}

async function ensureDestinationDirectory(root: string, relativePath: string): Promise<void> {
  const destination = destinationPath(root, relativePath);
  const parent = relativePath === "" ? root : join(root, ...relativePath.split("/"));
  const relativeParent = relative(root, parent);
  let current = root;
  await mkdir(current, { recursive: true, mode: 0o700 });
  await assertDirectory(current);
  for (const part of relativeParent === "" ? [] : relativeParent.split(sep)) {
    current = join(current, part);
    await mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    await assertDirectory(current);
  }
  await assertDirectory(destination);
}

async function assertDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Admitted package publication has a symlinked or non-directory destination: ${path}`);
}

function destinationPath(root: string, relativePath: string): string {
  const destination = resolve(root, relativePath);
  const relation = relative(root, destination);
  if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new Error(`Admitted package path escapes its destination: ${relativePath}`);
  }
  return destination;
}

function displayPath(relativePath: string): string {
  return relativePath === "" ? "." : relativePath;
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
