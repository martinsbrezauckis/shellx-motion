import { join, parse, resolve, sep } from "node:path";
import {
  assertOutputLeafIdentity,
  captureOutputLeaf,
  OutputDirectoryReservation,
  OutputPathTopology,
  type RetainedDirectoryAuthority
} from "./output-path-topology";

/** Existing-only private-runtime authority. Missing routes are verified but never created or adopted. */
export async function inspectExistingPrivateRuntimeDirectory(root: string): Promise<RetainedDirectoryAuthority | undefined> {
  const firstMissing = await captureFirstMissingPath(root);
  if (firstMissing) {
    const topology = await OutputPathTopology.inspect(firstMissing);
    await topology.assertCurrent();
    await assertOutputLeafIdentity(firstMissing, { kind: "missing" }, "Motion private runtime inspection route");
    await topology.assertCurrent();
    return undefined;
  }
  return await OutputDirectoryReservation.acquire(root, { allowExistingContents: true, requirePrivate: true, requireExisting: true });
}

/** Walk lexical components with lstat semantics so a missing suffix cannot hide an inserted redirect. */
async function captureFirstMissingPath(path: string): Promise<string | undefined> {
  const target = resolve(path);
  const anchor = parse(target).root;
  if ((await captureOutputLeaf(anchor)).kind !== "directory") throw new Error("Motion private runtime inspection root is not a directory.");
  let current = anchor;
  for (const part of target.slice(anchor.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    const leaf = await captureOutputLeaf(current);
    if (leaf.kind === "missing") return current;
    if (leaf.kind !== "directory") throw new Error("Motion private runtime inspection route is not a directory.");
  }
  return undefined;
}
