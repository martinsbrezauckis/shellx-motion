import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { compilePhysicsBakeDurableArtifact } from "../physics-bake-durable-private/physics-bake-durable-codec-private.js";
import { createPhysicsBakeDurableReceipt, serializedPhysicsBakeDurableManifest, serializedPhysicsBakeDurableReceipt } from "../physics-bake-durable-private/physics-bake-durable-manifest-private.js";
import { bakePhysicsWithPinnedRapier } from "../physics-bake-rapier-private/physics-bake-rapier-private.js";
import { compilePhysicsVisualBindingPlan } from "../physics-visual-binding-private/physics-visual-binding-private.js";
import {
  compilePhysicsShowcaseScenario,
  createPhysicsShowcaseRetainedRenderRecipe,
  createPhysicsShowcaseScenario,
  createPhysicsShowcaseVisualBindingRecipe,
} from "../physics-showcase-scenario-private/unadopted/physics-showcase-scenario-private.js";

export async function physicsVisualFixture(kind: "bingo" | "wall", frameRate = 60, options: Readonly<{ firstDynamicId?: string }> = {}) {
  const scenario = createPhysicsShowcaseScenario(kind === "bingo" ? "bingo" : "wrecking-wall");
  (scenario.presentation as { frameRate: number }).frameRate = frameRate;
  if (kind === "bingo" && options.firstDynamicId) scenario.ids = { ballPrefix: "d-ball", firstBallId: options.firstDynamicId };
  const compilation = compilePhysicsShowcaseScenario(scenario), recipe = compilation.physicsRecipe, root = await realpath(await mkdtemp(join(tmpdir(), "shellx-motion-c7b4b-"))), workspaceRoot = join(root, "workspace"), outputRoot = join(workspaceRoot, "artifact");
  await mkdir(join(outputRoot, "segments"), { recursive: true, mode: 0o700 });
  const physicsPlan = compilation.physicsPlan, provider = await bakePhysicsWithPinnedRapier(physicsPlan), prepared = compilePhysicsBakeDurableArtifact(physicsPlan, provider), manifestBytes = serializedPhysicsBakeDurableManifest(prepared.manifest), receipt = createPhysicsBakeDurableReceipt(prepared.manifest, manifestBytes);
  for (const segment of prepared.segments) await writeFile(join(outputRoot, segment.descriptor.path), segment.bytes, { mode: 0o600 });
  await writeFile(join(outputRoot, "manifest.json"), manifestBytes, { mode: 0o600 }); await writeFile(join(outputRoot, "receipt.json"), serializedPhysicsBakeDurableReceipt(receipt), { mode: 0o600 });
  const host = { outputRoot, workspaceRoot, workspaceAuthority: await createTrustedWorkspaceAnchor(workspaceRoot) }, visualPlan = await compilePhysicsVisualBindingPlan(physicsPlan, host, createPhysicsShowcaseVisualBindingRecipe(compilation, physicsPlan));
  return { root, scenario, compilation, recipe, physicsPlan, provider, host, visualPlan };
}

export function retainedRecipe(visualBindingFingerprint: string, kind: "bingo" | "wall"): any {
  return createPhysicsShowcaseRetainedRenderRecipe(compilePhysicsShowcaseScenario(createPhysicsShowcaseScenario(kind === "bingo" ? "bingo" : "wrecking-wall")), visualBindingFingerprint) as any;
}
