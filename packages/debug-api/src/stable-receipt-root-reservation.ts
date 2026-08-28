import { writeFile, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { closeRoot, retainRootDirectory, rootIsCurrent, type DirectoryCapability } from "./receipt-store-stable-reader.js";

export interface StableReceiptRootReservation {
  readonly logicalPath: string;
  writeJson(name: string, value: unknown): Promise<string>;
  close(): Promise<void>;
}

/**
 * Retain the exact no-follow receipt root across provider execution and receipt persistence.
 * Writes use the held directory descriptor, never a re-resolved caller pathname. If the root
 * loses its configured name during a write, the just-created file is removed through that same
 * descriptor before the operation refuses.
 */
export async function reserveStableReceiptRoot(path: string): Promise<StableReceiptRootReservation | null> {
  const root = await retainRootDirectory(path);
  if (!root) return null;
  return new StableReceiptRootReservationImpl(root);
}

class StableReceiptRootReservationImpl implements StableReceiptRootReservation {
  private readonly created = new Set<string>();
  private closed = false;

  constructor(private readonly root: DirectoryCapability) {}
  get logicalPath(): string { return this.root.logicalPath; }

  async writeJson(name: string, value: unknown): Promise<string> {
    if (this.closed || !safeReceiptName(name) || !await rootIsCurrent(this.root, [])) {
      throw new Error("Stable receipt root is no longer available for governed persistence.");
    }
    const capabilityPath = join(this.root.capabilityPath, name);
    await writeFile(capabilityPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    this.created.add(name);
    if (!await rootIsCurrent(this.root, [])) {
      await unlink(capabilityPath).catch(() => {});
      this.created.delete(name);
      throw new Error("Stable receipt root changed during governed persistence; the new receipt was removed.");
    }
    return join(this.root.logicalPath, name);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (!await rootIsCurrent(this.root, [])) {
      await Promise.all([...this.created].map(async (name) => await unlink(join(this.root.capabilityPath, name)).catch(() => {})));
    }
    await closeRoot(this.root);
  }
}

function safeReceiptName(name: string): boolean {
  return name.length > 0 && name === basename(name) && name.endsWith(".receipt.json");
}
