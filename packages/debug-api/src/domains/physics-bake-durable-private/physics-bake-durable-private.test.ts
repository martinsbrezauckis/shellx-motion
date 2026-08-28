import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson } from "@shellx-motion/core";
import { compilePhysicsBakeAdmissionPlan, PHYSICS_BAKE_SCHEMA } from "@shellx-motion/core/internal/scene-recipe";
import { createTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { snapshotPackageEditTree } from "../package-edit-tree-snapshot.js";
import { bakePhysicsWithPinnedRapier, readPhysicsBakeRapierResourceState } from "../physics-bake-rapier-private/physics-bake-rapier-private.js";
import { compilePhysicsBakeDurableArtifact } from "./physics-bake-durable-codec-private.js";
import { decodePhysicsBakeDurableSegments } from "./physics-bake-durable-decode-private.js";
import { createPhysicsBakeDurableReceipt, serializedPhysicsBakeDurableManifest } from "./physics-bake-durable-manifest-private.js";
import { bakePhysicsToDurableArtifact, reopenPhysicsBakeDurableArtifact } from "./physics-bake-durable-private.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))); });

describe("C7B3 durable renderer-neutral physics-bake delivery", () => {
  it("compiles byte-identical portable balls and wall artifacts with pinned fingerprints", async () => {
    for (const [recipe, expected] of [[bingoFixture(), ["afacb71205c6c656ec653fee33521c7ef9f63d1f336c84a5c88124d928871608", "c2a84b1b973e626e5afa3130157d7da52504848aa91ccf95f1d51ca2294c3255"]], [wallFixture(5, 9), ["c09aa2b499d6bca12bfe0691498323ba3e35c7d0e36db1429336d18900abff8c", "3e81a8b3ee2df349f6ff2e78b457eb26aa5f4d0115555624fa318d675dd3793e"]]] as const) {
      const plan = compilePhysicsBakeAdmissionPlan(recipe), provider = await bakePhysicsWithPinnedRapier(plan), prepared = compilePhysicsBakeDurableArtifact(plan, provider), decoded = decodePhysicsBakeDurableSegments(prepared.manifest, new Map(prepared.segments.map((entry) => [entry.descriptor.path, entry.bytes]))), receipt = createPhysicsBakeDurableReceipt(prepared.manifest, serializedPhysicsBakeDurableManifest(prepared.manifest));
      expect([prepared.manifest.fingerprint, receipt.fingerprint]).toEqual(expected);
      expect(prepared.manifest.compression.segmentBytes).toBeLessThan(prepared.manifest.compression.sourceObservationBytes);
      expect(decoded.bodyStateObservations).toEqual(provider.bodyStateObservations);
      expect(decoded.contactObservations).toEqual(provider.contactObservations);
    }
  });

  it("losslessly represents an admitted contact observation with no selected collisions", async () => {
    const plan = compilePhysicsBakeAdmissionPlan(quietContactFixture()), provider = await bakePhysicsWithPinnedRapier(plan), prepared = compilePhysicsBakeDurableArtifact(plan, provider);
    const decoded = decodePhysicsBakeDurableSegments(prepared.manifest, new Map(prepared.segments.map((entry) => [entry.descriptor.path, entry.bytes])));
    expect(provider.contactObservations).toEqual([{ id: "contacts", sampleEverySteps: 4, samples: [] }]);
    expect(prepared.manifest.contactObservations[0]).toMatchObject({ eventCount: 0, sampleCount: 0, segmentPaths: [] });
    expect(decoded.contactObservations).toEqual(provider.contactObservations);
  });

  it.skipIf(process.platform !== "linux")("losslessly publishes and reopens deterministic compact balls artifacts", async () => {
    const fixture = await artifactFixture(), plan = compilePhysicsBakeAdmissionPlan(bingoFixture()), provider = await bakePhysicsWithPinnedRapier(plan);
    const first = await bakePhysicsToDurableArtifact(plan, fixture.host("balls-a")), reopened = await reopenPhysicsBakeDurableArtifact(fixture.reopen("balls-a")), replay = await bakePhysicsToDurableArtifact(structuredClone(plan), fixture.host("balls-b"));
    expect(reopened.bodyStateObservations).toEqual(provider.bodyStateObservations);
    expect(reopened.contactObservations).toEqual(provider.contactObservations);
    expect(first.manifest).toEqual(reopened.manifest);
    expect(replay.manifest).toEqual(first.manifest);
    expect(replay.receipt).toEqual(first.receipt);
    expect(await snapshotPackageEditTree(join(fixture.workspace, "balls-b"))).toEqual(await snapshotPackageEditTree(join(fixture.workspace, "balls-a")));
    expect(first.manifest.compression).toMatchObject({ lossless: true, samplesSimplified: false, valuesQuantized: false });
    expect(first.manifest.compression.segmentBytes).toBeLessThan(first.manifest.compression.sourceObservationBytes);
    expect(first.receipt.publication).toMatchObject({ absentOnly: true, closedInventory: true, atomicDirectoryInstall: true, partialResume: false });
    expect(canonicalJson(first.receipt)).not.toContain(fixture.root);
    expect([first.manifest.fingerprint, first.receipt.fingerprint]).toEqual(["afacb71205c6c656ec653fee33521c7ef9f63d1f336c84a5c88124d928871608", "c2a84b1b973e626e5afa3130157d7da52504848aa91ccf95f1d51ca2294c3255"]);
  });

  it.skipIf(process.platform !== "linux")("chunks the 45-brick bake without splitting samples and preserves all observations", async () => {
    const fixture = await artifactFixture(), plan = compilePhysicsBakeAdmissionPlan(wallFixture(5, 9)), provider = await bakePhysicsWithPinnedRapier(plan), result = await bakePhysicsToDurableArtifact(plan, fixture.host("wall")), reopened = await reopenPhysicsBakeDurableArtifact(fixture.reopen("wall"));
    const bodySegments = result.manifest.segments.filter((entry) => entry.kind === "body-state");
    expect(bodySegments.length).toBeGreaterThan(1);
    expect(bodySegments.every((entry) => entry.stateCount <= result.manifest.compression.caps.bodyStatesPerSegment)).toBe(true);
    expect(reopened.bodyStateObservations).toEqual(provider.bodyStateObservations);
    expect(reopened.contactObservations).toEqual(provider.contactObservations);
    expect(result.manifest.finalStates).toEqual(provider.finalStates);
    expect(result.manifest.compression.segmentBytes).toBeLessThan(result.manifest.compression.sourceObservationBytes);
    expect([result.manifest.fingerprint, result.receipt.fingerprint]).toEqual(["c09aa2b499d6bca12bfe0691498323ba3e35c7d0e36db1429336d18900abff8c", "3e81a8b3ee2df349f6ff2e78b457eb26aa5f4d0115555624fa318d675dd3793e"]);
  });

  it.skipIf(process.platform !== "linux")("refuses wrong authority, occupied output, cancellation and partial or altered artifacts", async () => {
    const fixture = await artifactFixture(), plan = compilePhysicsBakeAdmissionPlan(bingoFixture()), occupied = join(fixture.workspace, "occupied");
    await mkdir(occupied, { mode: 0o700 }); await writeFile(join(occupied, "preserve.txt"), "preserve\n", { mode: 0o600 });
    const beforeOccupied = readPhysicsBakeRapierResourceState();
    await expect(bakePhysicsToDurableArtifact(plan, fixture.host("occupied"))).rejects.toThrow(/absent/i);
    expect(readPhysicsBakeRapierResourceState()).toEqual(beforeOccupied);
    await expect(readFile(join(occupied, "preserve.txt"), "utf8")).resolves.toBe("preserve\n");
    const other = await realpath(await mkdtemp(join(tmpdir(), "shellx-motion-c7b3-wrong-"))); roots.push(other); await chmod(other, 0o700);
    await expect(bakePhysicsToDurableArtifact(plan, { ...fixture.host("wrong"), workspaceAuthority: await createTrustedWorkspaceAnchor(other) })).rejects.toThrow(/anchor|workspace/i);
    const controller = new AbortController(); controller.abort(new Error("test cancellation"));
    await expect(bakePhysicsToDurableArtifact(plan, fixture.host("cancelled"), { signal: controller.signal })).rejects.toThrow("test cancellation");
    await expect(readFile(join(fixture.workspace, "cancelled", "manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });

    const partial = join(fixture.workspace, "partial"); await mkdir(join(partial, "segments"), { recursive: true, mode: 0o700 }); await writeFile(join(partial, "segments", "000000.bin"), Buffer.from("partial"));
    await expect(reopenPhysicsBakeDurableArtifact(fixture.reopen("partial"))).rejects.toThrow(/manifest|artifact/i);
    await bakePhysicsToDurableArtifact(plan, fixture.host("tampered")); const manifest = JSON.parse(await readFile(join(fixture.workspace, "tampered", "manifest.json"), "utf8"));
    await writeFile(join(fixture.workspace, "tampered", manifest.segments[0].path), Buffer.from("changed"));
    await expect(reopenPhysicsBakeDurableArtifact(fixture.reopen("tampered"))).rejects.toThrow(/segment|identity|bytes/i);
    await bakePhysicsToDurableArtifact(plan, fixture.host("extra")); await writeFile(join(fixture.workspace, "extra", "foreign.bin"), "foreign");
    await expect(reopenPhysicsBakeDurableArtifact(fixture.reopen("extra"))).rejects.toThrow(/inventory|extra/i);
    await bakePhysicsToDurableArtifact(plan, fixture.host("receipt")); const receiptPath = join(fixture.workspace, "receipt", "receipt.json"), receipt = JSON.parse(await readFile(receiptPath, "utf8")); receipt.evidence.pixels = true; await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`);
    await expect(reopenPhysicsBakeDurableArtifact(fixture.reopen("receipt"))).rejects.toThrow(/receipt|canonical/i);
    await bakePhysicsToDurableArtifact(plan, fixture.host("symlink")); const segmentPath = join(fixture.workspace, "symlink", "segments", "000000.bin"); await rm(segmentPath); await symlink(join(occupied, "preserve.txt"), segmentPath);
    await expect(reopenPhysicsBakeDurableArtifact(fixture.reopen("symlink"))).rejects.toThrow(/symbolic|unsupported|regular/i);
  });

  it.skipIf(process.platform !== "darwin")("refuses macOS publication before provider work while retaining the portable codec", async () => {
    const fixture = await artifactFixture(), before = readPhysicsBakeRapierResourceState();
    await expect(bakePhysicsToDurableArtifact(compilePhysicsBakeAdmissionPlan(bingoFixture()), fixture.host("mac-refusal"))).rejects.toThrow(/linux descriptor-relative/i);
    expect(readPhysicsBakeRapierResourceState()).toEqual(before);
  });

  it("keeps provider selection, result minting, paths, rendering and public commands outside the artifact contract", async () => {
    const source = await readFile(new URL("./physics-bake-durable-private.ts", import.meta.url), "utf8"), publicIndex = await readFile(new URL("../../index.ts", import.meta.url), "utf8");
    expect(source).toMatch(/bakePhysicsWithPinnedRapier\(plan/u);
    expect(source).not.toMatch(/resultValue|providerResult|renderer-browser|renderer-ffmpeg|motion\.timeline|motion\.physics|dispatchDebugCommand/u);
    expect(publicIndex).not.toMatch(/physics-bake-durable/u);
  });
});

async function artifactFixture(): Promise<{ root: string; workspace: string; host(name: string): { outputRoot: string; workspaceRoot: string; workspaceAuthority: Awaited<ReturnType<typeof createTrustedWorkspaceAnchor>>; requireAbsentOutput: true }; reopen(name: string): { outputRoot: string; workspaceRoot: string; workspaceAuthority: Awaited<ReturnType<typeof createTrustedWorkspaceAnchor>> } }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "shellx-motion-c7b3-"))); roots.push(root); await chmod(root, 0o700); const workspace = join(root, "workspace"); await mkdir(workspace, { mode: 0o700 }); const authority = await createTrustedWorkspaceAnchor(workspace);
  return { root, workspace, host: (name) => ({ outputRoot: join(workspace, name), workspaceRoot: workspace, workspaceAuthority: authority, requireAbsentOutput: true }), reopen: (name) => ({ outputRoot: join(workspace, name), workspaceRoot: workspace, workspaceAuthority: authority }) };
}

function bingoFixture(): any {
  const balls = Array.from({ length: 10 }, (_entry, index) => dynamicBody(`ball-${String(index).padStart(2, "0")}`, [(index % 5 - 2) * 0.55, 0.6 + Math.floor(index / 5) * 0.55, 0]));
  return { schema: PHYSICS_BAKE_SCHEMA, id: "bingo", startUs: 0, endUs: 5_000_000, stepsPerSecond: 120, seed: 42, units: { length: "meter", angle: "radian", time: "second", upAxis: "y", forwardAxis: "-z" }, world: { gravity: [0, -9.81, 0] }, materials: [{ id: "ball", friction: 0.35, restitution: 0.82 }, { id: "wall", friction: 0.5, restitution: 0.55 }], bodies: [...balls, staticBody("wall-back", [0, 2, -2.5], [5, 4, 0.2]), staticBody("wall-floor", [0, 0, 0], [5, 0.2, 5]), staticBody("wall-front", [0, 2, 2.5], [5, 4, 0.2]), staticBody("wall-left", [-2.5, 2, 0], [0.2, 4, 5]), staticBody("wall-right", [2.5, 2, 0], [0.2, 4, 5]), staticBody("wall-top", [0, 4, 0], [5, 0.2, 5])], constraints: [], actions: [{ id: "force", kind: "force", startStep: 120, endStep: 180, bodyId: "ball-00", vector: [2, 0, 0] }, { id: "impulse", kind: "impulse", atStep: 0, bodyId: "ball-01", vector: [0.5, 1, 0] }], events: [{ id: "ball-floor", kind: "collision-pair", bodyA: "ball-00", bodyB: "wall-floor", phases: ["start", "stop"] }], observations: [{ id: "body-states", kind: "body-state", bodyIds: balls.map((entry) => entry.id), sampleEverySteps: 2 }, { id: "contacts", kind: "contact-pairs", eventIds: ["ball-floor"], sampleEverySteps: 4 }] };
}
function quietContactFixture(): any {
  const recipe = bingoFixture();
  return { ...recipe, world: { gravity: [0, 0, 0] }, actions: [], events: [{ id: "never", kind: "collision-pair", bodyA: "ball-00", bodyB: "wall-back", phases: ["start", "stop"] }], observations: [recipe.observations[0], { id: "contacts", kind: "contact-pairs", eventIds: ["never"], sampleEverySteps: 4 }] };
}
function wallFixture(rows: number, columns: number): any {
  const bricks = Array.from({ length: rows }, (_row, row) => Array.from({ length: columns }, (_column, column) => dynamicBody(`brick-r${String(row).padStart(2, "0")}-c${String(column).padStart(2, "0")}`, wallPosition(row, column, columns), "brick", { kind: "box", size: [1, 0.5, 0.5] }))).flat();
  return { schema: PHYSICS_BAKE_SCHEMA, id: "wrecking-wall", startUs: 0, endUs: 5_000_000, stepsPerSecond: 120, seed: 7, units: { length: "meter", angle: "radian", time: "second", upAxis: "y", forwardAxis: "-z" }, world: { gravity: [0, -9.81, 0] }, materials: [{ id: "brick", friction: 0.65, restitution: 0.08 }, { id: "sphere", friction: 0.4, restitution: 0.15 }], bodies: [...bricks, { ...staticBody("ground", [0, 0, 0], [20, 0.2, 8]), materialRef: "brick" }, dynamicBody("sphere", [8, 4, 0], "sphere", { kind: "sphere", radius: 1 }, 80, true)], constraints: [{ id: "tether", kind: "distance", bodyA: "sphere", bodyB: null, anchorA: [0, 0, 0], anchorB: [8, 8, 0], restLength: 4, stiffness: 2_000, damping: 80 }], actions: [{ id: "impact", kind: "impulse", atStep: 30, bodyId: "sphere", vector: [-920, 0, 0] }, { id: "push", kind: "force", startStep: 60, endStep: 90, bodyId: "sphere", vector: [-20, 0, 0] }], events: bricks.map((brick, index) => ({ id: `impact-contact-${String(index).padStart(2, "0")}`, kind: "collision-pair", bodyA: brick.id, bodyB: "sphere", phases: ["start", "stop"] })), observations: [{ id: "body-states", kind: "body-state", bodyIds: [...bricks.map((entry) => entry.id), "sphere"], sampleEverySteps: 2 }, { id: "contacts", kind: "contact-pairs", eventIds: bricks.map((_brick, index) => `impact-contact-${String(index).padStart(2, "0")}`), sampleEverySteps: 2 }] };
}
function wallPosition(row: number, column: number, columns: number): readonly number[] { return [(column - (columns - 1) / 2) * 1.05, 0.3 + row * 0.55, 0]; }
function dynamicBody(id: string, position: readonly number[], materialRef = "ball", collider: any = { kind: "sphere", radius: 0.2 }, mass = 1, ccd = false): any { return { id, kind: "dynamic", collider, materialRef, position, rotation: [0, 0, 0, 1], collisionGroup: 1, collisionMask: 0xffff, mass, linearVelocity: [0, 0, 0], angularVelocity: [0, 0, 0], ccd }; }
function staticBody(id: string, position: readonly number[], size: readonly number[]): any { return { id, kind: "static", collider: { kind: "box", size }, materialRef: "wall", position, rotation: [0, 0, 0, 1], collisionGroup: 1, collisionMask: 0xffff }; }
