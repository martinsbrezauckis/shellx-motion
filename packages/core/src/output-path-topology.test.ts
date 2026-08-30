import { lstatSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ExistingDirectoryAuthority,
  OutputDirectoryReservation,
  OutputPathTopology
} from "./output-path-topology";
import {
  createTrustedWorkspaceAnchor,
  withTrustedWorkspaceAnchor,
  type TrustedWorkspaceAnchor
} from "./output-path-trusted-workspace";

const roots: string[] = [];

afterEach(async () => await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))));

describe("output directory reservations", () => {
  it("rejects replacement of an existing read root after its authority is retained", async () => {
    const root = await scratch();
    const selected = join(root, "selected");
    const previous = join(root, "selected-previous");
    await mkdir(selected, { mode: 0o700 });
    const authority = await ExistingDirectoryAuthority.acquire(selected);

    await rename(selected, previous);
    await mkdir(selected, { mode: 0o700 });

    await expect(authority.assertCurrent()).rejects.toThrow(/changed after Motion captured its identity|topology changed after admission/i);
  });

  it.skipIf(process.platform === "win32")("refuses a literal sticky shared root when the retained store requires exclusive child authority", async () => {
    const root = await scratch();
    const store = join(root, "shared-store");
    await mkdir(store, { mode: 0o700 });
    await chmod(store, 0o1777);

    await expect(OutputDirectoryReservation.acquire(store, {
      allowExistingContents: true,
      requireExclusiveChildAuthority: true
    })).rejects.toThrow(/exclusive child authority/i);
  });

  it.skipIf(process.platform === "win32")("allows owner-controlled 0700 and 0755 retained stores with exclusive child authority", async () => {
    const root = await scratch();
    for (const mode of [0o700, 0o755]) {
      const store = join(root, `store-${mode.toString(8)}`);
      await mkdir(store, { mode });
      await chmod(store, mode);

      const reservation = await OutputDirectoryReservation.acquire(store, {
        allowExistingContents: true,
        requireExclusiveChildAuthority: true
      });
      await expect(reservation.assertCurrent()).resolves.toBeUndefined();
    }
  });

  it.skipIf(process.platform === "win32")("rechecks retained exclusive child authority before later batch phases", async () => {
    const root = await scratch();
    const store = join(root, "retained-store");
    await mkdir(store, { mode: 0o700 });
    await chmod(store, 0o755);
    const reservation = await OutputDirectoryReservation.acquire(store, {
      allowExistingContents: true,
      requireExclusiveChildAuthority: true
    });
    await chmod(store, 0o1777);

    await expect(reservation.assertCurrent()).rejects.toThrow(/exclusive child authority/i);
  });

  it("refuses a pre-seeded create leaf instead of adopting a create-race winner", async () => {
    const root = await scratch();
    const store = join(root, "segments");
    const sentinel = join(store, "foreign-checkpoint");
    await mkdir(store, { mode: 0o700 });
    await writeFile(sentinel, "preserve foreign state", "utf8");

    await expect(OutputDirectoryReservation.acquire(store, {
      allowExistingContents: true,
      requirePrivate: true,
      requireAbsent: true
    })).rejects.toThrow(/pre-seeded state/i);
    await expect(readFile(sentinel, "utf8")).resolves.toBe("preserve foreign state");
  });

  it("never creates missing configuration while acquiring an existing-root authority", async () => {
    const root = await scratch();
    const missingParent = join(root, "missing-parent");
    const missingRoot = join(missingParent, "configured-root");

    await expect(OutputDirectoryReservation.acquire(missingRoot, {
      allowExistingContents: true,
      requireExisting: true,
      requireExclusiveChildAuthority: true
    })).rejects.toThrow(/existing directory/i);
    await expect(lstat(missingParent)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform === "win32")("refuses a shared-write retained store before resume can trust it", async () => {
    const root = await scratch();
    const store = join(root, "segments");
    await mkdir(store, { mode: 0o700 });
    await chmod(store, 0o777);

    await expect(OutputDirectoryReservation.acquire(store, {
      allowExistingContents: true,
      requirePrivate: true
    })).rejects.toThrow(/private POSIX directory|group- or world-writable/i);
  });
});

describe.skipIf(process.platform === "win32")("scoped trusted workspace anchors", () => {
  it("admits only a strict descendant while retaining the anchor identity", async () => {
    const anchorRoot = await workspace();
    const anchor = await createTrustedWorkspaceAnchor(anchorRoot);

    await withTrustedWorkspaceAnchor(anchor, async () => {
      const topology = await OutputPathTopology.acquire(join(anchorRoot, "packages", "edited"));
      await expect(topology.assertCurrent()).resolves.toBeUndefined();
    });
  });

  it.skipIf(!managedPosixOwnershipRefusal())("keeps the full-ancestor ownership refusal when no host anchor is scoped", async () => {
    const anchorRoot = await workspace();
    await expect(OutputPathTopology.acquire(join(anchorRoot, "packages", "edited"))).rejects.toThrow(/unrelated POSIX principal/i);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("refuses an unowned POSIX anchor", async () => {
    await expect(createTrustedWorkspaceAnchor("/")).rejects.toThrow(/not owned by the active POSIX principal/i);
  });

  it("rejects serialized or caller-supplied lookalikes", async () => {
    const anchor = await createTrustedWorkspaceAnchor(await workspace());
    expect(() => JSON.stringify(anchor)).toThrow(/cannot be serialized/i);
    await expect(withTrustedWorkspaceAnchor({} as TrustedWorkspaceAnchor, async () => undefined)).rejects.toThrow(/not created by the Motion host factory/i);
  });

  it("refuses lexical escapes and symlinked descendants", async () => {
    const anchorRoot = await workspace();
    const outside = await workspace();
    const anchor = await createTrustedWorkspaceAnchor(anchorRoot);
    const linked = join(anchorRoot, "linked");
    await symlink(outside, linked, "dir");

    await withTrustedWorkspaceAnchor(anchor, async () => {
      await expect(OutputPathTopology.acquire(join(anchorRoot, "..", basename(outside), "escape"))).rejects.toThrow(/outside the host-approved trusted workspace anchor/i);
      await expect(OutputPathTopology.acquire(join(linked, "escape"))).rejects.toThrow(/canonical non-symlink directory/i);
    });
  });

  it("refuses anchor and descendant replacement after admission", async () => {
    const anchorRoot = await workspace();
    const anchor = await createTrustedWorkspaceAnchor(anchorRoot);
    const anchorPrevious = `${anchorRoot}-previous`;
    roots.push(anchorPrevious);

    await withTrustedWorkspaceAnchor(anchor, async () => {
      const anchorTopology = await OutputPathTopology.acquire(join(anchorRoot, "anchor-target", "output"));
      await rename(anchorRoot, anchorPrevious);
      await mkdir(anchorRoot, { mode: 0o700 });
      await chmod(anchorRoot, 0o700);
      await expect(anchorTopology.assertCurrent()).rejects.toThrow(/trusted workspace anchor changed/i);
    });

    const descendantAnchorRoot = await workspace();
    const descendantAnchor = await createTrustedWorkspaceAnchor(descendantAnchorRoot);
    const parent = join(descendantAnchorRoot, "parent");
    const parentPrevious = join(descendantAnchorRoot, "parent-previous");
    await mkdir(parent, { mode: 0o700 });
    await withTrustedWorkspaceAnchor(descendantAnchor, async () => {
      const descendantTopology = await OutputPathTopology.acquire(join(parent, "output"));
      await rename(parent, parentPrevious);
      await mkdir(parent, { mode: 0o700 });
      await expect(descendantTopology.assertCurrent()).rejects.toThrow(/topology changed after admission/i);
    });
  });

  it.skipIf(process.platform === "win32")("keeps shared-writable descendants out of an anchored route", async () => {
    const anchorRoot = await workspace();
    const shared = join(anchorRoot, "shared");
    await mkdir(shared, { mode: 0o700 });
    await chmod(shared, 0o777);
    const anchor = await createTrustedWorkspaceAnchor(anchorRoot);

    await withTrustedWorkspaceAnchor(anchor, async () => {
      await expect(OutputPathTopology.acquire(join(shared, "output"))).rejects.toThrow(/group- or world-writable/i);
    });
  });
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-output-topology-"));
  roots.push(root);
  return root;
}

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(process.cwd(), ".shellx-motion-output-topology-anchor-"));
  await chmod(root, 0o700);
  roots.push(root);
  return root;
}

function managedPosixOwnershipRefusal(): boolean {
  if (process.platform === "win32" || typeof process.getuid !== "function") return false;
  try {
    const root = lstatSync("/");
    return root.uid !== process.getuid() && root.uid !== 0;
  } catch {
    return false;
  }
}
