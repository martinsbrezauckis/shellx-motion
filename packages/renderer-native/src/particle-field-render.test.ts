import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NATIVE_CAPABILITY, renderNativePreviewFrame } from "./index";

const tempDirs: string[] = [];
afterEach(async () => { await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("native analytic particle field raster", () => {
  it("is seeded-byte-stable and changes at an active later timestamp", async () => {
    const packageRoot = await writeParticleFieldPackage();
    const first = await renderNativePreviewFrame({ packageRoot, atMs: 0 });
    const firstAgain = await renderNativePreviewFrame({ packageRoot, atMs: 0 });
    const later = await renderNativePreviewFrame({ packageRoot, atMs: 500 });

    expect(first.ok).toBe(true);
    expect(firstAgain.ok).toBe(true);
    expect(later.ok).toBe(true);
    if (!first.ok || !firstAgain.ok || !later.ok) return;
    expect(NATIVE_CAPABILITY.layerTypes).toContain("particles");
    expect(NATIVE_CAPABILITY.features).toEqual(expect.arrayContaining(["particles.seeded", "particles.analytic-field"]));
    expect(first.frame.sha256).toBe(firstAgain.frame.sha256);
    expect(first.frame.sha256).not.toBe(later.frame.sha256);
  });
});

async function writeParticleFieldPackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-native-particle-field-"));
  tempDirs.push(root);
  await writeFile(join(root, "manifest.json"), `${JSON.stringify({
    schema: "shellx-motion/package-manifest@1", id: "pkg_particle_field", name: "Particle Field",
    motion: "motion.json", assets: [], sourceApp: "shellx-motion",
    compatibility: { lanes: ["native"], hosts: ["motion"] }
  })}\n`);
  await writeFile(join(root, "motion.json"), `${JSON.stringify({
    schema: "shellx-motion/motion@1", id: "motion_particle_field", name: "Particle Field",
    durationMs: 1_000, fps: 30, width: 100, height: 100, background: "#030712", assets: [],
    provenance: { sourceApp: "shellx-motion", createdBy: "test" },
    layers: [{
      id: "spark-field", type: "particles", startMs: 0, durationMs: 1_000,
      transform: { x: 0, y: 0, width: 100, height: 100 },
      emitter: {
        seed: 7, count: 32, lifetimeMs: 900, color: "#ffffff", shape: "square",
        minSize: 2, maxSize: 4, minSpeed: 20, maxSpeed: 60,
        field: { schema: "shellx-motion/particle-field@1", sources: [
          { kind: "radial", centerX: 0.5, centerY: 0.5, strength: 0.6, softening: 0.2 },
          { kind: "vortex", centerX: 0.5, centerY: 0.5, strength: -0.25, softening: 0.15 }
        ] }
      }
    }]
  })}\n`);
  return root;
}
