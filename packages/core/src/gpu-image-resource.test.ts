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
