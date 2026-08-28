/** Private C7B4B retained analytic-mesh lowering over exact C7B4A frames. */
import { canonicalJson, canonicalJsonSha256 } from "@shellx-motion/core";
import {
  compileRetainedMeshGeometry,
  compileSceneRecipeResources,
  retainedMeshColor,
  retainedMeshFloatBytes,
  retainedMeshIndexBytes,
  retainedMeshModelMatrixFromQuaternion,
  retainedMeshViewProjection,
  snapshotSceneRecipeData,
} from "@shellx-motion/core/internal/scene-recipe";
import { evaluatePhysicsVisualBindingFrame } from "../physics-visual-binding-private/physics-visual-binding-private.js";
import { requirePhysicsVisualBindingPlan } from "../physics-visual-binding-private/physics-visual-binding-authority-private.js";
import { mintPhysicsVisualRetainedFramePlan, mintPhysicsVisualRetainedStaticPlan, requirePhysicsVisualRetainedFramePlan, requirePhysicsVisualRetainedStaticPlan } from "./physics-visual-retained-authority-private.js";
import {
  PHYSICS_VISUAL_RETAINED_CAPS,
  PHYSICS_VISUAL_RETAINED_FRAME_SCHEMA,
  PHYSICS_VISUAL_RETAINED_SCHEMA,
  PHYSICS_VISUAL_RETAINED_STATIC_SCHEMA,
  type PhysicsVisualRetainedFramePlan,
  type PhysicsVisualRetainedFrameUpload,
  type PhysicsVisualRetainedRecipe,
  type PhysicsVisualRetainedStaticPlan,
  type PhysicsVisualRetainedStaticUpload,
} from "./physics-visual-retained-types-private.js";

export function compilePhysicsVisualRetainedStaticPlan(visualValue: unknown, recipeValue: unknown): PhysicsVisualRetainedStaticPlan {
  const { plan: visual } = requirePhysicsVisualBindingPlan(visualValue), recipe = readRecipe(recipeValue, visual.fingerprint);
  const resources = compileSceneRecipeResources(visual.recipe.resources), geometries = frozen(resources.geometry.map(compileRetainedMeshGeometry));
  const instanceSlots = frozen(visual.bindings.map((binding) => frozen({ instanceId: binding.bodyId, primitiveRef: binding.geometryRef, materialRef: binding.materialRef })));
  const vertexBufferBytes = geometries.reduce((sum, item) => sum + item.vertexBufferBytes, 0), indexBufferBytes = geometries.reduce((sum, item) => sum + item.indexBufferBytes, 0), uniformBufferBytes = instanceSlots.length * 256;
  const renderTargetBytes = recipe.viewport.width * recipe.viewport.height * 4, depthTargetBytes = renderTargetBytes, readbackBufferBytes = Math.ceil((recipe.viewport.width * 4) / 256) * 256 * recipe.viewport.height;
  const baseBudget = { geometryResourceCount: geometries.length, materialResourceCount: resources.materials.length, instanceSlotCount: instanceSlots.length, reusedInstanceCount: instanceSlots.length - new Set(instanceSlots.map((slot) => slot.primitiveRef)).size, vertexBufferBytes, indexBufferBytes, uniformBufferBytes, renderTargetBytes, depthTargetBytes, readbackBufferBytes, retainedGpuBytes: vertexBufferBytes + indexBufferBytes + uniformBufferBytes + renderTargetBytes + depthTargetBytes + readbackBufferBytes, caps: PHYSICS_VISUAL_RETAINED_CAPS };
  enforceBudget(baseBudget);
  const source = frozen({ visualBindingFingerprint: visual.fingerprint, physicsPlanFingerprint: visual.source.physicsPlanFingerprint, durableManifestFingerprint: visual.source.durableManifestFingerprint, visualResourceFingerprint: visual.resourceFingerprint, compiledResourceFingerprint: resources.fingerprint });
  const presentation = frozen({ background: retainedMeshColor(recipe.backgroundColor), viewProjection: retainedMeshViewProjection(recipe.camera, recipe.viewport), lighting: frozen({ direction: recipe.lighting.direction, color: retainedMeshColor(recipe.lighting.color), ambient: recipe.lighting.ambient, intensity: recipe.lighting.intensity }) });
  const base = { schema: PHYSICS_VISUAL_RETAINED_STATIC_SCHEMA, recipe, recipeSha256: canonicalJsonSha256(recipe), source, geometries, instanceSlots, presentation, evidence: frozen({ exactC7b4aFramesOnly: true as const, sharedC7aGeometryCompiler: true as const, sharedRetainedIndexedMeshKernel: true as const, stableInstanceUniformSlots: true as const, perFrameGpuAllocations: 0 as const, explicitTerminalReleaseRequired: true as const, rendererInvoked: false as const, pixels: false as const, packageRead: false as const, packageWritten: false as const, video: false as const }) };
  let staticPlanBytes = 0;
  for (let attempt = 0; attempt < 4; attempt += 1) { const next = Buffer.byteLength(canonicalJson({ ...base, budget: { ...baseBudget, staticPlanBytes } }), "utf8"); if (next === staticPlanBytes) break; staticPlanBytes = next; }
  if (staticPlanBytes > PHYSICS_VISUAL_RETAINED_CAPS.staticPlanBytes) throw new Error(`C7B4B exceeds the ${PHYSICS_VISUAL_RETAINED_CAPS.staticPlanBytes}-byte static-plan cap.`);
  const payload = { ...base, budget: frozen({ ...baseBudget, staticPlanBytes }) }, plan = frozen({ ...payload, fingerprint: canonicalJsonSha256(payload) }) as PhysicsVisualRetainedStaticPlan;
  mintPhysicsVisualRetainedStaticPlan(plan, visual);
  return plan;
}

export function compilePhysicsVisualRetainedFramePlan(staticValue: unknown, frameIndex: unknown): PhysicsVisualRetainedFramePlan {
  const { plan, visual } = requirePhysicsVisualRetainedStaticPlan(staticValue), sourceFrame = evaluatePhysicsVisualBindingFrame(visual, frameIndex), materials = new Map(visual.recipe.resources.materials.map((entry) => [entry.id, entry]));
  const bindings = frozen(sourceFrame.bindings.map((binding, index) => {
    const slot = plan.instanceSlots[index]!, material = materials.get(slot.materialRef);
    if (!slot || slot.instanceId !== binding.bodyId || slot.primitiveRef !== binding.geometryRef || !material) throw new Error("C7B4B frame topology or material identity changed after static compilation.");
    return frozen({ instanceId: binding.bodyId, primitiveRef: binding.geometryRef, modelMatrix: retainedMeshModelMatrixFromQuaternion(binding.position, binding.rotation), color: retainedMeshColor(material.baseColor), emissive: material.emissive });
  }));
  const base = { schema: PHYSICS_VISUAL_RETAINED_FRAME_SCHEMA, staticFingerprint: plan.fingerprint, visualBindingFingerprint: visual.fingerprint, sourceFrameFingerprint: sourceFrame.fingerprint, frameIndex: sourceFrame.frameIndex, terminal: sourceFrame.terminal, time: sourceFrame.time, viewport: plan.recipe.viewport, background: plan.presentation.background, viewProjection: plan.presentation.viewProjection, lighting: plan.presentation.lighting, bindings, evidence: frozen({ rendererInvoked: false as const, pixels: false as const, perFrameGpuAllocations: 0 as const }) };
  const frame = frozen({ ...base, fingerprint: canonicalJsonSha256(base) }) as PhysicsVisualRetainedFramePlan;
  if (Buffer.byteLength(canonicalJson(frame), "utf8") > PHYSICS_VISUAL_RETAINED_CAPS.framePlanBytes) throw new Error(`C7B4B exceeds the ${PHYSICS_VISUAL_RETAINED_CAPS.framePlanBytes}-byte frame-plan cap.`);
  mintPhysicsVisualRetainedFramePlan(frame, plan);
  return frame;
}

export function readPhysicsVisualRetainedStaticUpload(value: unknown): PhysicsVisualRetainedStaticUpload {
  const { plan } = requirePhysicsVisualRetainedStaticPlan(value);
  return frozen({ schema: "shellx-motion/private-gltf-object-retained-render-static-upload@1", staticFingerprint: plan.fingerprint, width: plan.recipe.viewport.width, height: plan.recipe.viewport.height, geometries: plan.geometries.map((item) => frozen({ id: item.id, vertexCount: item.vertexCount, indexCount: item.indexCount, vertexBufferSha256: item.vertexBufferSha256, indexBufferSha256: item.indexBufferSha256, vertexBufferBytes: item.vertexBufferBytes, indexBufferBytes: item.indexBufferBytes, verticesBase64: retainedMeshFloatBytes(item.vertices).toString("base64"), indicesBase64: retainedMeshIndexBytes(item.indices).toString("base64") })), instanceSlots: plan.instanceSlots.map((slot) => frozen({ instanceId: slot.instanceId, primitiveRef: slot.primitiveRef })), budget: plan.budget });
}

export function readPhysicsVisualRetainedFrameUpload(staticValue: unknown, frameValue: unknown): PhysicsVisualRetainedFrameUpload {
  const { plan } = requirePhysicsVisualRetainedStaticPlan(staticValue), frame = requirePhysicsVisualRetainedFramePlan(frameValue, plan);
  const atUs = frame.time.startUs + frame.time.offsetNumeratorUs / frame.time.denominator;
  return frozen({ schema: "shellx-motion/private-gltf-object-retained-render-frame-upload@1", staticFingerprint: plan.fingerprint, evaluationFingerprint: frame.visualBindingFingerprint, sourceFrameFingerprint: frame.sourceFrameFingerprint, atUs, viewport: frame.viewport, background: frame.background, viewProjection: frame.viewProjection, lighting: frame.lighting, bindings: frame.bindings, fingerprint: frame.fingerprint });
}

function readRecipe(value: unknown, fingerprint: string): PhysicsVisualRetainedRecipe {
  const root = exact(snapshotSceneRecipeData(value), ["schema", "visualBindingFingerprint", "viewport", "backgroundColor", "camera", "lighting"], "C7B4B recipe");
  if (root.schema !== PHYSICS_VISUAL_RETAINED_SCHEMA || root.visualBindingFingerprint !== fingerprint) throw new Error("C7B4B recipe schema or visual-binding identity is invalid.");
  const viewport = exact(root.viewport, ["width", "height"], "C7B4B viewport"), camera = exact(root.camera, ["position", "target", "fovDeg", "near", "far"], "C7B4B camera"), lighting = exact(root.lighting, ["direction", "color", "ambient", "intensity"], "C7B4B lighting");
  const position = vec3(camera.position, "C7B4B camera.position", -10_000, 10_000), target = vec3(camera.target, "C7B4B camera.target", -10_000, 10_000), direction = vec3(lighting.direction, "C7B4B lighting.direction", -1, 1), near = finite(camera.near, "C7B4B camera.near", 0.001, 1_000), far = finite(camera.far, "C7B4B camera.far", 0.002, 100_000);
  if (near >= far || Math.hypot(position[0] - target[0], position[1] - target[1], position[2] - target[2]) < 1e-6 || Math.hypot(direction[0], direction[1], direction[2]) < 1e-6) throw new Error("C7B4B camera and lighting vectors must be non-degenerate and near must precede far.");
  const forward = [position[0] - target[0], position[1] - target[1], position[2] - target[2]]; if (Math.hypot(forward[0]!, forward[2]!) < 1e-6) throw new Error("C7B4B camera view cannot be parallel to the fixed y-up axis.");
  return frozen({ schema: PHYSICS_VISUAL_RETAINED_SCHEMA, visualBindingFingerprint: fingerprint, viewport: frozen({ width: integer(viewport.width, "C7B4B viewport.width", 1, PHYSICS_VISUAL_RETAINED_CAPS.width), height: integer(viewport.height, "C7B4B viewport.height", 1, PHYSICS_VISUAL_RETAINED_CAPS.height) }), backgroundColor: color(root.backgroundColor, "C7B4B backgroundColor"), camera: frozen({ position, target, fovDeg: finite(camera.fovDeg, "C7B4B camera.fovDeg", 1, 179), near, far }), lighting: frozen({ direction, color: color(lighting.color, "C7B4B lighting.color"), ambient: finite(lighting.ambient, "C7B4B lighting.ambient", 0, 1), intensity: finite(lighting.intensity, "C7B4B lighting.intensity", 0, 4) }) });
}

function enforceBudget(value: { geometryResourceCount: number; instanceSlotCount: number; vertexBufferBytes: number; indexBufferBytes: number; retainedGpuBytes: number }): void { if (value.geometryResourceCount > PHYSICS_VISUAL_RETAINED_CAPS.geometryResources || value.instanceSlotCount > PHYSICS_VISUAL_RETAINED_CAPS.instanceSlots || value.vertexBufferBytes > PHYSICS_VISUAL_RETAINED_CAPS.vertexBytes || value.indexBufferBytes > PHYSICS_VISUAL_RETAINED_CAPS.indexBytes || value.retainedGpuBytes > PHYSICS_VISUAL_RETAINED_CAPS.retainedGpuBytes) throw new Error("C7B4B retained resource budget exceeds its fixed caps."); }
function exact(value: unknown, keys: readonly string[], label: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`${label} must be a plain object.`); const root = value as Record<string, unknown>, actual = Reflect.ownKeys(root); if (actual.length !== keys.length || actual.some((key) => typeof key !== "string" || !keys.includes(key)) || keys.some((key) => !Object.hasOwn(root, key))) throw new Error(`${label} has missing or unknown fields.`); return root; }
function finite(value: unknown, label: string, minimum: number, maximum: number): number { if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`${label} must be finite in ${minimum}..${maximum}.`); return Object.is(Math.fround(value), -0) ? 0 : Math.fround(value); }
function integer(value: unknown, label: string, minimum: number, maximum: number): number { if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new Error(`${label} must be a safe integer in ${minimum}..${maximum}.`); return value as number; }
function vec3(value: unknown, label: string, minimum: number, maximum: number): readonly [number, number, number] { if (!Array.isArray(value) || value.length !== 3) throw new Error(`${label} must be a three-number tuple.`); return frozen(value.map((entry, index) => finite(entry, `${label}[${index}]`, minimum, maximum)) as unknown as [number, number, number]); }
function color(value: unknown, label: string): string { if (typeof value !== "string" || !/^#[a-fA-F0-9]{6}$/u.test(value)) throw new Error(`${label} must be #RRGGBB.`); return value.toLowerCase(); }
function frozen<T extends object>(value: T): Readonly<T> { return Object.freeze(value); }
