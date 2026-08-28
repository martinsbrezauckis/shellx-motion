import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverPackages, expectedPackedFiles } from "./packed-files-gate.mjs";
import { inspectShippingImports } from "./shipping-imports-gate.mjs";
import { isNonShippingSource } from "./source-modules.mjs";

const ownedRoots: string[] = [];

afterEach(async () => {
  await Promise.all(ownedRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("shared nonshipping source convention", () => {
  it("classifies only the exact unadopted path segment in source and emitted paths", () => {
    expect(isNonShippingSource("src/unadopted/gpu/example.ts")).toBe(true);
    expect(isNonShippingSource("dist/unadopted/segmented-final/example.js")).toBe(true);
    expect(isNonShippingSource("dist/unadopted/segmented-final/example.d.ts")).toBe(true);
    expect(isNonShippingSource("dist/unadopted/segmented-final/example.js.map")).toBe(true);
    expect(isNonShippingSource("src/unadoptedness/example.ts")).toBe(false);
  });

  it("reports a shipping module importing an unadopted implementation", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-source-modules-"));
    ownedRoots.push(root);
    const packageDir = join(root, "packages", "fixture");
    await mkdir(join(packageDir, "src", "unadopted"), { recursive: true });
    await writeFile(
      join(packageDir, "package.json"),
      `${JSON.stringify({ name: "@fixture/source-boundary", exports: { ".": "./dist/index.js" } }, null, 2)}\n`,
      "utf8"
    );
    await writeFile(join(packageDir, "src", "index.ts"), 'import "./unadopted/hidden";\n', "utf8");
    await writeFile(join(packageDir, "src", "unadopted", "hidden.ts"), "export const hidden = true;\n", "utf8");

    expect(inspectShippingImports(root)).toEqual({
      inspected: 1,
      offenders: [
        'packages/fixture/src/index.ts imports "./unadopted/hidden" -> packages/fixture/src/unadopted/hidden.ts'
      ]
    });
  });

  it("excludes every unadopted module from the three affected packed manifests", () => {
    const names = new Set([
      "@shellx-motion/core",
      "@shellx-motion/renderer-browser",
      "@shellx-motion/renderer-ffmpeg"
    ]);
    const packages = discoverPackages().filter((pkg) => names.has(pkg.name));
    expect(packages.map((pkg) => pkg.name).sort()).toEqual([...names].sort());

    for (const pkg of packages) {
      const { expected, problems } = expectedPackedFiles(pkg);
      expect(problems, pkg.name).toEqual([]);
      expect([...expected].filter((file) => file.startsWith("dist/unadopted/")), pkg.name).toEqual([]);
    }
  });
});
