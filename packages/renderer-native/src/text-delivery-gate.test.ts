/**
 * Unit + session regression tests for the text-delivery invariant: the native lane must not be able to produce a
 * DELIVERY render of text its 5x7 block-glyph table cannot draw faithfully.
 *
 * Covers the three layers of the fix that live in this package:
 *   - `nativeTextDeliveryIssues` classification (case fold, fallback boxes, ignored font family),
 *   - `createNativeRenderSession({ renderTarget: "delivery" })` refusing with the typed error while
 *     the default preview session for the same package still renders,
 *   - the glyph-repertoire invariant that keeps the core-side `text.charset.non-ascii` rule and this
 *     package's actual font from drifting apart.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nativeBlockGlyphRepertoire } from "@shellx-motion/core";
import {
  caseFoldedCharacters,
  createNativeRenderSession,
  fallbackGlyphCharacters,
  nativeGlyphRepertoire,
  nativeTextDeliveryIssues,
  renderNativePreviewFrame
} from "./index";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function writeTextPackage(text: string, style: Record<string, unknown> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-native-delivery-gate-"));
  tempDirs.push(root);
  await writeFile(join(root, "manifest.json"), `${JSON.stringify({
    schema: "shellx-motion/package-manifest@1",
    id: "pkg_native_delivery_gate",
    name: "Native Delivery Gate",
    motion: "motion.json",
    assets: [],
    sourceApp: "shellx-motion",
    compatibility: { lanes: ["native", "ffmpeg"], hosts: ["motion"] }
  }, null, 2)}\n`);
  await writeFile(join(root, "motion.json"), `${JSON.stringify({
    schema: "shellx-motion/motion@1",
    id: "motion_native_delivery_gate",
    name: "Native Delivery Gate",
    durationMs: 200,
    fps: 10,
    width: 96,
    height: 48,
    background: "#000000",
    layers: [{
      id: "title",
      type: "text",
      text,
      startMs: 0,
      durationMs: 200,
      transform: { x: 4, y: 4 },
      style: { color: "#ffffff", fontSize: 16, ...style }
    }],
    assets: [],
    provenance: { sourceApp: "shellx-motion", createdBy: "test" }
  }, null, 2)}\n`);
  return root;
}

describe("native text delivery gate", () => {
  it("classifies the three ways native text diverges from the authored document", () => {
    const motion = {
      schema: "shellx-motion/motion@1",
      id: "m",
      name: "m",
      durationMs: 100,
      fps: 10,
      width: 10,
      height: 10,
      layers: [
        { id: "folded", type: "text", text: "Sveiks", startMs: 0, durationMs: 100 },
        { id: "boxed", type: "text", text: "PRICE ^ 10", startMs: 0, durationMs: 100 },
        { id: "fonted", type: "text", text: "BRAND", startMs: 0, durationMs: 100, style: { fontFamily: "Inter" } },
        { id: "clean", type: "text", text: "SHIP IT 2026!", startMs: 0, durationMs: 100 },
        { id: "hidden", type: "text", text: "sveiks", startMs: 0, durationMs: 100, visible: false }
      ]
    } as never;

    expect(nativeTextDeliveryIssues(motion).map((issue) => [issue.layerId, issue.feature])).toEqual([
      ["folded", "text.case.preserved"],
      ["boxed", "text.block-glyphs.fallback"],
      ["fonted", "text.font.family"]
    ]);
  });

  it("refuses a delivery session and still renders the same package as a preview session", async () => {
    const packageRoot = await writeTextPackage("Sveiks");

    const delivery = await createNativeRenderSession({ packageRoot, renderTarget: "delivery" });
    const deliveryFrame = await delivery.renderFrameAtMs(0);
    delivery.close();

    const preview = await createNativeRenderSession({ packageRoot });
    const previewFrame = await preview.renderFrameAtMs(0);
    preview.close();

    expect(deliveryFrame.ok).toBe(false);
    if (deliveryFrame.ok) return;
    expect(deliveryFrame.error).toMatchObject({
      code: "native_text_not_deliverable",
      message: expect.stringContaining("--frame-lane browser"),
      unsupported: [{ layerId: "title", feature: "text.case.preserved" }]
    });
    expect(deliveryFrame.receipt.status).toBe("failed");

    // Same package, preview target: the lane's declared job still works, degraded and explicit.
    expect(previewFrame.ok).toBe(true);
    if (!previewFrame.ok) return;
    expect(previewFrame.receipt.status).toBe("warning");
    expect(previewFrame.warnings).toEqual([
      "Native renderer case-folded lowercase text to uppercase block glyphs on layer title: veiks."
    ]);
  });

  it("delivers text the block-glyph set covers", async () => {
    const packageRoot = await writeTextPackage("SHIP IT 2026!");
    const session = await createNativeRenderSession({ packageRoot, renderTarget: "delivery" });
    try {
      const frame = await session.renderFrameAtMs(0);
      expect(frame.ok).toBe(true);
      expect(frame.warnings).toEqual([]);
    } finally {
      session.close();
    }
  });

  it("refuses non-ASCII text on every target, preview included, because it would be noise", async () => {
    const packageRoot = await writeTextPackage("ZIEMEĻU ZIBENS");

    const result = await renderNativePreviewFrame({ packageRoot, atMs: 0 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      code: "unsupported_layer",
      unsupported: [{ layerId: "title", feature: "text.charset.non-ascii" }]
    });
  });

  it("keeps the glyph repertoire consistent with the core charset rule", () => {
    const repertoire = nativeGlyphRepertoire();
    expect(repertoire).toEqual(nativeBlockGlyphRepertoire());
    // Core declares `text.charset.non-ascii` for anything outside printable ASCII and the native card
    // does not support it. That is only sound while the font itself is pure ASCII — if a non-ASCII
    // bitmap were ever added here, core would refuse text this lane can actually draw.
    expect(repertoire.every((char) => char.codePointAt(0)! >= 0x20 && char.codePointAt(0)! <= 0x7e)).toBe(true);
    // No lowercase bitmaps exist; lowercase is reached only through the case fold.
    expect(repertoire.filter((char) => /[a-z]/.test(char))).toEqual([]);
    expect(repertoire.filter((char) => /[A-Z]/.test(char))).toHaveLength(26);
    expect(repertoire.filter((char) => /[0-9]/.test(char))).toHaveLength(10);
  });

  it("reports case folds and fallback boxes separately", () => {
    expect(caseFoldedCharacters("Hello @")).toEqual(["e", "l", "o"]);
    expect(fallbackGlyphCharacters("Hello @")).toEqual(["@"]);
    expect(caseFoldedCharacters("HELLO")).toEqual([]);
    expect(fallbackGlyphCharacters("HELLO")).toEqual([]);
    // Whitespace is layout, not a glyph, and must never be reported.
    expect(fallbackGlyphCharacters("A\tB\nC\r D")).toEqual([]);
  });
});
