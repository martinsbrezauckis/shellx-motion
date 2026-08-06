/**
 * version.test.ts — the engine constant must equal what this package is published as.
 *
 * `MOTION_ENGINE_VERSION` is generated from the repository root `package.json` by
 * `scripts/version-parity.ts`, and every runtime surface (CLI banner, `GET /health`,
 * `GET /debug/contracts`, MCP `serverInfo`, the local SDK capability contract, the Engine Room
 * update check) reads it. This suite is the unit-level half of that guarantee: it fails inside
 * vitest — no gate script, no build — the moment the constant is hand-edited away from the
 * manifest, which is exactly how the shipped engine came to report `0.0.0` while every manifest
 * said `0.1.0`.
 *
 * The repo-wide assertion across all six surfaces lives in `pnpm run version:check`.
 */
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { MOTION_ENGINE_VERSION } from "./version";

/** Read a manifest `version` field relative to this test file. */
async function manifestVersion(relativePath: string): Promise<string> {
  const manifest = JSON.parse(await readFile(new URL(relativePath, import.meta.url), "utf8")) as { version: string };
  return manifest.version;
}

describe("MOTION_ENGINE_VERSION", () => {
  it("matches this package's published version", async () => {
    expect(MOTION_ENGINE_VERSION).toBe(await manifestVersion("../package.json"));
  });

  it("matches the workspace root version, which is the source of truth", async () => {
    expect(MOTION_ENGINE_VERSION).toBe(await manifestVersion("../../../package.json"));
  });

  it("is a plain semver string, never a placeholder", () => {
    expect(MOTION_ENGINE_VERSION).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
    expect(MOTION_ENGINE_VERSION).not.toBe("0.0.0");
  });
});
