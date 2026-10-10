import { constants as fsConstants } from "node:fs";
import { mkdtemp, open, rename, rm, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertHeldMediaPrivateNames,
  assertHeldMp4FastStart,
  createExclusiveHeldLeaf,
  heldDirectoryFacts,
  removeHeldLeaf,
  type HeldFileFacts,
} from "./linear-srgb-sdr-final-held-media-files.js";

const roots: string[] = [];
const handles: FileHandle[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map(async (handle) => await handle.close().catch(() => undefined)));
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe.skipIf(process.platform !== "linux")("strict SDR held-media leaf authority", () => {
  it("closes the retained descriptor when an identity-replaced leaf refuses cleanup", async () => {
    const fixture = await heldRoot();
    const source = await createExclusiveHeldLeaf(fixture.handle, fixture.identity, join(fixture.root, "verified.mp4"), "test source");
    handles.push(source.handle);
    await writeAtStart(source.handle, Buffer.from("original"));
    const replacement = join(fixture.root, "replacement.mp4");
    await writeFile(replacement, "replacement", { mode: 0o600, flag: "wx" });
    await rename(replacement, source.path);

    await expect(removeHeldLeaf(fixture.handle, fixture.identity, source, "replaced source")).rejects.toThrow("no longer resolves to the held exclusive inode");
    await expect(source.handle.stat()).rejects.toMatchObject({ code: "EBADF" });
  });

  it("accepts only a held MP4 whose moov atom precedes mdat", async () => {
    const fixture = await heldRoot();
    const source = await createExclusiveHeldLeaf(fixture.handle, fixture.identity, join(fixture.root, "verified.mp4"), "test source");
    handles.push(source.handle);
    await writeAtStart(source.handle, Buffer.concat([box("ftyp"), box("moov"), box("mdat")]));
    await expect(assertHeldMp4FastStart(fixture.handle, fixture.identity, source)).resolves.toBeUndefined();

    await writeAtStart(source.handle, Buffer.concat([box("ftyp"), box("mdat"), box("moov")]));
    await expect(assertHeldMp4FastStart(fixture.handle, fixture.identity, source)).rejects.toThrow("moov-before-mdat");
  });

  it("requires the exact fixed private leaf names", () => {
    expect(() => assertHeldMediaPrivateNames("/scratch/slot", "/scratch/slot/verified.mp4", "/scratch/slot/decoded.rgba")).not.toThrow();
    expect(() => assertHeldMediaPrivateNames("/scratch/slot", "/scratch/slot/alternate.mp4", "/scratch/slot/decoded.rgba")).toThrow("exact private source and decode leaves");
  });
});

async function heldRoot(): Promise<{ readonly root: string; readonly handle: FileHandle; readonly identity: HeldFileFacts }> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-held-media-"));
  roots.push(root);
  const handle = await open(root, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  handles.push(handle);
  return { root, handle, identity: await heldDirectoryFacts(handle, root, "test root") };
}

function box(type: string): Buffer {
  const value = Buffer.alloc(8);
  value.writeUInt32BE(8, 0);
  value.write(type, 4, "ascii");
  return value;
}

async function writeAtStart(handle: FileHandle, bytes: Buffer): Promise<void> {
  await handle.truncate(0);
  const { bytesWritten } = await handle.write(bytes, 0, bytes.byteLength, 0);
  if (bytesWritten !== bytes.byteLength) throw new Error("test fixture write was short");
}
