/**
 * Ownership fence for the product-pack moving-proof scratch directory.
 *
 * The proof gate is allowed to remove only its own named child roles after a
 * root-bound marker validates that the caller previously initialized this exact
 * directory. `--force` is therefore never an authorization to recursively
 * delete an arbitrary resolved path.
 */
import assert from "node:assert/strict";
import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { parse, resolve } from "node:path";

export const TEMPLATE_PROOF_SCRATCH_MARKER = ".shellx-motion-template-proof-scratch.json";
export const TEMPLATE_PROOF_SCRATCH_SCHEMA = "shellx-motion/template-proof-scratch@1";
export const TEMPLATE_PROOF_SCRATCH_ROLES = [
  "packages",
  "renders",
  "frames",
  "quality",
  "receipts",
  "evidence.json",
  "resume-inspection.failure.json",
  "contact-sheet.svg"
] as const;

export interface PreparedTemplateProofScratch {
  root: string;
  markerPath: string;
  state: "initialized_empty" | "reused_empty" | "reset_owned_roles";
}

/** A non-mutating view of a previously failed proof that is eligible for recovery inspection. */
export interface RetainedTemplateProofScratch {
  root: string;
  markerPath: string;
  state: "inspection_ready";
}

interface ScratchMarker {
  schema: typeof TEMPLATE_PROOF_SCRATCH_SCHEMA;
  root: string;
}

/**
 * Initializes an empty caller-supplied scratch directory, or resets only the
 * proof's known roles when `force` is explicit and the root carries a valid,
 * root-bound ownership marker. Never follows a root symlink or removes a
 * markerless/non-owned non-empty directory.
 */
export async function prepareTemplateProofScratch(input: {
  root: string;
  repoRoot: string;
  force: boolean;
}): Promise<PreparedTemplateProofScratch> {
  const root = resolve(input.root);
  assertSafeScratchRoot(root, resolve(input.repoRoot));
  const markerPath = resolve(root, TEMPLATE_PROOF_SCRATCH_MARKER);

  let exists = true;
  try {
    const node = await lstat(root);
    assert(node.isDirectory() && !node.isSymbolicLink(), `Template proof scratch root must be a real directory, not a symlink: ${root}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    exists = false;
  }
  if (!exists) {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await writeMarker(markerPath, root);
    return { root, markerPath, state: "initialized_empty" };
  }

  const entries = await readdir(root);
  if (entries.length === 0) {
    await writeMarker(markerPath, root);
    return { root, markerPath, state: "initialized_empty" };
  }

  assert(await hasValidMarker(markerPath, root),
    `Refusing to replace non-empty template proof scratch without its root-bound ownership marker: ${root}`);
  const unknownEntries = entries.filter((entry) => entry !== TEMPLATE_PROOF_SCRATCH_MARKER && !TEMPLATE_PROOF_SCRATCH_ROLES.includes(entry as typeof TEMPLATE_PROOF_SCRATCH_ROLES[number]));
  assert.deepEqual(unknownEntries, [],
    `Refusing to replace template proof scratch with non-proof content: ${unknownEntries.join(", ")}`);

  const ownedEntries = entries.filter((entry) => entry !== TEMPLATE_PROOF_SCRATCH_MARKER);
  if (ownedEntries.length === 0) return { root, markerPath, state: "reused_empty" };
  assert(input.force,
    `Template proof scratch already contains proof artifacts; pass --force to remove only its owned roles: ${root}`);
  await Promise.all(ownedEntries.map(async (entry) => {
    const path = resolve(root, entry);
    // The name is checked against a closed list above and `resolve` keeps it
    // rooted. `rm` unlinks a symlink rather than following it.
    await rm(path, { recursive: true, force: true });
  }));
  return { root, markerPath, state: "reset_owned_roles" };
}

/**
 * Opens, but never resets, a retained moving-proof scratch directory for an
 * inspection-only recovery. This is deliberately stricter than normal setup:
 * the caller must present the existing root-bound marker and the complete
 * expected diagnostic roles. It writes nothing and cannot turn an arbitrary
 * directory into eligible proof evidence.
 */
export async function inspectRetainedTemplateProofScratch(input: {
  root: string;
  repoRoot: string;
}): Promise<RetainedTemplateProofScratch> {
  const root = resolve(input.root);
  assertSafeScratchRoot(root, resolve(input.repoRoot));
  const markerPath = resolve(root, TEMPLATE_PROOF_SCRATCH_MARKER);
  const node = await lstat(root);
  assert(node.isDirectory() && !node.isSymbolicLink(), `Template proof scratch root must be a real directory, not a symlink: ${root}`);
  assert(await hasValidMarker(markerPath, root),
    `Refusing inspection of template proof scratch without its root-bound ownership marker: ${root}`);
  const entries = await readdir(root);
  const unknownEntries = entries.filter((entry) => entry !== TEMPLATE_PROOF_SCRATCH_MARKER && !TEMPLATE_PROOF_SCRATCH_ROLES.includes(entry as typeof TEMPLATE_PROOF_SCRATCH_ROLES[number]));
  assert.deepEqual(unknownEntries, [],
    `Refusing inspection of template proof scratch with non-proof content: ${unknownEntries.join(", ")}`);
  for (const role of ["packages", "renders", "frames", "quality", "evidence.json"] as const) {
    assert(entries.includes(role), `Retained template proof scratch is missing required ${role} diagnostics: ${root}`);
  }
  return { root, markerPath, state: "inspection_ready" };
}

function assertSafeScratchRoot(root: string, repoRoot: string): void {
  const home = resolve(homedir());
  assert(root !== parse(root).root, "Template proof scratch may not be a filesystem root.");
  assert(root !== repoRoot, "Template proof scratch may not be the repository root.");
  assert(root !== home, "Template proof scratch may not be the home directory.");
}

async function hasValidMarker(markerPath: string, root: string): Promise<boolean> {
  try {
    const node = await lstat(markerPath);
    if (!node.isFile() || node.isSymbolicLink()) return false;
    const parsed = JSON.parse(await readFile(markerPath, "utf8")) as Partial<ScratchMarker>;
    return parsed.schema === TEMPLATE_PROOF_SCRATCH_SCHEMA && parsed.root === root;
  } catch {
    return false;
  }
}

async function writeMarker(markerPath: string, root: string): Promise<void> {
  const marker: ScratchMarker = { schema: TEMPLATE_PROOF_SCRATCH_SCHEMA, root };
  await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}
