/** Shared canonical-root and refusal primitives for provenance helpers. */
import { lstat, realpath } from "node:fs/promises";
import { resolve } from "node:path";

export class AgentScriptProvenanceRefusal extends Error {
  readonly code = "script_provenance_unresolved";

  constructor(message: string, readonly detail?: Record<string, unknown>) {
    super(message);
    this.name = "AgentScriptProvenanceRefusal";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Reject a root or ancestor reached through a symlink before a durable identity decision. */
export async function canonicalPackageRoot(root: string): Promise<string> {
  const resolvedRoot = resolve(root);
  const before = await lstat(resolvedRoot);
  if (before.isSymbolicLink() || !before.isDirectory()) throw new AgentScriptProvenanceRefusal("Active script package root must be a real directory.", { root: resolvedRoot });
  const canonicalRoot = await realpath(resolvedRoot);
  if (canonicalRoot !== resolvedRoot) throw new AgentScriptProvenanceRefusal("Active script package root must not traverse a symbolic link.", { root: resolvedRoot });
  const after = await lstat(canonicalRoot);
  if (!sameDirectory(before, after)) throw new AgentScriptProvenanceRefusal("Active script package root changed while it was being verified.", { root: resolvedRoot });
  return canonicalRoot;
}

function sameDirectory(before: Awaited<ReturnType<typeof lstat>>, after: Awaited<ReturnType<typeof lstat>>): boolean {
  return !after.isSymbolicLink() && after.isDirectory() && after.dev === before.dev && after.ino === before.ino;
}
