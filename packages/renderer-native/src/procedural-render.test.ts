import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { inspectPngRegionBuffer, loadMotionPackage, validateDocument, loadSchema } from "@shellx-motion/core";
import { renderNativePreviewFrame } from "./index";

const fixtureRoot = fileURLToPath(new URL("../../../fixtures/packages/procedural-relationships/", import.meta.url));

describe("native procedural relationship rendering", () => {
  it("validates and renders stable relationship targets at exact frame times", async () => {
    const pkg = await loadMotionPackage(fixtureRoot);
    expect(await validateDocument(await loadSchema("motion"), pkg.motion)).toEqual({ ok: true });
    const start = await renderNativePreviewFrame({ packageRoot: fixtureRoot, atMs: 0, now: fixedNow });
    const end = await renderNativePreviewFrame({ packageRoot: fixtureRoot, atMs: 1000, now: fixedNow });
    expect(start.ok).toBe(true);
    expect(end.ok).toBe(true);
    if (!start.ok || !end.ok) return;
    expect(start.frame.sha256).not.toBe(end.frame.sha256);
    expect(chromaPixels(start.frame.png, { x: 18, y: 68, width: 45, height: 45 })).toBeGreaterThan(500);
    expect(chromaPixels(start.frame.png, { x: 118, y: 68, width: 45, height: 45 })).toBe(0);
    expect(chromaPixels(end.frame.png, { x: 110, y: 55, width: 60, height: 60 })).toBeGreaterThan(500);
    const manifest = JSON.parse(await readFile(`${fixtureRoot}/manifest.json`, "utf8"));
    expect(manifest.compatibility.lanes).toEqual(["browser", "native"]);
  });
});

function fixedNow(): string { return "2026-07-14T00:00:00.000Z"; }
function chromaPixels(png: Buffer, region: { x: number; y: number; width: number; height: number }): number {
  const result = inspectPngRegionBuffer(png, region);
  expect(result.ok).toBe(true);
  return result.ok ? result.chroma.pixels : 0;
}
