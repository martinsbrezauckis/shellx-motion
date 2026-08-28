import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MotionPackage } from "@shellx-motion/core";
import { describe, expect, it } from "vitest";
import { renderMotionGpuPreview } from "./gpu-points-preview";

describe("O6 Browser document-root fence", () => {
  it("refuses hostile assets/layers before manifest, hash, resources, runtime, or output", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-o6-document-root-fence-"));
    try {
      for (const field of ["assets", "layers", "id", "name", "durationMs", "fps", "width", "height", "background", "provenance", "safeAreas", "designTokens"] as const) {
        const pkg = o6Package(root), value = pkg.motion[field], manifest = pkg.manifest, packageRoot = pkg.root;
        let fieldReads = 0, hashReads = 0, manifestReads = 0, rootReads = 0, resources = 0, opened = 0;
        Object.defineProperty(pkg.motion, field, { configurable: true, enumerable: true, get() { fieldReads += 1; return value; } });
        Object.defineProperty(pkg.motion, "toJSON", { configurable: true, get() { hashReads += 1; throw new Error("hash must remain unopened"); } });
        Object.defineProperty(pkg, "manifest", { configurable: true, enumerable: true, get() { manifestReads += 1; return manifest; } }); Object.defineProperty(pkg, "root", { configurable: true, enumerable: true, get() { rootReads += 1; return packageRoot; } });
        await expect(renderMotionGpuPreview(pkg, { atMs: 0, outDir: join(root, field), sessionOptions: { async prepareResourcesForTest() { resources += 1; throw new Error("resources must not prepare"); }, async openRuntime() { opened += 1; throw new Error("runtime must not open"); } } })).resolves.toMatchObject({ ok: false, error: { code: "gpu_unsupported_feature", message: expect.stringContaining(`${field} as an enumerable data field`) } });
        expect({ fieldReads, hashReads, manifestReads, rootReads, resources, opened }).toEqual({ fieldReads: 0, hashReads: 0, manifestReads: 0, rootReads: 0, resources: 0, opened: 0 }); await expect(stat(join(root, field))).rejects.toMatchObject({ code: "ENOENT" });
      }
      for (const field of ["privateGetter", "behaviors", "relations"] as const) {
        const pkg = o6Package(root), manifest = pkg.manifest, packageRoot = pkg.root;
        let fieldReads = 0, hashReads = 0, manifestReads = 0, rootReads = 0, resources = 0, opened = 0;
        Object.defineProperty(pkg.motion, field, { configurable: true, get() { fieldReads += 1; throw new Error(`${field} must remain unread`); } });
        Object.defineProperty(pkg.motion, "toJSON", { configurable: true, get() { hashReads += 1; throw new Error("hash must remain unopened"); } });
        Object.defineProperty(pkg, "manifest", { configurable: true, enumerable: true, get() { manifestReads += 1; return manifest; } }); Object.defineProperty(pkg, "root", { configurable: true, enumerable: true, get() { rootReads += 1; return packageRoot; } });
        await expect(renderMotionGpuPreview(pkg, { atMs: 0, outDir: join(root, `hidden-${field}`), sessionOptions: { async prepareResourcesForTest() { resources += 1; throw new Error("resources must not prepare"); }, async openRuntime() { opened += 1; throw new Error("runtime must not open"); } } })).resolves.toMatchObject({ ok: false, error: { code: "gpu_unsupported_feature", message: expect.stringContaining(`${field} as an enumerable data field`) } });
        expect({ fieldReads, hashReads, manifestReads, rootReads, resources, opened }).toEqual({ fieldReads: 0, hashReads: 0, manifestReads: 0, rootReads: 0, resources: 0, opened: 0 }); await expect(stat(join(root, `hidden-${field}`))).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("refuses inherited O6 roots before direct Browser package work", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-o6-inherited-root-fence-")), pkg = o6Package(root), manifest = pkg.manifest, packageRoot = pkg.root;
    pkg.motion = Object.assign(Object.create({ relationships: {} }), pkg.motion) as typeof pkg.motion;
    let manifestReads = 0, rootReads = 0, resources = 0, opened = 0;
    Object.defineProperty(pkg, "manifest", { configurable: true, enumerable: true, get() { manifestReads += 1; return manifest; } }); Object.defineProperty(pkg, "root", { configurable: true, enumerable: true, get() { rootReads += 1; return packageRoot; } });
    try {
      await expect(renderMotionGpuPreview(pkg, { atMs: 0, outDir: join(root, "out"), sessionOptions: { async prepareResourcesForTest() { resources += 1; throw new Error("resources must not prepare"); }, async openRuntime() { opened += 1; throw new Error("runtime must not open"); } } })).resolves.toMatchObject({ ok: false, error: { code: "gpu_unsupported_feature", message: expect.stringContaining("plain Motion document") } });
      expect({ manifestReads, rootReads, resources, opened }).toEqual({ manifestReads: 0, rootReads: 0, resources: 0, opened: 0 }); await expect(stat(join(root, "out"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("refuses nested O6 accessors and reflection-hostile proxies before Browser package work", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-o6-nested-root-fence-"));
    try {
      const cases: ReadonlyArray<readonly [string, (motion: Record<string, unknown>, onRead: () => void) => void]> = [
        ["start", (motion, onRead) => Object.defineProperty((motion.layers as Array<Record<string, unknown>>)[0]!, "startMs", { configurable: true, enumerable: true, get: onRead })],
        ["transform", (motion, onRead) => Object.defineProperty((motion.layers as Array<Record<string, unknown>>)[0]!, "transform", { configurable: true, enumerable: true, get: onRead })],
        ["objects", (motion, onRead) => Object.defineProperty((motion.layers as Array<Record<string, unknown>>)[0]!.scene3d as object, "objects", { configurable: true, enumerable: true, get: onRead })],
        ["mesh-materials", (motion, onRead) => {
          const object = (((motion.layers as Array<Record<string, unknown>>)[0]!.scene3d as Record<string, unknown>).objects as Array<Record<string, unknown>>)[0]!;
          object.mesh = { materials: [] };
          Object.defineProperty(object.mesh as object, "materials", { configurable: true, enumerable: true, get: onRead });
        }],
      ];
      for (const [label, install] of cases) {
        const pkg = nestedO6Package(root), manifest = pkg.manifest, packageRoot = pkg.root;
        let reads = 0, hashReads = 0, manifestReads = 0, rootReads = 0, resources = 0, opened = 0;
        install(pkg.motion as unknown as Record<string, unknown>, () => { reads += 1; throw new Error(`${label} getter must remain unread`); });
        Object.defineProperty(pkg.motion, "toJSON", { configurable: true, get() { hashReads += 1; throw new Error("hash must remain unopened"); } });
        Object.defineProperty(pkg, "manifest", { configurable: true, enumerable: true, get() { manifestReads += 1; return manifest; } }); Object.defineProperty(pkg, "root", { configurable: true, enumerable: true, get() { rootReads += 1; return packageRoot; } });
        await expect(renderMotionGpuPreview(pkg, { atMs: 0, outDir: join(root, label), sessionOptions: { async prepareResourcesForTest() { resources += 1; throw new Error("resources must not prepare"); }, async openRuntime() { opened += 1; throw new Error("runtime must not open"); } } })).resolves.toMatchObject({ ok: false, error: { code: "gpu_unsupported_feature" } });
        expect({ reads, hashReads, manifestReads, rootReads, resources, opened }).toEqual({ reads: 0, hashReads: 0, manifestReads: 0, rootReads: 0, resources: 0, opened: 0 }); await expect(stat(join(root, label))).rejects.toMatchObject({ code: "ENOENT" });
      }

      const pkg = nestedO6Package(root), manifest = pkg.manifest, packageRoot = pkg.root;
      let proxyReads = 0, hashReads = 0, manifestReads = 0, rootReads = 0, resources = 0, opened = 0;
      const scene = (pkg.motion.layers[0]!.scene3d as unknown as Record<string, unknown>);
      scene.objects = new Proxy(scene.objects as object, { ownKeys() { throw new Error("reflection must be refused"); }, get() { proxyReads += 1; throw new Error("proxy must remain unread"); } });
      Object.defineProperty(pkg.motion, "toJSON", { configurable: true, get() { hashReads += 1; throw new Error("hash must remain unopened"); } });
      Object.defineProperty(pkg, "manifest", { configurable: true, enumerable: true, get() { manifestReads += 1; return manifest; } }); Object.defineProperty(pkg, "root", { configurable: true, enumerable: true, get() { rootReads += 1; return packageRoot; } });
      await expect(renderMotionGpuPreview(pkg, { atMs: 0, outDir: join(root, "proxy"), sessionOptions: { async prepareResourcesForTest() { resources += 1; throw new Error("resources must not prepare"); }, async openRuntime() { opened += 1; throw new Error("runtime must not open"); } } })).resolves.toMatchObject({ ok: false, error: { code: "gpu_unsupported_feature", message: expect.stringContaining("reflection failed") } });
      expect({ proxyReads, hashReads, manifestReads, rootReads, resources, opened }).toEqual({ proxyReads: 0, hashReads: 0, manifestReads: 0, rootReads: 0, resources: 0, opened: 0 }); await expect(stat(join(root, "proxy"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

function o6Package(root: string): MotionPackage {
  return { root, manifest: { assets: [] }, motion: { assets: [], layers: [], scene3dAnimation: { schema: "shellx-motion/scene3d-animation@1", tracks: [] } } } as unknown as MotionPackage;
}

function nestedO6Package(root: string): MotionPackage {
  return {
    root,
    manifest: { assets: [] },
    motion: {
      schema: "shellx-motion/motion@1", id: "nested-o6", name: "Nested O6", durationMs: 1_000, fps: 30, width: 16, height: 8, assets: [], provenance: { sourceApp: "test", createdBy: "test" },
      layers: [{
        id: "world", type: "scene3d", startMs: 0, durationMs: 1_000, transform: { x: 0, y: 0, width: 16, height: 8 },
        scene3d: {
          schema: "shellx-motion/scene3d@1", camera: { position: [0, 0, 1], target: [0, 0, 0], fovDeg: 45, near: 0.1, far: 10 },
          lighting: { ambient: 0, direction: [0, -1, 0], intensity: 1, color: "#ffffff" }, backgroundColor: "#000000",
          objects: [{ id: "object", primitive: "box", position: [0, 0, 0], rotationDeg: [0, 0, 0], scale: 1, color: "#ffffff", emissive: 0 }],
        },
      }],
      scene3dAnimation: { schema: "shellx-motion/scene3d-animation@1", tracks: [] },
    },
  } as unknown as MotionPackage;
}
