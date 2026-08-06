/** Adversarial ZIP-container tests for bounded dotLottie animation selection. */
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { selectDotLottieAnimation } from "./dotlottie";

const animation = JSON.stringify({ v: "5.12.2", fr: 30, ip: 0, op: 30, w: 100, h: 100, assets: [], layers: [] });
const onePixelPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64");

describe("dotLottie selection", () => {
  it("selects one v1 animation and records converged hashes", () => {
    const archive = zip([
      { path: "manifest.json", text: JSON.stringify({ version: "1", animations: [{ id: "loader" }] }) },
      { path: "animations/loader.json", text: animation }
    ]);

    const selected = selectDotLottieAnimation(archive);
    expect(selected).toMatchObject({
      schema: "shellx-motion/dotlottie-selection@1",
      version: "1",
      animationId: "loader",
      animationPath: "animations/loader.json",
      animationText: animation,
      selectionSource: "single-animation",
      entryCount: 2
    });
    expect(selected.archiveSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(selected.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(selected.animationSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("supports v2 manifest defaults and explicit multi-animation selection", () => {
    const archive = zip([
      { path: "manifest.json", text: JSON.stringify({ version: "2", initial: { animation: "second" }, animations: [{ id: "first" }, { id: "second" }] }) },
      { path: "a/first.json", text: JSON.stringify({ ...JSON.parse(animation), nm: "First" }) },
      { path: "a/second.json", text: JSON.stringify({ ...JSON.parse(animation), nm: "Second" }) }
    ]);

    expect(selectDotLottieAnimation(archive)).toMatchObject({ animationId: "second", selectionSource: "manifest-default" });
    expect(selectDotLottieAnimation(archive, { animationId: "first" })).toMatchObject({ animationId: "first", selectionSource: "explicit" });
  });

  it("uses the first declared v2 animation when no initial asset is specified", () => {
    const archive = zip([
      { path: "manifest.json", text: JSON.stringify({ version: "2", animations: [{ id: "first" }, { id: "second" }] }) },
      { path: "a/first.json", text: JSON.stringify({ ...JSON.parse(animation), nm: "First" }) },
      { path: "a/second.json", text: JSON.stringify({ ...JSON.parse(animation), nm: "Second" }) }
    ]);

    expect(selectDotLottieAnimation(archive)).toMatchObject({ animationId: "first", selectionSource: "manifest-first" });
  });

  it("inventories and verifies declared v2 themes, state machines, and selected fonts", () => {
    const fontBytes = Buffer.from([0x77, 0x4f, 0x46, 0x46, 0, 0, 0, 0]);
    const themedAnimation = JSON.stringify({
      ...JSON.parse(animation),
      fonts: { list: [{ fName: "Brand-Bold", fFamily: "Brand", fStyle: "Bold", fPath: "f/brand.woff" }] },
      layers: [{ ty: 5, t: { d: { k: [{ s: { t: "Brand", f: "Brand-Bold", s: 24 } }] } } }]
    });
    const theme = JSON.stringify({ rules: [{ id: "accent", type: "Color", value: [1, 0, 0] }] });
    const machine = JSON.stringify({ descriptor: { id: "button" }, states: [] });
    const archive = zip([
      {
        path: "manifest.json",
        text: JSON.stringify({
          version: "2",
          initial: { animation: "hero" },
          animations: [{ id: "hero", initialTheme: "dark", themes: ["dark"], background: 0xffffffff }],
          themes: [{ id: "dark", name: "Dark" }],
          stateMachines: [{ id: "button", name: "Button" }]
        })
      },
      { path: "a/hero.json", text: themedAnimation },
      { path: "t/dark.json", text: theme },
      { path: "s/button.json", text: machine },
      { path: "f/brand.woff", bytes: fontBytes }
    ]);

    const selected = selectDotLottieAnimation(archive);
    expect(selected.inventory).toEqual({
      animations: [{ id: "hero", initialTheme: "dark", background: 0xffffffff, themes: ["dark"] }],
      themes: [{ id: "dark", name: "Dark" }],
      stateMachines: [{ id: "button", name: "Button" }],
      initial: { animation: "hero" }
    });
    expect(selected.bundledFonts).toEqual([expect.objectContaining({
      fontName: "Brand-Bold",
      fontFamily: "Brand",
      archivePath: "f/brand.woff",
      mimeType: "font/woff",
      weight: 700,
      style: "normal",
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/)
    })]);
    expect(selected.bundledResources).toEqual([
      expect.objectContaining({ kind: "theme", id: "dark", archivePath: "t/dark.json", text: theme }),
      expect.objectContaining({ kind: "state-machine", id: "button", archivePath: "s/button.json", text: machine })
    ]);
  });

  it("does not execute an initial state machine during deterministic video selection", () => {
    const archive = zip([
      {
        path: "manifest.json",
        text: JSON.stringify({
          version: "2",
          initial: { stateMachine: "button" },
          animations: [{ id: "idle" }, { id: "pressed" }],
          stateMachines: [{ id: "button" }]
        })
      },
      { path: "a/idle.json", text: animation },
      { path: "a/pressed.json", text: animation },
      { path: "s/button.json", text: JSON.stringify({ descriptor: { id: "button" }, states: [] }) }
    ]);

    expect(() => selectDotLottieAnimation(archive)).toThrow("requires an explicit animationId for deterministic video import");
    expect(selectDotLottieAnimation(archive, { animationId: "pressed" })).toMatchObject({ animationId: "pressed", selectionSource: "explicit" });
  });

  it("extracts only signature-verified images referenced by the selected animation", () => {
    const imageAnimation = JSON.stringify({
      v: "5.12.2", fr: 30, ip: 0, op: 30, w: 100, h: 100,
      assets: [{ id: "logo", w: 1, h: 1, u: "", p: "i/logo.png", e: 0 }],
      layers: [{ ind: 1, ty: 2, refId: "logo", ip: 0, op: 30, ks: {} }]
    });
    const archive = zip([
      { path: "manifest.json", text: JSON.stringify({ version: "2", animations: [{ id: "hero" }] }) },
      { path: "a/hero.json", text: imageAnimation },
      { path: "i/logo.png", bytes: onePixelPng },
      { path: "i/unused.png", bytes: onePixelPng }
    ]);

    const selected = selectDotLottieAnimation(archive);
    expect(selected.bundledImages).toEqual([expect.objectContaining({
      assetId: "logo",
      archivePath: "i/logo.png",
      mimeType: "image/png",
      width: 1,
      height: 1,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/)
    })]);
    expect(Buffer.from(selected.bundledImages[0].bytes).equals(onePixelPng)).toBe(true);
  });

  it("finds selected images referenced inside bounded precomposition assets", () => {
    const nestedAnimation = JSON.stringify({
      v: "5.12.2", fr: 30, ip: 0, op: 30, w: 100, h: 100,
      assets: [
        { id: "scene", w: 100, h: 100, layers: [{ ty: 2, refId: "logo", ip: 0, op: 30, ks: {} }] },
        { id: "logo", w: 1, h: 1, u: "", p: "i/logo.png", e: 0 }
      ],
      layers: [{ ty: 0, refId: "scene", ip: 0, op: 30, ks: {} }]
    });
    const archive = zip([
      { path: "manifest.json", text: JSON.stringify({ version: "2", animations: [{ id: "hero" }] }) },
      { path: "a/hero.json", text: nestedAnimation },
      { path: "i/logo.png", bytes: onePixelPng }
    ]);

    expect(selectDotLottieAnimation(archive).bundledImages).toEqual([
      expect.objectContaining({ assetId: "logo", archivePath: "i/logo.png", mimeType: "image/png" })
    ]);
  });

  it("rejects missing, inline, path-escaping, and signature-mismatched selected images", () => {
    const archiveFor = (asset: Record<string, unknown>, image?: { path: string; bytes: Buffer }): Buffer => zip([
      { path: "manifest.json", text: JSON.stringify({ version: "2", animations: [{ id: "hero" }] }) },
      { path: "a/hero.json", text: JSON.stringify({ v: "5.12.2", fr: 30, ip: 0, op: 30, w: 100, h: 100, assets: [asset], layers: [{ ty: 2, refId: asset.id, ks: {} }] }) },
      ...(image ? [{ path: image.path, bytes: image.bytes }] : [])
    ]);
    expect(() => selectDotLottieAnimation(archiveFor({ id: "logo", w: 1, h: 1, u: "", p: "i/missing.png", e: 0 }))).toThrow("is missing i/missing.png");
    expect(() => selectDotLottieAnimation(archiveFor({ id: "logo", w: 1, h: 1, u: "", p: "data:image/png;base64,AAAA", e: 1 }))).toThrow("must use an extracted archive file");
    expect(() => selectDotLottieAnimation(archiveFor({ id: "logo", w: 1, h: 1, u: "../", p: "escape.png", e: 0 }))).toThrow("resolve beneath i/");
    expect(() => selectDotLottieAnimation(archiveFor(
      { id: "logo", w: 1, h: 1, u: "", p: "i/logo.png", e: 0 },
      { path: "i/logo.png", bytes: Buffer.from("not-a-png") }
    ))).toThrow("signature-matched PNG");
  });

  it("rejects ambiguous v1 manifests and unsafe or duplicate archive paths", () => {
    const ambiguous = zip([
      { path: "manifest.json", text: JSON.stringify({ version: "1", animations: [{ id: "first" }, { id: "second" }] }) },
      { path: "animations/first.json", text: animation },
      { path: "animations/second.json", text: animation }
    ]);
    const traversal = zip([
      { path: "manifest.json", text: JSON.stringify({ version: "1", animations: [{ id: "safe" }] }) },
      { path: "../escape.json", text: animation },
      { path: "animations/safe.json", text: animation }
    ]);
    const duplicate = zip([
      { path: "manifest.json", text: JSON.stringify({ version: "1", animations: [{ id: "safe" }] }) },
      { path: "MANIFEST.JSON", text: "{}" },
      { path: "animations/safe.json", text: animation }
    ]);

    expect(() => selectDotLottieAnimation(ambiguous)).toThrow("require an explicit animationId");
    expect(() => selectDotLottieAnimation(traversal)).toThrow("entry path is unsafe");
    expect(() => selectDotLottieAnimation(duplicate)).toThrow("duplicate entry");
  });

  it("rejects descriptors, encrypted entries, compression bombs, and local metadata drift", () => {
    const manifest = JSON.stringify({ version: "1", animations: [{ id: "safe" }] });
    const descriptor = zip([{ path: "manifest.json", text: manifest, flags: 0x0808 }, { path: "animations/safe.json", text: animation }]);
    const encrypted = zip([{ path: "manifest.json", text: manifest, flags: 0x0801 }, { path: "animations/safe.json", text: animation }]);
    const bomb = zip([
      { path: "manifest.json", text: manifest },
      { path: "animations/safe.json", text: animation },
      { path: "i/repeat.bin", text: "x".repeat(100_000) }
    ]);
    const drift = zip([{ path: "manifest.json", text: manifest }, { path: "animations/safe.json", text: animation }]);
    drift.writeUInt16LE(0, 8);

    expect(() => selectDotLottieAnimation(descriptor)).toThrow("data descriptors");
    expect(() => selectDotLottieAnimation(encrypted)).toThrow("encrypted");
    expect(() => selectDotLottieAnimation(bomb)).toThrow("compression-ratio limit");
    expect(() => selectDotLottieAnimation(drift)).toThrow("local and central metadata differ");
  });

  it("rejects unsafe manifest object keys and undeclared selections", () => {
    const unsafe = zip([
      { path: "manifest.json", text: "{\"version\":\"1\",\"animations\":[{\"id\":\"safe\"}],\"custom\":{\"__proto__\":{}}}" },
      { path: "animations/safe.json", text: animation }
    ]);
    const valid = zip([
      { path: "manifest.json", text: JSON.stringify({ version: "1", animations: [{ id: "safe" }] }) },
      { path: "animations/safe.json", text: animation }
    ]);

    expect(() => selectDotLottieAnimation(unsafe)).toThrow("forbidden key __proto__");
    expect(() => selectDotLottieAnimation(valid, { animationId: "missing" })).toThrow("is not declared in the manifest");
  });
});

interface ZipSource {
  path: string;
  text?: string;
  bytes?: Buffer;
  flags?: number;
  method?: 0 | 8;
}

function zip(sources: ZipSource[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let localOffset = 0;
  for (const source of sources) {
    const name = Buffer.from(source.path, "utf8");
    const raw = source.bytes ?? Buffer.from(source.text ?? "", "utf8");
    const method = source.method ?? 8;
    const compressed = method === 8 ? deflateRawSync(raw) : raw;
    const checksum = testCrc32(raw);
    const flags = source.flags ?? 0x0800;
    const local = Buffer.alloc(30 + name.length + compressed.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    compressed.copy(local, 30 + name.length);
    locals.push(local);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(0o100600 * 0x10000, 38);
    central.writeUInt32LE(localOffset, 42);
    name.copy(central, 46);
    centrals.push(central);
    localOffset += local.length;
  }
  const central = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(sources.length, 8);
  eocd.writeUInt16LE(sources.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...locals, central, eocd]);
}

function testCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
