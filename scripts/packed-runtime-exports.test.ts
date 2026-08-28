import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverPackages } from "./packed-files-gate.mjs";
import { collectPackedRuntimeExportContract } from "./packed-runtime-exports.mjs";

describe("packed runtime export contract", () => {
  it("publishes roots and public subpaths plus only shipping-consumed internal subpaths", () => {
    const packages = discoverPackages();
    const contract = collectPackedRuntimeExportContract(packages);

    for (const pkg of packages) {
      if (!pkg.manifest.exports) continue;
      const expected = contract.runtime
        .filter((entry) => entry.packageName === pkg.name)
        .map((entry) => entry.subpath)
        .sort();
      const actual = Object.keys(pkg.manifest.publishConfig?.exports ?? {}).sort();

      expect(actual, pkg.name).toEqual(expected);
    }
  });

  it("rejects a shipping consumer of a nonshipping source export", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-packed-runtime-exports-"));
    try {
      const provider = join(root, "provider");
      const consumer = join(root, "consumer");
      await mkdir(join(provider, "src", "unadopted"), { recursive: true });
      await mkdir(join(consumer, "src"), { recursive: true });
      await writeFile(join(provider, "src", "unadopted", "private.ts"), "export const privateValue = 1;\n");
      await writeFile(join(consumer, "src", "index.ts"), "import \"@fixture/provider/internal/private\";\n");

      expect(() => collectPackedRuntimeExportContract([
        {
          name: "@fixture/provider",
          dir: provider,
          manifest: { exports: { "./internal/private": "./src/unadopted/private.ts" } }
        },
        {
          name: "@fixture/consumer",
          dir: consumer,
          manifest: { exports: { ".": "./src/index.ts" } }
        }
      ])).toThrow("packed runtime exports: shipping workspace import @fixture/provider/internal/private resolves to nonshipping source export ./src/unadopted/private.ts.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("admits an explicit packed host-internal entry and rejects malformed declarations", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-packed-host-exports-"));
    try {
      const provider = join(root, "provider");
      await mkdir(join(provider, "src", "internal"), { recursive: true });
      await writeFile(join(provider, "src", "internal", "host.ts"), "export const hostValue = 1;\n");
      const base = { name: "@fixture/provider", dir: provider, manifest: { exports: { "./internal/host": "./src/internal/host.ts" } } };
      const contract = collectPackedRuntimeExportContract([{ ...base, manifest: { ...base.manifest, shellxMotion: { hostInternalExports: ["./internal/host"] } } }]);
      expect(contract.runtime.map((entry) => entry.specifier)).toEqual(["@fixture/provider/internal/host"]);
      expect(() => collectPackedRuntimeExportContract([{ ...base, manifest: { ...base.manifest, shellxMotion: { hostInternalExports: ["."] } } }])).toThrow(/must identify a declared \.\/internal\/ subpath/i);
      expect(() => collectPackedRuntimeExportContract([{ ...base, manifest: { ...base.manifest, shellxMotion: { hostInternalExports: ["./internal/missing"] } } }])).toThrow(/must identify a declared \.\/internal\/ subpath/i);
      expect(() => collectPackedRuntimeExportContract([{ ...base, manifest: { exports: { "./internal/host": { import: "./src/internal/host.ts" } }, shellxMotion: { hostInternalExports: ["./internal/host"] } } }])).toThrow(/must resolve to a string source target/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
