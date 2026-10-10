/** Descriptor-only PNG staging for fixed same-parent frame-zero review packs. */
import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { encodeRgbaPng } from "@shellx-motion/core";
import {
  assertHeldDirectoryIdentity,
  assertPinnedHeldLeaf,
  hashHeldLeaf,
  sameHeldFacts,
  type HeldFileFacts,
} from "./linear-srgb-sdr-final-held-media-files.js";
import {
  STRICT_SDR_FRAME0_PACK_SLOT_MAXIMUM_BYTES,
  strictSdrCandidateFrame0PackCrop,
  strictSdrCandidateFrame0PackImages,
  strictSdrCandidateFrame0PackLeafNames,
  type StrictSdrCandidateFrame0PackAllocation,
  type StrictSdrCandidateFrame0PackImage,
  type StrictSdrCandidateFrame0PackSlot,
} from "./linear-srgb-sdr-final-three-slot-frame0-pack-layout.js";

export type StrictSdrCandidateFrame0PackImageFact = Readonly<{
  name: string;
  kind: "source" | "decoded";
  x: number;
  y: number;
  width: number;
  height: number;
  sha256: string;
  byteLength: number;
  identity: HeldFileFacts;
}>;
export type StrictSdrCandidateFrame0PackStaged = Readonly<{
  sourceFrame: Readonly<{ sha256: string; byteLength: number }>;
  decodedFrame: Readonly<{ sha256: string; byteLength: number }>;
  images: readonly StrictSdrCandidateFrame0PackImageFact[];
}>;

export async function assertStrictSdrCandidateFrame0PackAllocation(
  slot: StrictSdrCandidateFrame0PackSlot,
  allocation: StrictSdrCandidateFrame0PackAllocation,
): Promise<readonly StrictSdrCandidateFrame0PackImage[]> {
  if (!allocation || !allocation.root || !allocation.root.handle || !allocation.root.identity || typeof allocation.root.path !== "string" || !allocation.leaves) {
    throw new Error("Strict-SDR frame-zero pack allocation is malformed.");
  }
  assertAllocationShape(slot, allocation);
  const root = allocation.root, rootPath = resolve(root.path), images = strictSdrCandidateFrame0PackImages(slot, allocation);
  if (!images.length || images.reduce((total, image) => total + image.maximumBytes, 0) > STRICT_SDR_FRAME0_PACK_SLOT_MAXIMUM_BYTES) {
    throw new Error("Strict-SDR frame-zero pack allocation exceeds its literal slot reservation.");
  }
  await assertHeldDirectoryIdentity(root.handle, root.path, root.identity, "Strict-SDR frame-zero pack root");
  const rootFacts = await lstat(rootPath);
  if (!rootFacts.isDirectory() || rootFacts.isSymbolicLink() || (rootFacts.mode & 0o7777) !== 0o700) {
    throw new Error("Strict-SDR frame-zero pack root is not the exact private directory.");
  }
  const seen = new Set<number>();
  for (const image of images) {
    if (seen.has(image.leaf.handle.fd)) throw new Error("Strict-SDR frame-zero pack reuses a leaf descriptor.");
    seen.add(image.leaf.handle.fd);
    const expected = join(rootPath, `${image.name}.png`);
    if (resolve(image.leaf.path) !== expected || basename(image.leaf.path) !== `${image.name}.png`) {
      throw new Error("Strict-SDR frame-zero pack leaf does not match its fixed allocation name.");
    }
    const facts = await assertPinnedHeldLeaf(root.handle, root.identity, image.leaf, `Strict-SDR frame-zero pack ${image.name}`);
    const pathFacts = await lstat(image.leaf.path);
    if (!pathFacts.isFile() || pathFacts.isSymbolicLink() || pathFacts.nlink !== 1 || (pathFacts.mode & 0o7777) !== 0o600 || facts.size !== 0) {
      throw new Error("Strict-SDR frame-zero pack leaf is not an empty private create-once file.");
    }
  }
  await assertExactPackEntries(root, strictSdrCandidateFrame0PackLeafNames(slot), "Strict-SDR frame-zero pack root");
  return images;
}

export async function stageStrictSdrCandidateFrame0PackImages(input: Readonly<{
  slot: StrictSdrCandidateFrame0PackSlot;
  allocation: StrictSdrCandidateFrame0PackAllocation;
  source: Buffer;
  decoded: Buffer;
  signal: AbortSignal | undefined;
}>): Promise<StrictSdrCandidateFrame0PackStaged> {
  const images = await assertStrictSdrCandidateFrame0PackAllocation(input.slot, input.allocation);
  const facts: StrictSdrCandidateFrame0PackImageFact[] = [];
  try {
    for (const image of images) {
      assertNotAborted(input.signal);
      const frame = image.kind === "source" ? input.source : input.decoded;
      const pixels = whole(image) ? frame : strictSdrCandidateFrame0PackCrop(frame, image);
      try {
        const png = encodeRgbaPng(image.width, image.height, pixels);
        try {
          if (png.byteLength < 1 || png.byteLength > image.maximumBytes) throw new Error("Strict-SDR frame-zero pack PNG exceeds its fixed image budget.");
          assertNotAborted(input.signal);
          await writeExactly(image, png);
          assertNotAborted(input.signal);
          const hashed = await hashHeldLeaf(input.allocation.root.handle, input.allocation.root.identity, image.leaf, image.maximumBytes, `Strict-SDR frame-zero pack ${image.name}`);
          facts.push(Object.freeze({ name: image.name, kind: image.kind, x: image.x, y: image.y, width: image.width, height: image.height, sha256: hashed.sha256, byteLength: hashed.byteLength, identity: hashed.identity }));
        } finally {
          png.fill(0);
        }
      } finally {
        if (pixels !== frame) pixels.fill(0);
      }
    }
    return Object.freeze({
      sourceFrame: Object.freeze({ sha256: hash(input.source), byteLength: input.source.byteLength }),
      decodedFrame: Object.freeze({ sha256: hash(input.decoded), byteLength: input.decoded.byteLength }),
      images: Object.freeze(facts),
    });
  } catch (error) {
    throw error;
  }
}

export async function revalidateStrictSdrCandidateFrame0PackImages(
  slot: StrictSdrCandidateFrame0PackSlot,
  allocation: StrictSdrCandidateFrame0PackAllocation,
  staged: StrictSdrCandidateFrame0PackStaged,
): Promise<void> {
  const images = strictSdrCandidateFrame0PackImagesForFacts(slot, allocation, staged.images);
  await assertSealedAllocation(slot, allocation, images.map(([image]) => image));
  for (const [image, expected] of images) {
    const actual = await hashHeldLeaf(allocation.root.handle, allocation.root.identity, image.leaf, image.maximumBytes, `Strict-SDR sealed frame-zero pack ${image.name}`);
    if (actual.sha256 !== expected.sha256 || actual.byteLength !== expected.byteLength || !sameHeldFacts(actual.identity, expected.identity)) {
      throw new Error("Strict-SDR sealed frame-zero pack leaf changed after descriptor staging.");
    }
  }
}

export async function closeStrictSdrCandidateFrame0PackAllocation(slot: StrictSdrCandidateFrame0PackSlot, allocation: StrictSdrCandidateFrame0PackAllocation): Promise<void> {
  const errors: unknown[] = [], leaves = strictSdrCandidateFrame0PackImages(slot, allocation).map((image) => image.leaf);
  for (const leaf of leaves) await leaf.handle.close().catch((error) => errors.push(error));
  await allocation.root.handle.close().catch((error) => errors.push(error));
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Strict-SDR frame-zero pack descriptor closure was uncertain.");
}

function strictSdrCandidateFrame0PackImagesForFacts(
  slot: StrictSdrCandidateFrame0PackSlot,
  allocation: StrictSdrCandidateFrame0PackAllocation,
  facts: readonly StrictSdrCandidateFrame0PackImageFact[] | undefined,
): readonly [StrictSdrCandidateFrame0PackImage, StrictSdrCandidateFrame0PackImageFact][] {
  const images = strictSdrCandidateFrame0PackImages(slot, allocation);
  if (facts === undefined) return images.map((image) => [image, undefined!] as [StrictSdrCandidateFrame0PackImage, StrictSdrCandidateFrame0PackImageFact]);
  if (facts.length !== images.length) throw new Error("Strict-SDR sealed frame-zero pack image count is invalid.");
  return images.map((image, index) => {
    const fact = facts[index]!;
    if (fact.name !== image.name || fact.kind !== image.kind || fact.x !== image.x || fact.y !== image.y || fact.width !== image.width || fact.height !== image.height) {
      throw new Error("Strict-SDR sealed frame-zero pack image geometry changed.");
    }
    return [image, fact] as [StrictSdrCandidateFrame0PackImage, StrictSdrCandidateFrame0PackImageFact];
  });
}
function whole(image: StrictSdrCandidateFrame0PackImage): boolean { return image.x === 0 && image.y === 0 && image.width === 1_280 && image.height === 720; }
async function writeExactly(image: StrictSdrCandidateFrame0PackImage, bytes: Buffer): Promise<void> {
  for (let offset = 0; offset < bytes.byteLength;) {
    const { bytesWritten } = await image.leaf.handle.write(bytes, offset, bytes.byteLength - offset, offset);
    if (bytesWritten < 1) throw new Error("Strict-SDR frame-zero pack leaf write made no progress.");
    offset += bytesWritten;
  }
  await image.leaf.handle.sync();
}
function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("Strict-SDR frame-zero pack staging was aborted.");
}
async function assertSealedAllocation(
  slot: StrictSdrCandidateFrame0PackSlot,
  allocation: StrictSdrCandidateFrame0PackAllocation,
  images: readonly StrictSdrCandidateFrame0PackImage[],
): Promise<void> {
  const root = allocation.root, rootPath = resolve(root.path);
  await assertHeldDirectoryIdentity(root.handle, root.path, root.identity, "Strict-SDR sealed frame-zero pack root");
  const rootFacts = await lstat(rootPath);
  if (!rootFacts.isDirectory() || rootFacts.isSymbolicLink() || (rootFacts.mode & 0o7777) !== 0o700 || images.length !== strictSdrCandidateFrame0PackImages(slot, allocation).length) {
    throw new Error("Strict-SDR sealed frame-zero pack root is not its exact private allocation.");
  }
  for (const image of images) {
    const expected = join(rootPath, `${image.name}.png`);
    if (resolve(image.leaf.path) !== expected || basename(image.leaf.path) !== `${image.name}.png`) {
      throw new Error("Strict-SDR sealed frame-zero pack leaf does not match its fixed allocation name.");
    }
    const facts = await assertPinnedHeldLeaf(root.handle, root.identity, image.leaf, `Strict-SDR sealed frame-zero pack ${image.name}`);
    const pathFacts = await lstat(image.leaf.path);
    if (!pathFacts.isFile() || pathFacts.isSymbolicLink() || pathFacts.nlink !== 1 || (pathFacts.mode & 0o7777) !== 0o600 || facts.size < 1) {
      throw new Error("Strict-SDR sealed frame-zero pack leaf is not its held private output.");
    }
  }
  await assertExactPackEntries(root, strictSdrCandidateFrame0PackLeafNames(slot), "Strict-SDR sealed frame-zero pack root");
}

function assertAllocationShape(slot: StrictSdrCandidateFrame0PackSlot, allocation: StrictSdrCandidateFrame0PackAllocation): void {
  const leaves = allocation.leaves as unknown;
  if (!leaves || typeof leaves !== "object" || Array.isArray(leaves) || Object.getPrototypeOf(leaves) !== Object.prototype || Object.getOwnPropertySymbols(leaves).length !== 0) {
    throw new Error("Strict-SDR frame-zero pack allocation leaves are malformed.");
  }
  const names = Object.getOwnPropertyNames(leaves).sort(), expected = [...strictSdrCandidateFrame0PackLeafNames(slot)].sort();
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
    throw new Error("Strict-SDR frame-zero pack allocation leaves do not retain the exact literal tuple.");
  }
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(leaves, name);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable || Object.hasOwn(descriptor, "get") || Object.hasOwn(descriptor, "set")) {
      throw new Error("Strict-SDR frame-zero pack allocation leaves are not enumerable data.");
    }
  }
}

async function assertExactPackEntries(
  root: StrictSdrCandidateFrame0PackAllocation["root"],
  expected: readonly string[],
  label: string,
): Promise<void> {
  await assertHeldDirectoryIdentity(root.handle, root.path, root.identity, `${label} before entry check`);
  const entries = await readdir(`/proc/self/fd/${root.handle.fd}`, { withFileTypes: true });
  const actual = entries.map((entry) => entry.name).sort(), names = expected.map((name) => `${name}.png`).sort();
  if (actual.length !== names.length || actual.some((name, index) => name !== names[index])) {
    throw new Error(`${label} entry set is not its exact literal PNG allocation.`);
  }
  await assertHeldDirectoryIdentity(root.handle, root.path, root.identity, `${label} after entry check`);
}
function hash(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
