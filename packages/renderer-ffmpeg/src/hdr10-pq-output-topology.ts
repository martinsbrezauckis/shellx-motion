import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";

/** Refuses package/output overlap and every existing symlink before a C2 stage exists. */
export async function assertHdr10PqOutputDisjoint(packageRoot: string, outputDirectory: string): Promise<void> {
  const source = await canonicalExistingDirectory(packageRoot, "The HDR10 package root"), output = await canonicalOutputDestination(outputDirectory);
  if (insideOrEqual(source, output) || insideOrEqual(output, source)) throw new Error("The HDR10 direct-final output directory must be disjoint from the authenticated package root.");
}

async function canonicalExistingDirectory(path: string, label: string): Promise<string> {
  const resolved = resolve(path), facts = await lstat(resolved).catch((error: NodeJS.ErrnoException) => { throw new Error(`${label} could not be inspected (${error.code ?? "unknown error"}).`); });
  if (!facts.isDirectory() || facts.isSymbolicLink()) throw new Error(`${label} must be an existing non-symlink directory.`);
  const canonical = await realpath(resolved).catch(() => { throw new Error(`${label} could not be canonicalized.`); });
  if (canonical !== resolved) throw new Error(`${label} must not resolve through a symlink.`);
  return canonical;
}

async function canonicalOutputDestination(path: string): Promise<string> {
  const target = resolve(path), root = parse(target).root, parts = target.slice(root.length).split(sep).filter(Boolean); let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    const candidate = join(current, parts[index]!); const facts = await lstat(candidate).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
    if (!facts) return resolve(current, ...parts.slice(index));
    if (facts.isSymbolicLink()) throw new Error("The HDR10 direct-final output directory must not cross a symlink.");
    if (!facts.isDirectory()) throw new Error("The HDR10 direct-final output directory has a non-directory ancestor.");
    const canonical = await realpath(candidate).catch(() => { throw new Error("The HDR10 direct-final output directory could not be canonicalized."); });
    if (canonical !== candidate) throw new Error("The HDR10 direct-final output directory must not resolve through a symlink."); current = candidate;
  }
  return current;
}

function insideOrEqual(root: string, candidate: string): boolean { const relation = relative(root, candidate); return relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation)); }
