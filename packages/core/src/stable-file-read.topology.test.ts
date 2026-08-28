import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const retarget = vi.hoisted(() => ({
  armed: false,
  leafPath: "",
  leafLstatCalls: 0,
  replacedPath: "",
  replacementPath: "",
  displacedPath: "",
  applied: false
}));

// This deterministic post-readback seam is the boundary the old leaf-only proof missed: it swaps
// the root/parent after the final leaf lstat but before return, when a second pathname operation
// could otherwise address an attacker route.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const facts = await actual.lstat(...args);
      if (retarget.armed && String(args[0]) === retarget.leafPath && ++retarget.leafLstatCalls === 4) {
        retarget.armed = false;
        retarget.applied = true;
        await actual.rename(retarget.replacedPath, retarget.displacedPath);
        await actual.rename(retarget.replacementPath, retarget.replacedPath);
      }
      return facts;
    }
  };
});

import { readBoundedStableFile, writeVerifiedBoundedFile } from "./stable-file-read";

const roots: string[] = [];

afterEach(async () => {
  resetRetarget();
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe("stable-file root topology", () => {
  it.skipIf(process.platform === "win32")("refuses a withinRoot replacement after readback", async () => {
    const layout = await readLayout(false);
    armRetarget(layout.file, layout.root, layout.replacement, layout.displaced);

    await expect(readBoundedStableFile(layout.file, { label: "root retarget read", maxBytes: 1024, withinRoot: layout.root }))
      .rejects.toThrow(/topology changed|changed after Motion captured/i);
    expect(retarget.applied).toBe(true);
  });

  it.skipIf(process.platform === "win32")("refuses an intermediate-parent replacement after readback", async () => {
    const layout = await readLayout(true);
    armRetarget(layout.file, layout.parent, layout.replacement, layout.displaced);

    await expect(readBoundedStableFile(layout.file, { label: "parent retarget read", maxBytes: 1024, withinRoot: layout.root }))
      .rejects.toThrow(/topology changed|changed after Motion captured/i);
    expect(retarget.applied).toBe(true);
  });

  it.skipIf(process.platform === "win32")("refuses a withinRoot replacement during write readback", async () => {
    const layout = await writeLayout(false);
    armRetarget(layout.destination, layout.root, layout.replacement, layout.displaced);

    await expect(writeVerifiedBoundedFile(layout.destination, Buffer.from("verified bytes"), {
      label: "root retarget write", maxBytes: 1024, withinRoot: layout.root
    })).rejects.toThrow(/topology changed|changed after Motion captured/i);
    expect(retarget.applied).toBe(true);
    await expect(readFile(layout.destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform === "win32")("refuses an intermediate-parent replacement during write readback", async () => {
    const layout = await writeLayout(true);
    armRetarget(layout.destination, layout.parent, layout.replacement, layout.displaced);

    await expect(writeVerifiedBoundedFile(layout.destination, Buffer.from("verified bytes"), {
      label: "parent retarget write", maxBytes: 1024, withinRoot: layout.root
    })).rejects.toThrow(/topology changed|changed after Motion captured/i);
    expect(retarget.applied).toBe(true);
    await expect(readFile(layout.destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform === "win32")("allows an owner-controlled root below a shared sticky parent", async () => {
    const base = await scratch();
    const shared = join(base, "shared-sticky");
    const root = join(shared, "owner-controlled");
    const input = join(root, "input.bin");
    const output = join(root, "output.bin");
    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(shared, 0o1777);
    await writeFile(input, "safe input", "utf8");

    await expect(readBoundedStableFile(input, { label: "sticky read", maxBytes: 1024, withinRoot: root }))
      .resolves.toMatchObject({ bytes: Buffer.from("safe input") });
    await expect(writeVerifiedBoundedFile(output, Buffer.from("safe output"), {
      label: "sticky write", maxBytes: 1024, withinRoot: root
    })).resolves.toMatchObject({ bytes: Buffer.from("safe output") });
  });

  it("reads through a stable operating-system alias using the canonical approved route", async () => {
    const base = await scratch();
    const canonicalRoot = join(base, "canonical-root");
    const aliasRoot = join(base, "alias-root");
    const canonicalInput = join(canonicalRoot, "input.bin");
    await mkdir(canonicalRoot, { mode: 0o700 });
    await writeFile(canonicalInput, "aliased input", "utf8");
    await symlink(canonicalRoot, aliasRoot, process.platform === "win32" ? "junction" : "dir");

    await expect(readBoundedStableFile(join(aliasRoot, "input.bin"), {
      label: "aliased stable read",
      maxBytes: 1024,
      withinRoot: aliasRoot,
      allowRootAlias: true
    })).resolves.toMatchObject({
      bytes: Buffer.from("aliased input"),
      canonicalPath: canonicalInput
    });
  });
});

function armRetarget(leafPath: string, replacedPath: string, replacementPath: string, displacedPath: string): void {
  retarget.armed = true;
  retarget.leafPath = leafPath;
  retarget.leafLstatCalls = 0;
  retarget.replacedPath = replacedPath;
  retarget.replacementPath = replacementPath;
  retarget.displacedPath = displacedPath;
  retarget.applied = false;
}

function resetRetarget(): void {
  retarget.armed = false;
  retarget.leafPath = "";
  retarget.leafLstatCalls = 0;
  retarget.replacedPath = "";
  retarget.replacementPath = "";
  retarget.displacedPath = "";
  retarget.applied = false;
}

async function readLayout(nested: boolean): Promise<RetargetLayout & { file: string }> {
  const layout = await baseLayout(nested);
  const file = join(layout.parent, "input.bin");
  await writeFile(file, "approved bytes", "utf8");
  await writeFile(join(layout.replacement, "input.bin"), "outside bytes", "utf8");
  return { ...layout, file };
}

async function writeLayout(nested: boolean): Promise<RetargetLayout & { destination: string }> {
  const layout = await baseLayout(nested);
  return { ...layout, destination: join(layout.parent, "output.bin") };
}

async function baseLayout(nested: boolean): Promise<RetargetLayout> {
  const base = await scratch();
  const root = join(base, "approved-root");
  const parent = nested ? join(root, "parent") : root;
  const replacement = nested ? join(root, "replacement-parent") : join(base, "replacement-root");
  const displaced = nested ? join(root, "displaced-parent") : join(base, "displaced-root");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await mkdir(replacement, { recursive: true, mode: 0o700 });
  return { root, parent, replacement, displaced };
}

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-stable-file-topology-"));
  roots.push(root);
  return root;
}

type RetargetLayout = {
  root: string;
  parent: string;
  replacement: string;
  displaced: string;
};
