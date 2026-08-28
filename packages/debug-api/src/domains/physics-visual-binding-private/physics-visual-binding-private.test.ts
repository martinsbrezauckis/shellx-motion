import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson } from "@shellx-motion/core";
import { compilePhysicsBakeAdmissionPlan, PHYSICS_BAKE_SCHEMA } from "@shellx-motion/core/internal/scene-recipe";
import { createTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { compilePhysicsBakeDurableArtifact } from "../physics-bake-durable-private/physics-bake-durable-codec-private.js";
import { createPhysicsBakeDurableReceipt, serializedPhysicsBakeDurableManifest, serializedPhysicsBakeDurableReceipt } from "../physics-bake-durable-private/physics-bake-durable-manifest-private.js";
import { reopenPhysicsBakeDurableArtifact } from "../physics-bake-durable-private/physics-bake-durable-private.js";
import { bakePhysicsWithPinnedRapier } from "../physics-bake-rapier-private/physics-bake-rapier-private.js";
import { compilePhysicsVisualBindingPlan, evaluatePhysicsVisualBindingFrame, slerpShortest } from "./physics-visual-binding-private.js";
import { PHYSICS_VISUAL_BINDING_SCHEMA } from "./physics-visual-binding-types-private.js";

const roots: string[] = [];
afterEach(async () => await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))));

describe("C7B4A exact physics-artifact visual-frame binding", () => {
  it("binds every dynamic Bingo and 45-brick body through shared data-only visual resources", async () => {
    const fingerprints: string[][] = [];
    for (const recipe of [bingoFixture(), wallFixture(5, 9)]) {
      const fixture = await artifactFixture(recipe), visual = visualRecipe(fixture.plan, recipe.id === "bingo" ? "balls" : "wall", 60), plan = await compilePhysicsVisualBindingPlan(fixture.plan, fixture.host, visual);
      const first = evaluatePhysicsVisualBindingFrame(plan, 0), middle = evaluatePhysicsVisualBindingFrame(plan, plan.schedule.renderFrameCount / 2), terminal = evaluatePhysicsVisualBindingFrame(plan, plan.schedule.terminalFrameIndex);
      const dynamicIds = fixture.plan.recipe.bodies.filter((body) => body.kind === "dynamic").map((body) => body.id);
      expect(plan.bindings.map((entry) => entry.bodyId)).toEqual(dynamicIds);
      expect(plan.budget).toMatchObject({ bindingCount: dynamicIds.length, renderFrameCount: 300, evaluationFrameCount: 301 });
      expect(plan.evidence).toMatchObject({ strictArtifactReopen: true, sharedC7aVisualResourceGrammar: true, visualCollisionGeometryIndependent: true, rendererInvoked: false, pixels: false });
      expect(first.bindings.map((entry) => entry.position)).toEqual(fixture.provider.bodyStateObservations[0]!.samples[0]!.states.map((entry) => entry.position));
      expect(terminal.bindings.map((entry) => ({ bodyId: entry.bodyId, position: entry.position, rotation: entry.rotation }))).toEqual(fixture.provider.finalStates.filter((entry) => dynamicIds.includes(entry.bodyId)).map((entry) => ({ bodyId: entry.bodyId, position: entry.position, rotation: entry.rotation })));
      expect([first.terminal, middle.terminal, terminal.terminal]).toEqual([false, false, true]);
      expect(canonicalJson(plan)).not.toContain(fixture.root);
      fingerprints.push([plan.fingerprint, first.fingerprint, middle.fingerprint, terminal.fingerprint]);
    }
    expect(fingerprints).toEqual([
      [
        "b1abc32f2c85eaf10bcfd3c4b1648f1784fdc973bdb5b84b97282c3394b258f9",
        "95ddeeb310ce9ee0d27e36a47e058d61b01763f640798e65893a2318d8551f3a",
        "15ef6e17a810fedffa35d79578a6a5babb212bfab2bb474d570cf06d26c1168e",
        "2784a3fec392103a35374274067daa0013bea4d01bec4b6401ec0238df681239",
      ],
      [
        "92e8b0aff48bf60a3149dea51570e580c7489875463907b9e88812da67f76437",
        "6f431cdd4f84c167ffe9c756d0081bf688c013bd6038c129deacfa6d1df14ac7",
        "670de2a9ded4acec22d805735a0e0ad5a1267389ca981fba6be7e2e998515ada",
        "24e96c2769cb5915563838fb4879feba4ecac4aaa18f72b0ef97dde65ad8fbfe",
      ],
    ]);
  });

  it("uses exact rational frame/sample coordinates and normalized shortest-arc quaternion interpolation", async () => {
    const recipe = bingoFixture(), fixture = await artifactFixture(recipe), plan = await compilePhysicsVisualBindingPlan(fixture.plan, fixture.host, visualRecipe(fixture.plan, "balls", 50)), frame = evaluatePhysicsVisualBindingFrame(plan, 1);
    expect(frame.time).toEqual({ startUs: 0, offsetNumeratorUs: 1_000_000, denominator: 50 });
    expect(frame.physicsStep).toEqual({ numerator: 120, denominator: 50 });
    expect(frame.sampleRange).toEqual({ leftStep: 2, rightStep: 4, progressNumerator: 20, progressDenominator: 100 });
    expect(frame.bindings.every((entry) => Math.abs(Math.hypot(...entry.rotation) - 1) < 1e-6)).toBe(true);
    expect(slerpShortest([0, 0, 0, 1], [0, 0, 0, -1], 0.5)).toEqual([0, 0, 0, 1]);
  });

  it("lets visual color change identity without changing simulation or transform values", async () => {
    const recipe = bingoFixture(), fixture = await artifactFixture(recipe), firstRecipe = visualRecipe(fixture.plan, "balls", 60), secondRecipe = structuredClone(firstRecipe);
    secondRecipe.resources.materials[0]!.baseColor = "#ffffff";
    const first = await compilePhysicsVisualBindingPlan(fixture.plan, fixture.host, firstRecipe), second = await compilePhysicsVisualBindingPlan(fixture.plan, fixture.host, secondRecipe), firstFrame = evaluatePhysicsVisualBindingFrame(first, 120), secondFrame = evaluatePhysicsVisualBindingFrame(second, 120), reopened = await reopenPhysicsBakeDurableArtifact(fixture.host);
    expect(first.source.durableManifestFingerprint).toBe(reopened.manifest.fingerprint);
    expect(second.source.durableManifestFingerprint).toBe(reopened.manifest.fingerprint);
    expect(first.fingerprint).not.toBe(second.fingerprint);
    expect(firstFrame.fingerprint).not.toBe(secondFrame.fingerprint);
    expect(firstFrame.bindings.map(({ position, rotation }) => ({ position, rotation }))).toEqual(secondFrame.bindings.map(({ position, rotation }) => ({ position, rotation })));
  });

  it("refuses mismatched artifacts, hostile recipes, incomplete bindings and forged plans", async () => {
    const bingo = bingoFixture(), wall = wallFixture(2, 2), bingoFixtureResult = await artifactFixture(bingo), wallFixtureResult = await artifactFixture(wall), valid = visualRecipe(bingoFixtureResult.plan, "balls", 60);
    await expect(compilePhysicsVisualBindingPlan(bingoFixtureResult.plan, wallFixtureResult.host, valid)).rejects.toThrow(/does not match/i);
    await expect(compilePhysicsVisualBindingPlan(bingoFixtureResult.plan, bingoFixtureResult.host, { ...valid, extra: true })).rejects.toThrow(/unknown/i);
    await expect(compilePhysicsVisualBindingPlan(bingoFixtureResult.plan, bingoFixtureResult.host, { ...valid, frameRate: 121 })).rejects.toThrow(/1\.\.120/i);
    await expect(compilePhysicsVisualBindingPlan(bingoFixtureResult.plan, bingoFixtureResult.host, { ...valid, bindings: valid.bindings.slice(1) })).rejects.toThrow(/every dynamic body/i);
    const reordered = { ...valid, bindings: [valid.bindings[1], valid.bindings[0], ...valid.bindings.slice(2)] };
    await expect(compilePhysicsVisualBindingPlan(bingoFixtureResult.plan, bingoFixtureResult.host, reordered)).rejects.toThrow(/body order/i);
    const plan = await compilePhysicsVisualBindingPlan(bingoFixtureResult.plan, bingoFixtureResult.host, valid);
    expect(() => evaluatePhysicsVisualBindingFrame(structuredClone(plan), 0)).toThrow(/compiler-minted/i);
    expect(() => evaluatePhysicsVisualBindingFrame(plan, plan.schedule.terminalFrameIndex + 1)).toThrow(/frame index/i);
  });

  it("keeps provider selection, package mutation, renderers, paths and public commands outside C7B4A", async () => {
    const source = await readFile(new URL("./physics-visual-binding-private.ts", import.meta.url), "utf8"), publicIndex = await readFile(new URL("../../index.ts", import.meta.url), "utf8");
    expect(source).toMatch(/reopenPhysicsBakeDurableArtifact\(artifactHost\)/u);
    expect(source).not.toMatch(/bakePhysicsWithPinnedRapier|PackageEditWorkspace|renderer-browser|renderer-ffmpeg|dispatchDebugCommand|motion\.physics/u);
    expect(publicIndex).not.toMatch(/physics-visual-binding/u);
  });
});

async function artifactFixture(recipe: any): Promise<{ root: string; plan: ReturnType<typeof compilePhysicsBakeAdmissionPlan>; provider: Awaited<ReturnType<typeof bakePhysicsWithPinnedRapier>>; host: { outputRoot: string; workspaceRoot: string; workspaceAuthority: Awaited<ReturnType<typeof createTrustedWorkspaceAnchor>> } }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "shellx-motion-c7b4a-"))); roots.push(root); const workspaceRoot = join(root, "workspace"), outputRoot = join(workspaceRoot, "artifact"); await mkdir(join(outputRoot, "segments"), { recursive: true, mode: 0o700 });
  const plan = compilePhysicsBakeAdmissionPlan(recipe), provider = await bakePhysicsWithPinnedRapier(plan), prepared = compilePhysicsBakeDurableArtifact(plan, provider), manifestBytes = serializedPhysicsBakeDurableManifest(prepared.manifest), receipt = createPhysicsBakeDurableReceipt(prepared.manifest, manifestBytes);
  for (const segment of prepared.segments) await writeFile(join(outputRoot, segment.descriptor.path), segment.bytes, { mode: 0o600 });
  await writeFile(join(outputRoot, "manifest.json"), manifestBytes, { mode: 0o600 }); await writeFile(join(outputRoot, "receipt.json"), serializedPhysicsBakeDurableReceipt(receipt), { mode: 0o600 });
  return { root, plan, provider, host: { outputRoot, workspaceRoot, workspaceAuthority: await createTrustedWorkspaceAnchor(workspaceRoot) } };
}

function visualRecipe(plan: ReturnType<typeof compilePhysicsBakeAdmissionPlan>, kind: "balls" | "wall", frameRate: number): any {
  const dynamicIds = plan.recipe.bodies.filter((body) => body.kind === "dynamic").map((body) => body.id);
  if (kind === "balls") {
    const colors = ["#35a7ff", "#49d17d", "#6d5dfc", "#e84a5f", "#f6c445", "#ff7a45", "#ff5ec4", "#70d6ff", "#9ee493", "#ffffff"];
    return { schema: PHYSICS_VISUAL_BINDING_SCHEMA, physicsPlanFingerprint: plan.fingerprint, frameRate, interpolation: { position: "linear", rotation: "slerp-shortest" }, resources: { geometry: [{ id: "ball", kind: "sphere", radius: 0.2, quality: "cinematic" }], materials: colors.map((baseColor, index) => ({ id: `color-${String(index).padStart(2, "0")}`, kind: "basic", baseColor, emissive: 0.08 })) }, bindings: dynamicIds.map((bodyId, index) => ({ bodyId, geometryRef: "ball", materialRef: `color-${String(index).padStart(2, "0")}` })) };
  }
  return { schema: PHYSICS_VISUAL_BINDING_SCHEMA, physicsPlanFingerprint: plan.fingerprint, frameRate, interpolation: { position: "linear", rotation: "slerp-shortest" }, resources: { geometry: [{ id: "brick", kind: "box", size: [1, 0.5, 0.5] }, { id: "sphere", kind: "sphere", radius: 1, quality: "cinematic" }], materials: [{ id: "brick-a", kind: "basic", baseColor: "#d65a3a", emissive: 0 }, { id: "brick-b", kind: "basic", baseColor: "#f0b35b", emissive: 0 }, { id: "sphere", kind: "basic", baseColor: "#27364d", emissive: 0.04 }] }, bindings: dynamicIds.map((bodyId, index) => ({ bodyId, geometryRef: bodyId === "sphere" ? "sphere" : "brick", materialRef: bodyId === "sphere" ? "sphere" : index % 2 === 0 ? "brick-a" : "brick-b" })) };
}

function bingoFixture(): any {
  const balls = Array.from({ length: 10 }, (_entry, index) => dynamicBody(`ball-${String(index).padStart(2, "0")}`, [(index % 5 - 2) * 0.55, 0.6 + Math.floor(index / 5) * 0.55, 0]));
  return { schema: PHYSICS_BAKE_SCHEMA, id: "bingo", startUs: 0, endUs: 5_000_000, stepsPerSecond: 120, seed: 42, units: { length: "meter", angle: "radian", time: "second", upAxis: "y", forwardAxis: "-z" }, world: { gravity: [0, -9.81, 0] }, materials: [{ id: "ball", friction: 0.35, restitution: 0.82 }, { id: "wall", friction: 0.5, restitution: 0.55 }], bodies: [...balls, staticBody("wall-back", [0, 2, -2.5], [5, 4, 0.2]), staticBody("wall-floor", [0, 0, 0], [5, 0.2, 5]), staticBody("wall-front", [0, 2, 2.5], [5, 4, 0.2]), staticBody("wall-left", [-2.5, 2, 0], [0.2, 4, 5]), staticBody("wall-right", [2.5, 2, 0], [0.2, 4, 5]), staticBody("wall-top", [0, 4, 0], [5, 0.2, 5])], constraints: [], actions: [{ id: "force", kind: "force", startStep: 120, endStep: 180, bodyId: "ball-00", vector: [2, 0, 0] }, { id: "impulse", kind: "impulse", atStep: 0, bodyId: "ball-01", vector: [0.5, 1, 0] }], events: [{ id: "ball-floor", kind: "collision-pair", bodyA: "ball-00", bodyB: "wall-floor", phases: ["start", "stop"] }], observations: [{ id: "body-states", kind: "body-state", bodyIds: balls.map((entry) => entry.id), sampleEverySteps: 2 }, { id: "contacts", kind: "contact-pairs", eventIds: ["ball-floor"], sampleEverySteps: 4 }] };
}
function wallFixture(rows: number, columns: number): any {
  const bricks = Array.from({ length: rows }, (_row, row) => Array.from({ length: columns }, (_column, column) => dynamicBody(`brick-r${String(row).padStart(2, "0")}-c${String(column).padStart(2, "0")}`, [(column - (columns - 1) / 2) * 1.05, 0.3 + row * 0.55, 0], "brick", { kind: "box", size: [1, 0.5, 0.5] }))).flat();
  return { schema: PHYSICS_BAKE_SCHEMA, id: "wrecking-wall", startUs: 0, endUs: 5_000_000, stepsPerSecond: 120, seed: 7, units: { length: "meter", angle: "radian", time: "second", upAxis: "y", forwardAxis: "-z" }, world: { gravity: [0, -9.81, 0] }, materials: [{ id: "brick", friction: 0.65, restitution: 0.08 }, { id: "sphere", friction: 0.4, restitution: 0.15 }], bodies: [...bricks, { ...staticBody("ground", [0, 0, 0], [20, 0.2, 8]), materialRef: "brick" }, dynamicBody("sphere", [8, 4, 0], "sphere", { kind: "sphere", radius: 1 }, 80, true)], constraints: [{ id: "tether", kind: "distance", bodyA: "sphere", bodyB: null, anchorA: [0, 0, 0], anchorB: [8, 8, 0], restLength: 4, stiffness: 2_000, damping: 80 }], actions: [{ id: "impact", kind: "impulse", atStep: 30, bodyId: "sphere", vector: [-920, 0, 0] }, { id: "push", kind: "force", startStep: 60, endStep: 90, bodyId: "sphere", vector: [-20, 0, 0] }], events: bricks.map((brick, index) => ({ id: `impact-contact-${String(index).padStart(2, "0")}`, kind: "collision-pair", bodyA: brick.id, bodyB: "sphere", phases: ["start", "stop"] })), observations: [{ id: "body-states", kind: "body-state", bodyIds: [...bricks.map((entry) => entry.id), "sphere"], sampleEverySteps: 2 }, { id: "contacts", kind: "contact-pairs", eventIds: bricks.map((_brick, index) => `impact-contact-${String(index).padStart(2, "0")}`), sampleEverySteps: 2 }] };
}
function dynamicBody(id: string, position: readonly number[], materialRef = "ball", collider: any = { kind: "sphere", radius: 0.2 }, mass = 1, ccd = false): any { return { id, kind: "dynamic", collider, materialRef, position, rotation: [0, 0, 0, 1], collisionGroup: 1, collisionMask: 0xffff, mass, linearVelocity: [0, 0, 0], angularVelocity: [0, 0, 0], ccd }; }
function staticBody(id: string, position: readonly number[], size: readonly number[]): any { return { id, kind: "static", collider: { kind: "box", size }, materialRef: "wall", position, rotation: [0, 0, 0, 1], collisionGroup: 1, collisionMask: 0xffff }; }
