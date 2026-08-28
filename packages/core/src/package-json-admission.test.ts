import { createHash } from "node:crypto";
import { mkdir, mkdtemp, lstat, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadMotionPackage, MAX_MOTION_DOCUMENT_LAYERS, readMotionDocument } from "./package";
import { extractMotionPackageArchive } from "./package-archive";
import { loadMotionPackageFromAdmittedFiles } from "./package-admitted-files";
import {
  PACKAGE_JSON_MAX_ARRAY_ITEMS,
  PACKAGE_JSON_MAX_KEY_BYTES,
  PACKAGE_JSON_MAX_OBJECT_FIELDS,
  PACKAGE_JSON_MAX_SCALAR_BYTES,
  PACKAGE_JSON_MAX_STRING_BYTES,
  PACKAGE_JSON_MAX_STRUCTURAL_TOKENS,
  PACKAGE_JSON_MAX_VALUES,
  parseBoundedPackageJsonBytes
} from "./package-json-admission";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "./output-path-trusted-workspace";

describe("package JSON structural admission", () => {
  it("refuses deep, wide, forbidden-key, and oversized-layer documents consistently across package routes", async () => {
    const cases: Array<{ name: string; files: Record<string, string>; error: RegExp }> = [
      {
        name: "deep motion",
        files: { "manifest.json": manifestText(), "motion.json": deeplyNestedMotionText() },
        error: /pre-parse nesting limit/
      },
      {
        name: "wide manifest",
        files: { "manifest.json": wideManifestText(), "motion.json": motionText() },
        error: /object exceeds the 4096-field pre-parse limit/
      },
      {
        name: "escaped prototype template key",
        files: { "manifest.json": manifestText({ template: "template.json" }), "motion.json": motionText(), "template.json": forbiddenPrototypeTemplateText() },
        error: /forbidden object key "__proto__"/
      },
      {
        name: "oversized motion layers",
        files: { "manifest.json": manifestText(), "motion.json": oversizedLayersMotionText() },
        error: /layers exceed the 8192-layer admission limit/
      }
    ];

    for (const testCase of cases) {
      await expectRejectedByEveryPackageRoute(testCase.name, testCase.files, testCase.error);
    }
  }, 45_000);

  it("checks the layer cap before trying to map layer values", () => {
    const layers = Array.from({ length: MAX_MOTION_DOCUMENT_LAYERS + 1 }, () => minimalLayer());
    Object.defineProperty(layers, "map", {
      configurable: true,
      get() {
        throw new Error("layer map must not run for an oversized document");
      }
    });

    expect(() => readMotionDocument({ ...minimalMotionDocument(), layers })).toThrow(
      `Motion document layers exceed the ${MAX_MOTION_DOCUMENT_LAYERS}-layer admission limit.`
    );
  });

  it("rejects every JSON shape budget before calling JSON.parse", () => {
    const cases: Array<{ text: string; error: RegExp }> = [
      { text: `{\"${"k".repeat(PACKAGE_JSON_MAX_KEY_BYTES + 1)}\":0}`, error: /key exceeds/ },
      { text: `[\"${"v".repeat(PACKAGE_JSON_MAX_STRING_BYTES + 1)}\"]`, error: /string exceeds/ },
      { text: `[${"0,".repeat(PACKAGE_JSON_MAX_ARRAY_ITEMS)}0]`, error: /array exceeds/ },
      { text: "1".repeat(PACKAGE_JSON_MAX_SCALAR_BYTES + 1), error: /scalar exceeds/ },
      { text: "0 ".repeat(PACKAGE_JSON_MAX_VALUES + 1), error: /value pre-parse limit/ },
      { text: "{}".repeat(PACKAGE_JSON_MAX_STRUCTURAL_TOKENS / 2 + 1), error: /token pre-parse structural limit/ }
    ];
    const parse = vi.spyOn(JSON, "parse");
    try {
      for (const testCase of cases) {
        parse.mockClear();
        expect(() => parseBoundedPackageJsonBytes(Buffer.from(testCase.text, "utf8"), Math.max(8 * 1024 * 1024, Buffer.byteLength(testCase.text)), "Test package JSON")).toThrow(testCase.error);
        expect(parse).not.toHaveBeenCalled();
      }
    } finally {
      parse.mockRestore();
    }
  }, 45_000);

  it("retains the checked-in 4,502-layer generator package within the package admission budgets", async () => {
    const packageRoot = resolve("../../templates/generators/samples/grok-transformer-v4/package");
    const pkg = await withTrustedWorkspaceAnchor(
      await createTrustedWorkspaceAnchor(dirname(packageRoot)),
      async () => await loadMotionPackage(packageRoot)
    );
    expect(pkg.motion.layers).toHaveLength(4_502);
  }, 45_000);
});

async function expectRejectedByEveryPackageRoute(name: string, files: Record<string, string>, error: RegExp): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), `shellx-motion-package-json-${name.replace(/\s+/g, "-")}-`));
  const root = join(workspace, "source-package");
  const archivePath = join(workspace, "input.shellxmotion");
  const extractedRoot = join(workspace, "extracted");
  try {
    await mkdir(root, { mode: 0o700 });
    for (const [path, text] of Object.entries(files)) await writeFile(join(root, path), text, "utf8");

    const anchor = await createTrustedWorkspaceAnchor(workspace);
    await withTrustedWorkspaceAnchor(anchor, async () => {
      await expect(loadMotionPackage(root)).rejects.toThrow(error);

      await writeFile(archivePath, createTestTar(Object.entries(files).map(([path, text]) => ({ path, data: Buffer.from(text, "utf8") }))));
      await expect(extractMotionPackageArchive({ archivePath, packageRoot: extractedRoot })).rejects.toThrow(error);
    });

    const snapshot = new Map(Object.entries(files).map(([path, text]) => {
      const bytes = Buffer.from(text, "utf8");
      return [path, { bytes, sha256: createHash("sha256").update(bytes).digest("hex") }] as const;
    }));
    expect(() => loadMotionPackageFromAdmittedFiles(root, snapshot)).toThrow(error);

    await expect(lstat(extractedRoot)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

function manifestText(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: "shellx-motion/package-manifest@1",
    id: "pkg_json_admission",
    name: "JSON admission",
    motion: "motion.json",
    assets: [],
    sourceApp: "shellx-motion",
    compatibility: { lanes: ["browser"], hosts: ["motion"] },
    ...overrides
  });
}

function motionText(): string {
  return JSON.stringify(minimalMotionDocument());
}

function deeplyNestedMotionText(): string {
  const nested = `${"{\"child\":".repeat(64)}0${"}".repeat(64)}`;
  return `${motionText().slice(0, -1)},"extra":${nested}}`;
}

function wideManifestText(): string {
  const fields = Array.from(
    { length: PACKAGE_JSON_MAX_OBJECT_FIELDS + 1 },
    (_entry, index) => `${JSON.stringify(`padding_${index}`)}:0`
  );
  return `${manifestText().slice(0, -1)},${fields.join(",")}}`;
}

function forbiddenPrototypeTemplateText(): string {
  return "{\"schema\":\"shellx-motion/template@1\",\"id\":\"template_json_admission\",\"name\":\"JSON admission\",\"motion\":\"motion.json\",\"compatibleLanes\":[],\"params\":[],\"controls\":[],\"bindings\":[],\"\\u005f\\u005fproto__\":{}}";
}

function oversizedLayersMotionText(): string {
  const layer = JSON.stringify(minimalLayer());
  return JSON.stringify({
    ...minimalMotionDocument(),
    layers: Array.from({ length: MAX_MOTION_DOCUMENT_LAYERS + 1 }, () => JSON.parse(layer))
  });
}

function minimalMotionDocument(): Record<string, unknown> {
  return {
    schema: "shellx-motion/motion@1",
    id: "motion_json_admission",
    name: "JSON admission",
    durationMs: 1_000,
    fps: 30,
    width: 640,
    height: 360,
    layers: [minimalLayer()],
    assets: [],
    provenance: { sourceApp: "shellx-motion", createdBy: "test" }
  };
}

function minimalLayer(): Record<string, unknown> {
  return { id: "title", type: "text", startMs: 0, durationMs: 1_000 };
}

function createTestTar(entries: Array<{ path: string; data: Buffer }>): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    writeString(header, 0, 100, entry.path);
    writeOctal(header, 100, 8, 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, entry.data.byteLength);
    writeOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    writeString(header, 156, 1, "0");
    writeString(header, 257, 6, "ustar");
    writeString(header, 263, 2, "00");
    let checksum = 0;
    for (const byte of header) checksum += byte;
    writeChecksum(header, checksum);
    chunks.push(header, entry.data);
    const padding = entry.data.byteLength % 512 === 0 ? 0 : 512 - (entry.data.byteLength % 512);
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

function writeString(buffer: Buffer, offset: number, length: number, value: string): void {
  Buffer.from(value, "utf8").copy(buffer, offset, 0, length);
}

function writeOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  buffer.write(value.toString(8).padStart(length - 1, "0"), offset, length - 1, "ascii");
}

function writeChecksum(buffer: Buffer, value: number): void {
  buffer.write(value.toString(8).padStart(6, "0"), 148, 6, "ascii");
  buffer[154] = 0;
  buffer[155] = 0x20;
}
