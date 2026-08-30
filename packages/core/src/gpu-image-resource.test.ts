import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { classifyGpuImageResource, GpuImageResourceClassificationError } from "./gpu-image-resource";

describe("GPU image resource classification", () => {
  it.each([
    ["JPEG", jpeg(3, 2), "image/jpeg", "precontained-browser-static-raster"],
    ["WebP", webp(3, 2), "image/webp", "precontained-browser-static-raster"],
    ["static SVG", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="3" height="2"><rect width="3" height="2" fill="#0ea5e9"/></svg>'), "image/svg+xml", "precontained-browser-static-raster"]
  ] as const)("admits bounded static %s only with exact MIME, dimensions, and a contained-page decoder", (_label, bytes, mimeType, decodeAuthority) => {
    expect(classifyGpuImageResource(bytes, mimeType)).toEqual({
      mimeType,
      width: 3,
      height: 2,
      decodedBytes: 24,
      decodeAuthority,
      staticSvg: mimeType === "image/svg+xml"
    });
  });

  it("refuses SVG executable, external-reference, and font syntax before any renderer page is opened", () => {
    for (const hostile of [
      '<svg width="3" height="2"><script>alert(1)</script></svg>',
      '<svg width="3" height="2"><image href="https://example.invalid/pixel.png"/></svg>',
      '<svg width="3" height="2"><style>@font-face{font-family:x;src:url(https://example.invalid/font)}</style></svg>',
      '<svg width="3" height="2"><foreignObject><div>hostile</div></foreignObject></svg>',
      '<svg width="3" height="2" onload="alert(1)"><rect width="3" height="2"/></svg>'
    ]) {
      expect(() => classifyGpuImageResource(Buffer.from(hostile), "image/svg+xml")).toThrow(GpuImageResourceClassificationError);
    }
  });

  it("keeps every static SVG executable, external-reference, and font refusal", () => {
    for (const hostile of [
      '<!DOCTYPE svg><svg width="3" height="2"/>',
      '<!ENTITY x "y"><svg width="3" height="2"/>',
      '<?process test?><svg width="3" height="2"/>',
      '<svg width="3" height="2"><script/></svg>',
      '<svg width="3" height="2"><foreignObject/></svg>',
      '<svg width="3" height="2"><iframe/></svg>',
      '<svg width="3" height="2"><object/></svg>',
      '<svg width="3" height="2"><embed/></svg>',
      '<svg width="3" height="2"><audio/></svg>',
      '<svg width="3" height="2"><video/></svg>',
      '<svg width="3" height="2"><canvas/></svg>',
      '<svg width="3" height="2"><text/></svg>',
      '<svg width="3" height="2"><font/></svg>',
      '<svg width="3" height="2"><animate/></svg>',
      '<svg width="3" height="2"><set/></svg>',
      '<svg width="3" height="2" xlink:onload="run()"/>',
      '<svg width="3" height="2"><use xlink:href="https://example.invalid/icon.svg#x"/></svg>',
      '<svg width="3" height="2"><style>@import url(https://example.invalid/theme.css)</style></svg>',
      '<svg width="3" height="2"><style>@font-face{font-family:x}</style></svg>',
      '<svg width="3" height="2"><style>rect{font-size:12px}</style></svg>',
      '<svg width="3" height="2"><style>@keyframes spin{to{}}</style></svg>',
      '<svg width="3" height="2"><style>rect{transition:opacity 1s}</style></svg>',
      '<svg width="3" height="2"><rect fill="url(https://example.invalid/paint)"/></svg>'
    ]) {
      expect(() => classifyGpuImageResource(Buffer.from(hostile), "image/svg+xml"), hostile).toThrow(GpuImageResourceClassificationError);
    }
  });

  it("matches legacy XML/root grammar without rewriting the SVG byte snapshot", () => {
    for (const source of [
      '<svg width="3" height="2"/>',
      '\u00a0<?XML version="1.0"?>\n<SVG width="3px" height="2px"/>',
      '\ufeff<svg viewBox="0, 0, 3, 2"><rect fill="url(#paint)"/></svg>',
      '<svg-custom width="3" height="2"/>',
      '<svg:legacy width="3" height="2"/>'
    ]) {
      const bytes = Buffer.from(source, "utf8");
      const before = Buffer.from(bytes);
      const expectedSha256 = createHash("sha256").update(bytes).digest("hex");
      const legacy = legacySvgDimensions(source);
      expect(legacy, source).not.toBeNull();

      const classified = classifyGpuImageResource(bytes, "image/svg+xml");
      expect(classified).toMatchObject({ mimeType: "image/svg+xml", width: legacy?.width, height: legacy?.height, staticSvg: true });
      expect(bytes.equals(before), source).toBe(true);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(expectedSha256);
    }
  });

  it("scans static SVG prologues near-linearly below the caller's 64 MiB asset ceiling", () => {
    const smallPrefixBytes = 4 * 1024 * 1024;
    const largePrefixBytes = smallPrefixBytes * 4;
    const timeFor = (prefixBytes: number): number => {
      const bytes = Buffer.from(`${" ".repeat(prefixBytes)}<svg width="3" height="2"/>`, "utf8");
      const started = performance.now();
      expect(classifyGpuImageResource(bytes, "image/svg+xml")).toMatchObject({ width: 3, height: 2 });
      return performance.now() - started;
    };

    timeFor(smallPrefixBytes);
    const small = Math.max(timeFor(smallPrefixBytes), 1);
    const large = timeFor(largePrefixBytes);
    // The production caller refuses a single GPU image above 64 MiB; this 4x pair stays well
    // beneath that ceiling while detecting the old repeated-prologue scan shape.
    expect(large).toBeLessThan(small * 9);
  });

  it("refuses animated WebP and SVG syntax rather than selecting an implicit frame", () => {
    expect(() => classifyGpuImageResource(webp(3, 2, 0x02), "image/webp")).toThrow(/Animated WebP/);
    for (const animated of [
      '<svg width="3" height="2"><animate attributeName="x"/></svg>',
      '<svg width="3" height="2"><animateTransform attributeName="transform"/></svg>',
      '<svg width="3" height="2"><set attributeName="opacity" to="0"/></svg>',
      '<svg width="3" height="2"><style>@keyframes pulse{to{opacity:0}} rect{animation:pulse 1s infinite}</style><rect width="3" height="2"/></svg>',
      '<svg width="3" height="2"><rect style="transition: opacity 1s" width="3" height="2"/></svg>'
    ]) {
      expect(() => classifyGpuImageResource(Buffer.from(animated), "image/svg+xml")).toThrow(GpuImageResourceClassificationError);
    }
  });

  it("refuses oversized raster declarations before a browser decoder or texture allocation", () => {
    expect(() => classifyGpuImageResource(jpeg(3_841, 2), "image/jpeg")).toThrow(/resource budget/);
    expect(() => classifyGpuImageResource(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="3840" height="2161"/>'), "image/svg+xml")).toThrow(/resource budget/);
  });

  it("refuses a MIME claim that disagrees with exact image bytes", () => {
    expect(() => classifyGpuImageResource(webp(3, 2), "image/jpeg")).toThrow(/does not match/);
  });
});

function jpeg(width: number, height: number): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x08, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x01, 0x11, 0x00, 0xff, 0xd9]);
}

function webp(width: number, height: number, flags = 0): Buffer {
  const bytes = Buffer.alloc(30);
  bytes.write("RIFF", 0, "ascii"); bytes.writeUInt32LE(bytes.byteLength - 8, 4); bytes.write("WEBP", 8, "ascii");
  bytes.write("VP8X", 12, "ascii"); bytes.writeUInt32LE(10, 16);
  bytes[20] = flags;
  bytes[24] = (width - 1) & 0xff; bytes[25] = ((width - 1) >>> 8) & 0xff; bytes[26] = ((width - 1) >>> 16) & 0xff;
  bytes[27] = (height - 1) & 0xff; bytes[28] = ((height - 1) >>> 8) & 0xff; bytes[29] = ((height - 1) >>> 16) & 0xff;
  return bytes;
}

/** Legacy root/dimension extraction, retained as a small-input equivalence oracle only. */
function legacySvgDimensions(source: string): { width: number; height: number } | null {
  const root = source.match(/^\s*(?:<\?xml\s+[^>]*\?>\s*)?<svg\b([^>]*)>/i);
  if (!root) return null;
  const attributes = root[1] ?? "";
  const width = legacySvgLength(attributes, "width");
  const height = legacySvgLength(attributes, "height");
  const viewBox = attributes.match(/\bviewBox\s*=\s*(["'])([^"']+)\1/i)?.[2]?.trim().split(/[\s,]+/).map(Number);
  const viewBoxWidth = viewBox?.length === 4 && viewBox.every(Number.isFinite) ? viewBox[2] : undefined;
  const viewBoxHeight = viewBox?.length === 4 && viewBox.every(Number.isFinite) ? viewBox[3] : undefined;
  const resolvedWidth = width ?? viewBoxWidth;
  const resolvedHeight = height ?? viewBoxHeight;
  return resolvedWidth !== undefined && resolvedHeight !== undefined && Number.isInteger(resolvedWidth) && Number.isInteger(resolvedHeight)
    ? { width: resolvedWidth, height: resolvedHeight }
    : null;
}

function legacySvgLength(attributes: string, name: "width" | "height"): number | undefined {
  const raw = attributes.match(new RegExp(`\\b${name}\\s*=\\s*(["'])([^"']+)\\1`, "i"))?.[2]?.trim();
  const match = raw?.match(/^([0-9]+)(?:px)?$/i);
  return match ? Number(match[1]) : undefined;
}
