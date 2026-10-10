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

  it("classifies any source below unadopted in source and emitted forms", () => {
    for (const suffix of [".ts", ".js", ".d.ts", ".js.map"]) {
      expect(isNonShippingSource(`src/unadopted/diagnostics/probe${suffix}`)).toBe(true);
    }
    expect(isNonShippingSource("src/unadoptedness/diagnostics/probe.ts")).toBe(false);
  });

  it("reports static, dynamic, and import-type references from shipping source to unadopted source", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-source-modules-"));
    ownedRoots.push(root);
    const packageDir = join(root, "packages", "fixture");
    await mkdir(join(packageDir, "src", "unadopted"), { recursive: true });
    await writeFile(
      join(packageDir, "package.json"),
      `${JSON.stringify({ name: "@fixture/source-boundary", exports: { ".": "./dist/index.js" } }, null, 2)}\n`,
      "utf8"
    );
    const privateSpecifier = "./unadopted/probe.js";
    await writeFile(join(packageDir, "src", "index.ts"), `import "${privateSpecifier}";\nexport type Probe = import("${privateSpecifier}").Probe;\nexport async function loadProbe() { return await import("${privateSpecifier}"); }\n`, "utf8");
    await writeFile(join(packageDir, "src", "unadopted", "probe.ts"), "export type Probe = true;\n", "utf8");

    expect(inspectShippingImports(root)).toEqual({
      inspected: 1,
      offenders: Array(3).fill('packages/fixture/src/index.ts imports "./unadopted/probe.js" -> packages/fixture/src/unadopted/probe.ts')
    });
  });

  it("has no shipping-to-unadopted import in the shipped workspace closure", () => {
    const { offenders } = inspectShippingImports();
    expect(offenders).toEqual([]);
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
