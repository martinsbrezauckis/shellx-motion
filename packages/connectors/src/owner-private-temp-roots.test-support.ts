import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const ROOT_PREFIX = "shellx-motion-connectors-";
const LABEL = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface OwnerPrivateTempRoots {
  create(label: string): Promise<string>;
  cleanup(): Promise<void>;
}

/**
 * Test-only owner for fixture roots. It is deliberately unable to register a caller-supplied path:
 * every tracked root originates from mkdtemp directly beneath the operating-system temp parent.
 */
export function createOwnerPrivateTempRoots(): OwnerPrivateTempRoots {
  const parent = resolve(tmpdir());
  const roots = new Set<string>();

  return {
    async create(label: string): Promise<string> {
      if (!LABEL.test(label)) throw new Error(`Unsafe connector test-temp label: ${label}`);
      let root: string | undefined;
      try {
        root = await mkdtemp(join(parent, `${ROOT_PREFIX}${label}-`));
        await assertOwnerPrivateTempRoot(root, parent, label);
        roots.add(root);
        return root;
      } catch (error) {
        if (root !== undefined) await removeAndAssertAbsent(root, parent, label);
        throw error;
      }
    },

    async cleanup(): Promise<void> {
      const tracked = [...roots];
      roots.clear();
      const failures: unknown[] = [];
      for (const root of tracked) {
        try {
          await removeAndAssertAbsent(root, parent);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) throw new AggregateError(failures, "Connector test-temp cleanup failed");
    }
  };
}

async function removeAndAssertAbsent(root: string, parent: string, label?: string): Promise<void> {
  assertDirectTempChild(root, parent, label);
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  try {
    await lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Connector test-temp root remains after cleanup: ${root}`);
}

async function assertOwnerPrivateTempRoot(root: string, parent: string, label: string): Promise<void> {
  assertDirectTempChild(root, parent, label);
  const facts = await lstat(root);
  if (!facts.isDirectory() || facts.isSymbolicLink()) throw new Error(`Connector test-temp root is not a directory: ${root}`);
  if (process.platform === "win32") return;
  const uid = process.getuid?.();
  if (uid === undefined || facts.uid !== uid) throw new Error(`Connector test-temp root has unexpected owner: ${root}`);
  if ((facts.mode & 0o777) !== 0o700) throw new Error(`Connector test-temp root is not mode 0700: ${root}`);
}

function assertDirectTempChild(root: string, parent: string, label?: string): void {
  if (dirname(resolve(root)) !== parent) throw new Error(`Connector test-temp root is outside the direct OS temp parent: ${root}`);
  const name = basename(root);
  const expected = label === undefined
    ? new RegExp(`^${ROOT_PREFIX}[a-z0-9]+(?:-[a-z0-9]+)*-[A-Za-z0-9]{6}$`)
    : new RegExp(`^${ROOT_PREFIX}${label}-[A-Za-z0-9]{6}$`);
  if (!expected.test(name)) throw new Error(`Connector test-temp root has an unexpected name: ${root}`);
}
