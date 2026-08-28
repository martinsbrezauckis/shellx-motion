import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runTemplateToCutConnector } from "./template-to-cut";

const roots: string[] = [];
afterEach(async () => await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("forced connector output ownership", () => {
  it("Template-to-Cut refuses force without following hostile sibling links from a sticky shared root", async ({ skip }) => {
    const links = await hostileSiblingLinks(skip);
    if (!links) return;
    const { outDir, outsidePlan, outsideDirs } = links;
    await expect(runTemplateToCutConnector({
      packageRoot: resolve("../../templates/shellx-product-pack/feature-announcement"), values: {}, outDir, force: true
    } as unknown as Parameters<typeof runTemplateToCutConnector>[0])).rejects.toThrow(/does not support force/i);
    for (const [name, path] of Object.entries(outsideDirs)) {
      expect(await readFile(join(path, "sentinel.txt"), "utf8")).toBe("outside sibling data");
      expect(await readdir(path)).toEqual(["sentinel.txt"]);
      expect((await lstat(join(outDir, name))).isSymbolicLink()).toBe(true);
    }
    expect(await readFile(outsidePlan, "utf8")).toBe("outside plan data");
    expect((await lstat(join(outDir, "cut-import-plan.json"))).isSymbolicLink()).toBe(true);
  });
});

async function hostileSiblingLinks(skip: (reason: string) => void) {
  const root = await mkdtemp(join(process.cwd(), ".tmp-shellx-motion-template-force-"));
  roots.push(root);
  const outDir = join(root, "out"), outsideDir = join(root, "outside");
  await mkdir(outDir);
  await mkdir(outsideDir);
  await chmod(outDir, 0o1777);
  const outsideDirs = Object.fromEntries(["receipts", "preview", "render", "artifacts"].map((name) => [name, join(outsideDir, name)]));
  const outsidePlan = join(outsideDir, "cut-import-plan.json");
  for (const path of Object.values(outsideDirs)) {
    await mkdir(path);
    await writeFile(join(path, "sentinel.txt"), "outside sibling data", "utf8");
  }
  await writeFile(outsidePlan, "outside plan data", "utf8");
  try {
    for (const [name, path] of Object.entries(outsideDirs)) await symlink(path, join(outDir, name), "dir");
    await symlink(outsidePlan, join(outDir, "cut-import-plan.json"), "file");
  } catch (error) {
    if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
      skip("The standard Windows test account cannot create symbolic links.");
      return null;
    }
    throw error;
  }
  return { outDir, outsidePlan, outsideDirs };
}
