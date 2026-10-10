import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyClosedFiles, inspectClosedFiles, sourceInventory } from "./packed-source-inventory.mjs";
import { comparePackedFiles, discoverPackages, expectedPackedFiles } from "./packed-files-gate.mjs";

const owned: string[] = [];
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "motion-packed-source-")));
  owned.push(root);
  mkdirSync(join(root, "docs", "public", "media"), { recursive: true });
  writeFileSync(join(root, "docs", "public", "index.json"), "{}\n");
  writeFileSync(join(root, "docs", "public", "media", "poster.png"), "image");
  return { root, roots: ["docs/public"], files: ["docs/public/index.json", "docs/public/media/poster.png"] };
}
afterEach(() => { for (const path of owned.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("closed packed source inventory", () => {
  it("copies exactly approved docs in a portable filesystem fixture", () => {
    const { root, roots, files } = fixture();
    const output = join(root, "dist");
    expect(inspectClosedFiles(root, roots, files)).toEqual([]);
    copyClosedFiles(root, output, roots, files);
    expect(readFileSync(join(output, "docs/public/index.json"), "utf8")).toBe("{}\n");
    expect(readFileSync(join(output, "docs/public/media/poster.png"), "utf8")).toBe("image");
  });

  it("refuses added files and symlinks before copying", () => {
    const { root, roots, files } = fixture();
    writeFileSync(join(root, "docs/public/private.txt"), "secret");
    expect(inspectClosedFiles(root, roots, files)).toContain("unlisted source file: docs/public/private.txt");
    expect(() => copyClosedFiles(root, join(root, "dist"), roots, files)).toThrow("unlisted source file");
    if (process.platform === "win32") return;
    rmSync(join(root, "docs/public/private.txt"));
    symlinkSync(join(root, "docs/public/index.json"), join(root, "docs/public/alias.json"));
    expect(inspectClosedFiles(root, roots, files).join("\n")).toContain("source path is not a regular file or directory: docs/public/alias.json");
  });

  it("refuses missing files, unapproved inventory paths, and linked roots", () => {
    const { root, roots, files } = fixture();
    expect(inspectClosedFiles(root, roots, [...files, "docs/private/secret.txt"]).join("\n")).toContain("out-of-class path");
    rmSync(join(root, "docs/public/media/poster.png"));
    expect(inspectClosedFiles(root, roots, files)).toContain("missing approved source file: docs/public/media/poster.png");
    if (process.platform === "win32") return;
    rmSync(join(root, "docs/public"), { recursive: true });
    mkdirSync(join(root, "replacement"));
    symlinkSync(join(root, "replacement"), join(root, "docs/public"), "dir");
    expect(inspectClosedFiles(root, roots, files).join("\n")).toContain("source path is not a regular directory: docs/public");
  });

  it("accepts the 77 reviewed source leaves and rejects manifest expansion", () => {
    const packages = discoverPackages();
    const inventories = packages.map((pkg) => sourceInventory(pkg));
    expect(inventories.flatMap((entry) => entry.problems)).toEqual([]);
    expect(inventories.reduce((count, entry) => count + entry.entries.length, 0)).toBe(26);
    expect(inventories.find((entry) => entry.docs.length > 0)?.docs.length).toBe(51);
    for (const pkg of packages) expect(expectedPackedFiles(pkg).problems).toEqual([]);

    const core = packages.find((pkg) => pkg.name === "@shellx-motion/core")!;
    const changed = { ...core, manifest: { ...core.manifest, files: [...core.manifest.files, "private"] } };
    expect(expectedPackedFiles(changed).problems.join("\n")).toContain("undeclared manifest files entry: private");
    expect(comparePackedFiles(core.name, expectedPackedFiles(core).expected, ["package.json", "assets/unlisted.txt"]).join("\n"))
      .toContain("unexpected file in tarball: assets/unlisted.txt");
  });

  it("refuses package metadata that npm includes outside manifest.files", () => {
    const { root } = fixture();
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/index.ts"), "export const fixture = true;\n");
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
      compilerOptions: { rootDir: "src" }, include: ["src/**/*.ts"]
    }));
    const pkg = { name: "@shellx-motion/actions", dir: root, manifest: { files: ["dist"] } };
    const normal = expectedPackedFiles(pkg);
    expect(normal.problems).toEqual([]);
    expect(normal.optional.has("LICENSE")).toBe(true);
    expect(comparePackedFiles(pkg.name, normal.expected, [...normal.expected, "LICENSE"], normal.optional)).toEqual([]);
    for (const name of ["README.md", "readme.txt", "LICENSE", "CHANGELOG.md"]) {
      writeFileSync(join(root, name), "unreviewed metadata fixture");
      expect(expectedPackedFiles(pkg).problems).toContain(`${pkg.name}: unlisted package metadata: ${name}`);
      if (name !== "LICENSE") {
        expect(comparePackedFiles(pkg.name, normal.expected, [...normal.expected, name], normal.optional))
          .toContain(`${pkg.name}: unexpected file in tarball: ${name}`);
      }
      rmSync(join(root, name));
    }
    const sdk = discoverPackages().find((item) => item.name === "@shellx-motion/sdk")!;
    expect(expectedPackedFiles(sdk).expected.has("README.md")).toBe(true);
    expect(expectedPackedFiles(sdk).problems).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("refuses a linked package base and a linked parent of the base", () => {
    const { root, roots, files } = fixture();
    const alias = join(root, "alias");
    symlinkSync(root, alias, "dir");
    expect(inspectClosedFiles(alias, roots, files)).toEqual(["source base is not a physical directory"]);
    const parent = join(root, "parent");
    symlinkSync(join(root, "docs"), parent, "dir");
    expect(inspectClosedFiles(join(parent, "public"), ["index.json"], ["index.json"]))
      .toEqual(["source base is not a physical directory"]);
  });
});
