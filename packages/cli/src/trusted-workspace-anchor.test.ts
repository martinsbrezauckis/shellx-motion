import { realpathSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadMotionPackage } from "@shellx-motion/core";
import { hasAtomicCOWAuthority } from "@shellx-motion/core/test-support";
import { withCliSourceWorkspaceAnchor } from "./debug-context-cli";
import { runCli } from "./main";

const roots: string[] = [];
const fixture = resolve("../../fixtures/packages/lower-third");
const proceduralFixture = resolve("../../fixtures/packages/procedural-relationships");
// A negative test needs a route outside the source checkout. The test runner may redirect
// tmpdir() into checkout-local scratch, so name the host's known unmanaged sticky root directly;
// this is refusal-only and every created child is tracked for exact cleanup.
const UNMANAGED_EXTERNAL_TEST_ROOT = process.platform === "win32" ? tmpdir() : realpathSync("/tmp");
const MANAGED_ORDINARY_COW_REFUSAL = !hasAtomicCOWAuthority(UNMANAGED_EXTERNAL_TEST_ROOT)
  && !hasAtomicCOWAuthority(process.cwd());
const behaviorFixture = resolve("../../fixtures/packages/gpu-g9-particle-cathedral");

afterEach(async () => await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))));

describe("CLI trusted workspace anchor", () => {
  it("reads the documented lower-third fixture through top-level validate", async () => {
    const result = await runCli(["validate", fixture]);

    expect(result).toMatchObject({ ok: true, command: "validate", packageId: "pkg_lower_third" });
  });

  it("allows a repo-local lower-third COW without admitting external output roots", async () => {
    const root = await mkdtemp(join(process.cwd(), ".shellx-motion-cli-cow-"));
    roots.push(root);
    const source = join(root, "source");
    const outDir = join(root, "revision");
    const receiptsRoot = join(root, "host-receipts");
    await cp(fixture, source, { recursive: true });

    const result = await runCli([
      "debug", "package-patch", "--tier", "edit_motion", "--trusted-local-tier",
      "--package", source, "--out", outDir, "--receipts-root", receiptsRoot,
      "--patch-json", '[{"op":"replace","path":"/layers/0/text","value":"Managed WSL"}]'
    ]);

    expect(result).toMatchObject({ ok: true, result: { packageDir: outDir } });
    expect(await readFile(join(source, "motion.json"), "utf8")).toContain('"text": "Anna"');
    expect(await readFile(join(outDir, "motion.json"), "utf8")).toContain('"text": "Managed WSL"');
    expect(await readFile(join(outDir, "receipts", "package-patch.receipt.json"), "utf8")).toContain('"operation": "package.patch"');
  });

  it("derives procedural CLI roots and preserves source through its documented COW route", async () => {
    const root = await mkdtemp(join(process.cwd(), ".shellx-motion-cli-procedural-"));
    roots.push(root);
    const source = join(root, "source");
    const outDir = join(root, "disabled");
    await cp(proceduralFixture, source, { recursive: true });
    const before = await readFile(join(source, "motion.json"), "utf8");

    const inspected = await runCli([
      "debug", "procedural-inspect", "--package", source,
    ]);
    expect(inspected).toMatchObject({ ok: true, result: { packageId: "pkg_procedural_relationships" } });

    const result = await runCli([
      "debug", "procedural-enabled-set", "--tier", "edit_motion", "--trusted-local-tier",
      "--package", source, "--out", outDir, "--relationship", "time-to-x", "--disabled",
    ]);
    expect(result).toMatchObject({ ok: true, result: { packageRoot: outDir } });
    expect(await readFile(join(source, "motion.json"), "utf8")).toEqual(before);
    expect(await readFile(join(outDir, "motion.json"), "utf8")).toContain('"enabled": false');
    expect(await readFile(join(outDir, "receipts", "procedural-relationship-enabled-set.receipt.json"), "utf8"))
      .toContain('"operation": "procedural.relationship.enabled.set"');
  });

  it("runs inspect, upsert, move, and delete as source-preserving COW with one isolated host receipt per mutation", async () => {
    const root = await mkdtemp(join(process.cwd(), ".shellx-motion-cli-geometry-keyframes-"));
    roots.push(root);
    const source = await writeGeometryPackage(join(root, "source"));
    const first = join(root, "first");
    const second = join(root, "second");
    const moved = join(root, "moved");
    const deleted = join(root, "deleted");
    const before = await readFile(join(source, "motion.json"));
    const hostReceiptPaths: string[] = [];
    try {
      const initial = await runCli([
        "debug", "shape-geometry-keyframes-inspect", "--tier", "edit_motion", "--trusted-local-tier",
        "--package", source, "--layer", "shape",
      ]);
      expect(initial).toMatchObject({ ok: true, result: { inspection: { geometryKeyframes: null, evaluation: null } } });

      const upsertFirst = await runCli([
        "debug", "shape-geometry-keyframes-upsert", "--tier", "edit_motion", "--trusted-local-tier",
        "--package", source, "--out", first, "--layer", "shape",
        "--snapshot-json", JSON.stringify(shapeSnapshot(0, 10)),
      ]);
      expect(upsertFirst).toMatchObject({ ok: true, result: { packageDir: first, action: "inserted", geometryKeyframes: { atUs: 0 } } });
      hostReceiptPaths.push(resultHostReceiptPath(upsertFirst));
      const firstBefore = await readFile(join(first, "motion.json"));

      const upsertSecond = await runCli([
        "debug", "shape-geometry-keyframes-upsert", "--tier", "edit_motion", "--trusted-local-tier",
        "--package", first, "--out", second, "--layer", "shape",
        "--snapshot-json", JSON.stringify(shapeSnapshot(500_000, 20)),
      ]);
      expect(upsertSecond).toMatchObject({ ok: true, result: { packageDir: second, action: "inserted", geometryKeyframes: { atUs: 500_000 } } });
      hostReceiptPaths.push(resultHostReceiptPath(upsertSecond));
      expect(await readFile(join(first, "motion.json"))).toEqual(firstBefore);
      const secondBefore = await readFile(join(second, "motion.json"));

      const move = await runCli([
        "debug", "shape-geometry-keyframes-move", "--tier", "edit_motion", "--trusted-local-tier",
        "--package", second, "--out", moved, "--layer", "shape", "--from-at-us", "500000", "--to-at-us", "750000",
      ]);
      expect(move).toMatchObject({ ok: true, result: { packageDir: moved, action: "moved", geometryKeyframes: { atUs: 750_000 } } });
      hostReceiptPaths.push(resultHostReceiptPath(move));
      expect(await readFile(join(second, "motion.json"))).toEqual(secondBefore);
      const movedBefore = await readFile(join(moved, "motion.json"));

      const remove = await runCli([
        "debug", "shape-geometry-keyframes-delete", "--tier", "edit_motion", "--trusted-local-tier",
        "--package", moved, "--out", deleted, "--layer", "shape", "--at-us", "750000",
      ]);
      expect(remove).toMatchObject({ ok: true, result: { packageDir: deleted, action: "deleted", geometryKeyframes: { atUs: 750_000 } } });
      hostReceiptPaths.push(resultHostReceiptPath(remove));
      expect(await readFile(join(moved, "motion.json"))).toEqual(movedBefore);

      expect(new Set(hostReceiptPaths).size).toBe(4);
      for (const hostReceiptPath of hostReceiptPaths) {
        expect(hostReceiptPath).toContain(join(".scratch", "cli-host-receipts", "timeline-shape-geometry-keyframes"));
        expect(await readFile(hostReceiptPath, "utf8")).toContain('"operation": "timeline.shape.geometry-keyframes');
      }
      expect(await readFile(join(first, "receipts", "timeline-shape-geometry-keyframes-upsert.receipt.json"), "utf8"))
        .toContain('"outputMotionSha256"');
      const reopened = await withCliSourceWorkspaceAnchor([deleted], async () => await loadMotionPackage(deleted));
      expect(reopened.motion.layers.find((layer) => layer.id === "shape")?.geometryKeyframes?.keyframes).toMatchObject([{ atUs: 0 }]);
      const finalInspection = await runCli([
        "debug", "shape-geometry-keyframes-inspect", "--tier", "edit_motion", "--trusted-local-tier",
        "--package", deleted, "--layer", "shape",
      ]);
      expect(finalInspection).toMatchObject({ ok: true, result: { inspection: { geometryKeyframes: { keyframes: [{ atUs: 0 }] } } } });
      expect(await readFile(join(source, "motion.json"))).toEqual(before);
    } finally {
      await Promise.all(hostReceiptPaths.map(async (path) => await rm(dirname(path), { recursive: true, force: true })));
    }
  });

  it("runs closed behavior inspect, upsert, and remove as source-preserving COW with host-owned receipts", async () => {
    const root = await mkdtemp(join(process.cwd(), ".shellx-motion-cli-behaviors-"));
    roots.push(root);
    const source = join(root, "source");
    const added = join(root, "added");
    const removed = join(root, "removed");
    await cp(behaviorFixture, source, { recursive: true });
    const before = await readFile(join(source, "motion.json"));
    const hostReceiptPaths: string[] = [];
    const behavior = {
      targetLayerId: "midnight-field", enabled: true, kind: "transform", startUs: 0, durationUs: 7_200_000,
      motion: { kind: "gravity", velocityX: 1, velocityY: 0, gravityY: 0 },
    };
    try {
      const initial = await runCli([
        "debug", "behaviors-inspect", "--tier", "read_motion", "--trusted-local-tier", "--package", source,
      ]);
      expect(initial).toMatchObject({ ok: true, result: { inspection: { store: null } } });

      const upsert = await runCli([
        "debug", "behaviors-upsert", "--tier", "edit_motion", "--trusted-local-tier",
        "--package", source, "--out", added, "--package-dir", relative(process.cwd(), added), "--binding-json", JSON.stringify(behavior),
      ]);
      expect(upsert).toMatchObject({ ok: true, result: { packageDir: added, action: "upserted", targetLayerId: "midnight-field" } });
      hostReceiptPaths.push(resultHostReceiptPath(upsert));
      expect(await readFile(join(source, "motion.json"))).toEqual(before);
      expect(await readFile(join(added, "receipts", "timeline-behaviors-upsert.receipt.json"), "utf8"))
        .toContain('"operation": "timeline.behaviors.upsert"');

      const remove = await runCli([
        "debug", "behaviors-remove", "--tier", "edit_motion", "--trusted-local-tier",
        "--package", added, "--out", removed, "--package-dir", relative(process.cwd(), removed), "--target-layer-id", "midnight-field",
      ]);
      expect(remove).toMatchObject({ ok: true, result: { packageDir: removed, action: "removed", targetLayerId: "midnight-field" } });
      hostReceiptPaths.push(resultHostReceiptPath(remove));
      expect(JSON.parse(await readFile(join(removed, "motion.json"), "utf8"))).not.toHaveProperty("behaviors");
      expect(await readFile(join(added, "motion.json"), "utf8")).toContain('"behaviors"');

      for (const hostReceiptPath of hostReceiptPaths) {
        expect(hostReceiptPath).toContain(join(".scratch", "cli-host-receipts", "timeline-behaviors"));
        expect(await readFile(hostReceiptPath, "utf8")).toContain('"operation": "timeline.behaviors.');
      }

      const callerReceiptRoot = join(root, "caller-receipts");
      const rejected = await runCli([
        "debug", "behaviors-upsert", "--tier", "edit_motion", "--trusted-local-tier",
        "--package", source, "--out", join(root, "must-not-exist"), "--binding-json", JSON.stringify(behavior),
        "--receipts-root", callerReceiptRoot,
      ]);
      expect(rejected).toMatchObject({ ok: false, error: { code: "invalid_args", message: expect.stringContaining("does not accept caller-selected receipts roots") } });
      expect(await readFile(join(source, "motion.json"))).toEqual(before);

      const conflictOut = join(root, "conflict-out");
      const conflictPackageDir = join(root, "conflict-package-dir");
      const conflicted = await runCli([
        "debug", "behaviors-upsert", "--tier", "edit_motion", "--trusted-local-tier",
        "--package", source, "--out", conflictOut, "--package-dir", conflictPackageDir, "--binding-json", JSON.stringify(behavior),
      ]);
      expect(conflicted).toMatchObject({ ok: false, error: { code: "invalid_args", message: expect.stringContaining("requires --out and --package-dir to resolve to the same directory") } });
      await expect(readFile(join(source, "motion.json"))).resolves.toEqual(before);
      await expect(readFile(join(conflictOut, "motion.json"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(join(conflictPackageDir, "motion.json"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await Promise.all(hostReceiptPaths.map(async (path) => await rm(dirname(path), { recursive: true, force: true })));
    }
  });

  it.skipIf(hasAtomicCOWAuthority(UNMANAGED_EXTERNAL_TEST_ROOT))("keeps caller-selected external output roots on the normal refusing topology route", async () => {
    const root = await mkdtemp(join(process.cwd(), ".shellx-motion-cli-cow-"));
    roots.push(root);
    const source = join(root, "source");
    const externalRoot = await mkdtemp(join(UNMANAGED_EXTERNAL_TEST_ROOT, "shellx-motion-cli-external-output-"));
    roots.push(externalRoot);
    await cp(fixture, source, { recursive: true });

    const result = await runCli([
      "debug", "package-patch", "--tier", "edit_motion", "--trusted-local-tier",
      "--package", source, "--out", join(externalRoot, "revision"),
      "--patch-json", '[{"op":"replace","path":"/layers/0/text","value":"Must refuse"}]'
    ]);

    expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining("unrelated POSIX principal") } });
  });

  it.skipIf(!MANAGED_ORDINARY_COW_REFUSAL)("falls back to ordinary topology and refuses only when a selected raw patch file and the checkout route lack full ancestor COW authority", async () => {
    const root = await mkdtemp(join(process.cwd(), ".shellx-motion-cli-external-patch-file-"));
    const externalRoot = await mkdtemp(join(UNMANAGED_EXTERNAL_TEST_ROOT, "shellx-motion-cli-external-patch-input-"));
    roots.push(root, externalRoot);
    const source = join(root, "source");
    const outDir = join(root, "revision");
    const patchFile = join(externalRoot, "patch.json");
    await cp(fixture, source, { recursive: true });
    await writeFile(patchFile, '[{"op":"replace","path":"/layers/0/text","value":"Must refuse"}]', "utf8");

    const result = await runCli([
      "debug", "package-patch", "--tier", "edit_motion", "--trusted-local-tier",
      "--package", source, "--out", outDir, "--patch-file", patchFile,
    ]);

    expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining("unrelated POSIX principal") } });
    await expect(readFile(join(outDir, "motion.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(hasAtomicCOWAuthority(UNMANAGED_EXTERNAL_TEST_ROOT))("refuses an external shape geometry COW without any caller-selected receipts root", async () => {
    const root = await mkdtemp(join(UNMANAGED_EXTERNAL_TEST_ROOT, "shellx-motion-cli-external-geometry-keyframes-"));
    roots.push(root);
    const source = await writeGeometryPackage(join(root, "source"));
    const outDir = join(root, "revision");
    const before = await readFile(join(source, "motion.json"));

    const result = await runCli([
      "debug", "shape-geometry-keyframes-upsert", "--tier", "edit_motion", "--trusted-local-tier",
      "--package", source, "--out", outDir, "--layer", "shape",
      "--snapshot-json", JSON.stringify(shapeSnapshot(0)),
    ]);

    expect(result).toMatchObject({ ok: false, error: { code: "timeline_shape_geometry_keyframes_failed", message: expect.stringContaining("unrelated POSIX principal") } });
    expect(await readFile(join(source, "motion.json"))).toEqual(before);
  });
});

function shapeGeometry(y = 0) {
  return {
    schema: "shellx-motion/shape-geometry@1",
    kind: "line",
    viewBox: { x: 0, y: 0, width: 100, height: 100 },
    points: [{ x: 0, y }, { x: 100, y }],
  };
}

function shapeSnapshot(atUs: number, y = 0) {
  return { atUs, geometry: shapeGeometry(y) };
}

function resultHostReceiptPath(result: Awaited<ReturnType<typeof runCli>>): string {
  if (!result.ok) throw new Error("expected successful shape geometry keyframe CLI COW result");
  const hostReceiptPath = (result.result as { hostReceiptPath?: unknown }).hostReceiptPath;
  if (typeof hostReceiptPath !== "string") throw new Error("expected an internal host receipt path");
  return hostReceiptPath;
}

async function writeGeometryPackage(root: string): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(join(root, "manifest.json"), `${JSON.stringify({
    schema: "shellx-motion/package-manifest@1", id: "pkg-cli-geometry-keyframes", name: "CLI geometry keyframes", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["browser"], hosts: ["motion"] },
  }, null, 2)}\n`);
  await writeFile(join(root, "motion.json"), `${JSON.stringify({
    schema: "shellx-motion/motion@1", id: "motion-cli-geometry-keyframes", name: "CLI geometry keyframes", durationMs: 1_000, fps: 25, width: 100, height: 100, assets: [], provenance: { sourceApp: "test", createdBy: "test" },
    layers: [{ id: "shape", type: "shape", startMs: 0, durationMs: 1_000, geometry: shapeGeometry(), style: { stroke: "#ffffff", strokeWidth: 2, strokeLinejoin: "miter", strokeLinecap: "butt" } }],
  }, null, 2)}\n`);
  return root;
}
