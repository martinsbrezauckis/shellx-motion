/** Private C7B4C data-only static-collision, constraint-display and fixed-presentation lowering. */
import { canonicalJson, canonicalJsonSha256 } from "@shellx-motion/core";
import {
  compileRetainedMeshGeometry,
  compileSceneRecipeResources,
  readPhysicsBakeAdmissionPlan,
  readSceneRecipeResources,
  retainedMeshColor,
  retainedMeshFloatBytes,
  retainedMeshIndexBytes,
  retainedMeshModelMatrixFromQuaternion,
  retainedMeshModelMatrixFromQuaternionScale,
  snapshotSceneRecipeData,
  type PhysicsBakeAdmissionPlan,
  type PhysicsBakeBody,
  type PhysicsBakeQuaternion,
  type PhysicsBakeVec3,
  type SceneRecipe,
} from "@shellx-motion/core/internal/scene-recipe";
import { evaluatePhysicsVisualBindingFrame } from "../physics-visual-binding-private/physics-visual-binding-private.js";
import { compilePhysicsVisualRetainedFramePlan } from "../physics-visual-retained-private/physics-visual-retained-private.js";
import { requirePhysicsVisualRetainedStaticPlan } from "../physics-visual-retained-private/physics-visual-retained-authority-private.js";
import type { PhysicsVisualRetainedStaticPlan } from "../physics-visual-retained-private/physics-visual-retained-types-private.js";
import {
  mintPhysicsVisualPresentationFramePlan,
  mintPhysicsVisualPresentationStaticPlan,
  requirePhysicsVisualPresentationFramePlan,
  requirePhysicsVisualPresentationStaticPlan,
} from "./physics-visual-presentation-authority-private.js";
import {
  PHYSICS_VISUAL_PRESENTATION_CAPS,
  PHYSICS_VISUAL_PRESENTATION_FRAME_SCHEMA,
  PHYSICS_VISUAL_PRESENTATION_SCHEMA,
  PHYSICS_VISUAL_PRESENTATION_STATIC_SCHEMA,
  type PhysicsVisualPresentationConstraintBinding,
  type PhysicsVisualPresentationFixedBinding,
  type PhysicsVisualPresentationFramePlan,
  type PhysicsVisualPresentationFrameUpload,
  type PhysicsVisualPresentationRecipe,
  type PhysicsVisualPresentationStaticCollisionBinding,
  type PhysicsVisualPresentationStaticPlan,
  type PhysicsVisualPresentationStaticUpload,
} from "./physics-visual-presentation-types-private.js";

export function compilePhysicsVisualPresentationStaticPlan(retainedValue: unknown, physicsValue: unknown, recipeValue: unknown): PhysicsVisualPresentationStaticPlan {
  const { plan: retained, visual } = requirePhysicsVisualRetainedStaticPlan(retainedValue), physics = readPhysicsBakeAdmissionPlan(physicsValue);
  if (physics.fingerprint !== retained.source.physicsPlanFingerprint || physics.fingerprint !== visual.source.physicsPlanFingerprint || physics.recipeSha256 !== visual.source.physicsRecipeSha256) throw new Error("C7B4C physics-plan identity does not match the retained visual source chain.");
  const { recipe, combinedResources } = readRecipe(recipeValue, retained, physics, visual.recipe.resources), compiledResources = compileSceneRecipeResources(combinedResources), geometries = frozen(compiledResources.geometry.map(compileRetainedMeshGeometry));
  if (geometries.slice(0, retained.geometries.length).some((geometry, index) => canonicalJson(geometry) !== canonicalJson(retained.geometries[index]))) throw new Error("C7B4C combined geometry changed an accepted C7B4B retained resource.");
  const dynamicSlots = retained.instanceSlots.map((slot) => frozen({ instanceId: slot.instanceId, primitiveRef: slot.primitiveRef, materialRef: slot.materialRef, kind: "dynamic" as const, sourceId: slot.instanceId }));
  const staticSlots = recipe.staticCollisionBindings.map((binding) => frozen({ instanceId: instanceId("static", binding.bodyId), primitiveRef: binding.geometryRef, materialRef: binding.materialRef, kind: "static-collision" as const, sourceId: binding.bodyId }));
  const constraintSlots = recipe.constraintBindings.map((binding) => frozen({ instanceId: instanceId("constraint", binding.constraintId), primitiveRef: binding.geometryRef, materialRef: binding.materialRef, kind: "constraint-display" as const, sourceId: binding.constraintId }));
  const presentationSlots = recipe.presentationBindings.map((binding) => binding.opacity < 1
    ? frozen({ instanceId: instanceId("fixed", binding.id), primitiveRef: binding.geometryRef, materialRef: binding.materialRef, kind: "presentation" as const, sourceId: binding.id, renderMode: "alpha" as const })
    : frozen({ instanceId: instanceId("fixed", binding.id), primitiveRef: binding.geometryRef, materialRef: binding.materialRef, kind: "presentation" as const, sourceId: binding.id }));
  const instanceSlots = frozen([...dynamicSlots, ...staticSlots, ...constraintSlots, ...presentationSlots]);
  if (new Set(instanceSlots.map((slot) => slot.instanceId)).size !== instanceSlots.length) throw new Error("C7B4C generated instance-slot identities collide with retained or presentation slots.");
  const vertexBufferBytes = geometries.reduce((sum, item) => sum + item.vertexBufferBytes, 0), indexBufferBytes = geometries.reduce((sum, item) => sum + item.indexBufferBytes, 0), uniformBufferBytes = instanceSlots.length * 256;
  const renderTargetBytes = retained.budget.renderTargetBytes, depthTargetBytes = retained.budget.depthTargetBytes, readbackBufferBytes = retained.budget.readbackBufferBytes;
  const baseBudget = {
    geometryResourceCount: geometries.length,
    materialResourceCount: compiledResources.materials.length,
    instanceSlotCount: instanceSlots.length,
    staticCollisionBindingCount: staticSlots.length,
    constraintBindingCount: constraintSlots.length,
    presentationBindingCount: presentationSlots.length,
    transparentPresentationCount: recipe.presentationBindings.filter((binding) => binding.opacity < 1).length,
    reusedInstanceCount: instanceSlots.length - new Set(instanceSlots.map((slot) => slot.primitiveRef)).size,
    vertexBufferBytes,
    indexBufferBytes,
    uniformBufferBytes,
    renderTargetBytes,
    depthTargetBytes,
    readbackBufferBytes,
    retainedGpuBytes: vertexBufferBytes + indexBufferBytes + uniformBufferBytes + renderTargetBytes + depthTargetBytes + readbackBufferBytes,
    caps: PHYSICS_VISUAL_PRESENTATION_CAPS,
  };
  enforceBudget(baseBudget);
  const source = frozen({ retainedStaticFingerprint: retained.fingerprint, visualBindingFingerprint: visual.fingerprint, physicsPlanFingerprint: physics.fingerprint, physicsRecipeSha256: physics.recipeSha256, retainedResourceFingerprint: retained.source.compiledResourceFingerprint });
  const bindingFingerprint = canonicalJsonSha256({ staticCollisionBindings: recipe.staticCollisionBindings, constraintBindings: recipe.constraintBindings, presentationBindings: recipe.presentationBindings, instanceSlots });
  const evidence = frozen({ exactC7b4bDynamicFrames: true as const, exactRevalidatedC7b1Physics: true as const, explicitStaticCollisionVisuals: true as const, constraintDisplaysArePresentationOnly: true as const, fixedPresentationsAffectNoPhysics: true as const, singleFinalAlphaSlot: true as const, stableInstanceUniformSlots: true as const, perFrameGpuAllocations: 0 as const, rendererInvoked: false as const, pixels: false as const, packageRead: false as const, packageWritten: false as const, video: false as const });
  const base = { schema: PHYSICS_VISUAL_PRESENTATION_STATIC_SCHEMA, recipe, recipeSha256: canonicalJsonSha256(recipe), source, resourceFingerprint: compiledResources.fingerprint, bindingFingerprint, geometries, materials: compiledResources.materials, instanceSlots, presentation: retained.presentation, evidence };
  let staticPlanBytes = 0;
  for (let attempt = 0; attempt < 4; attempt += 1) { const next = Buffer.byteLength(canonicalJson({ ...base, budget: { ...baseBudget, staticPlanBytes } }), "utf8"); if (next === staticPlanBytes) break; staticPlanBytes = next; }
  if (staticPlanBytes > PHYSICS_VISUAL_PRESENTATION_CAPS.staticPlanBytes) throw new Error(`C7B4C exceeds the ${PHYSICS_VISUAL_PRESENTATION_CAPS.staticPlanBytes}-byte static-plan cap.`);
  const payload = { ...base, budget: frozen({ ...baseBudget, staticPlanBytes }) }, plan = frozen({ ...payload, fingerprint: canonicalJsonSha256(payload) }) as PhysicsVisualPresentationStaticPlan;
  mintPhysicsVisualPresentationStaticPlan(plan, retained, physics);
  return plan;
}

export function compilePhysicsVisualPresentationFramePlan(staticValue: unknown, frameIndex: unknown): PhysicsVisualPresentationFramePlan {
  const { plan, retained, physics } = requirePhysicsVisualPresentationStaticPlan(staticValue), { visual } = requirePhysicsVisualRetainedStaticPlan(retained);
  const retainedFrame = compilePhysicsVisualRetainedFramePlan(retained, frameIndex), physicsFrame = evaluatePhysicsVisualBindingFrame(visual, frameIndex);
  if (retainedFrame.sourceFrameFingerprint !== physicsFrame.fingerprint) throw new Error("C7B4C retained and physics frame identities diverged.");
  const materialById = new Map(plan.materials.map((entry) => [entry.id, entry])), bodyById = new Map(physics.recipe.bodies.map((entry) => [entry.id, entry])), dynamicPoseById = new Map(physicsFrame.bindings.map((entry) => [entry.bodyId, entry]));
  const bindings = [...retainedFrame.bindings], constraintSegments: Array<{ constraintId: string; start: readonly [number, number, number]; end: readonly [number, number, number]; length: number }> = [];
  for (const binding of plan.recipe.staticCollisionBindings) {
    const body = bodyById.get(binding.bodyId)!, material = materialById.get(binding.materialRef)!;
    bindings.push(frozen({ instanceId: instanceId("static", body.id), primitiveRef: binding.geometryRef, modelMatrix: retainedMeshModelMatrixFromQuaternion(body.position, body.rotation), color: retainedMeshColor(material.baseColor), emissive: material.emissive }));
  }
  for (const binding of plan.recipe.constraintBindings) {
    const constraint = physics.recipe.constraints.find((entry) => entry.id === binding.constraintId)!, material = materialById.get(binding.materialRef)!;
    const start = worldAnchor(constraint.bodyA, constraint.anchorA, bodyById, dynamicPoseById), end = constraint.bodyB === null ? constraint.anchorB : worldAnchor(constraint.bodyB, constraint.anchorB, bodyById, dynamicPoseById), length = float(Math.hypot(end[0] - start[0], end[1] - start[1], end[2] - start[2]), "C7B4C segment length", 0.0001, PHYSICS_VISUAL_PRESENTATION_CAPS.segmentLength), rotation = quaternionFromY(start, end, length), midpoint = vec([float((start[0] + end[0]) / 2, "C7B4C segment midpoint.x", -20_000, 20_000), float((start[1] + end[1]) / 2, "C7B4C segment midpoint.y", -20_000, 20_000), float((start[2] + end[2]) / 2, "C7B4C segment midpoint.z", -20_000, 20_000)]);
    constraintSegments.push(frozen({ constraintId: constraint.id, start, end, length }));
    bindings.push(frozen({ instanceId: instanceId("constraint", constraint.id), primitiveRef: binding.geometryRef, modelMatrix: retainedMeshModelMatrixFromQuaternionScale(midpoint, rotation, vec([1, length, 1])), color: retainedMeshColor(material.baseColor), emissive: material.emissive }));
  }
  for (const binding of plan.recipe.presentationBindings) {
    const material = materialById.get(binding.materialRef)!, baseColor = retainedMeshColor(material.baseColor), color = frozen([baseColor[0], baseColor[1], baseColor[2], binding.opacity]) as readonly [number, number, number, number];
    bindings.push(frozen({ instanceId: instanceId("fixed", binding.id), primitiveRef: binding.geometryRef, modelMatrix: retainedMeshModelMatrixFromQuaternionScale(binding.position, binding.rotation, binding.scale), color, emissive: material.emissive }));
  }
  if (bindings.length !== plan.instanceSlots.length || bindings.some((binding, index) => binding.instanceId !== plan.instanceSlots[index]!.instanceId || binding.primitiveRef !== plan.instanceSlots[index]!.primitiveRef)) throw new Error("C7B4C frame topology changed after static compilation.");
  const base = { schema: PHYSICS_VISUAL_PRESENTATION_FRAME_SCHEMA, staticFingerprint: plan.fingerprint, visualBindingFingerprint: visual.fingerprint, sourceRetainedFrameFingerprint: retainedFrame.fingerprint, sourcePhysicsFrameFingerprint: physicsFrame.fingerprint, frameIndex: retainedFrame.frameIndex, terminal: retainedFrame.terminal, time: retainedFrame.time, viewport: retainedFrame.viewport, background: retainedFrame.background, viewProjection: retainedFrame.viewProjection, lighting: retainedFrame.lighting, bindings: frozen(bindings), constraintSegments: frozen(constraintSegments), evidence: frozen({ rendererInvoked: false as const, pixels: false as const, perFrameGpuAllocations: 0 as const }) };
  const frame = frozen({ ...base, fingerprint: canonicalJsonSha256(base) }) as PhysicsVisualPresentationFramePlan;
  if (Buffer.byteLength(canonicalJson(frame), "utf8") > PHYSICS_VISUAL_PRESENTATION_CAPS.framePlanBytes) throw new Error(`C7B4C exceeds the ${PHYSICS_VISUAL_PRESENTATION_CAPS.framePlanBytes}-byte frame-plan cap.`);
  mintPhysicsVisualPresentationFramePlan(frame, plan);
  return frame;
}

export function readPhysicsVisualPresentationStaticUpload(value: unknown): PhysicsVisualPresentationStaticUpload {
  const { plan, retained } = requirePhysicsVisualPresentationStaticPlan(value);
  return frozen({ schema: "shellx-motion/private-gltf-object-retained-render-static-upload@1", staticFingerprint: plan.fingerprint, width: retained.recipe.viewport.width, height: retained.recipe.viewport.height, geometries: plan.geometries.map((item) => frozen({ id: item.id, vertexCount: item.vertexCount, indexCount: item.indexCount, vertexBufferSha256: item.vertexBufferSha256, indexBufferSha256: item.indexBufferSha256, vertexBufferBytes: item.vertexBufferBytes, indexBufferBytes: item.indexBufferBytes, verticesBase64: retainedMeshFloatBytes(item.vertices).toString("base64"), indicesBase64: retainedMeshIndexBytes(item.indices).toString("base64") })), instanceSlots: plan.instanceSlots.map((slot) => slot.renderMode === "alpha" ? frozen({ instanceId: slot.instanceId, primitiveRef: slot.primitiveRef, renderMode: "alpha" as const }) : frozen({ instanceId: slot.instanceId, primitiveRef: slot.primitiveRef })), budget: plan.budget });
}

export function readPhysicsVisualPresentationFrameUpload(staticValue: unknown, frameValue: unknown): PhysicsVisualPresentationFrameUpload {
  const { plan } = requirePhysicsVisualPresentationStaticPlan(staticValue), frame = requirePhysicsVisualPresentationFramePlan(frameValue, plan), atUs = frame.time.startUs + frame.time.offsetNumeratorUs / frame.time.denominator;
  return frozen({ schema: "shellx-motion/private-gltf-object-retained-render-frame-upload@1", staticFingerprint: plan.fingerprint, evaluationFingerprint: frame.visualBindingFingerprint, sourceFrameFingerprint: frame.sourcePhysicsFrameFingerprint, atUs, viewport: frame.viewport, background: frame.background, viewProjection: frame.viewProjection, lighting: frame.lighting, bindings: frame.bindings, fingerprint: frame.fingerprint });
}

function readRecipe(value: unknown, retained: PhysicsVisualRetainedStaticPlan, physics: PhysicsBakeAdmissionPlan, baseResources: SceneRecipe["resources"]): Readonly<{ recipe: PhysicsVisualPresentationRecipe; combinedResources: SceneRecipe["resources"] }> {
  const root = exact(snapshotSceneRecipeData(value), ["schema", "retainedStaticFingerprint", "physicsPlanFingerprint", "additionalResources", "staticCollisionBindings", "constraintBindings", "presentationBindings"], "C7B4C recipe");
  if (root.schema !== PHYSICS_VISUAL_PRESENTATION_SCHEMA || root.retainedStaticFingerprint !== retained.fingerprint || root.physicsPlanFingerprint !== physics.fingerprint) throw new Error("C7B4C recipe schema or source identity is invalid.");
  const additional = exact(root.additionalResources, ["geometry", "materials"], "C7B4C additionalResources"), additionalGeometry = array(additional.geometry, "C7B4C additionalResources.geometry", 0, PHYSICS_VISUAL_PRESENTATION_CAPS.geometryResources), additionalMaterials = array(additional.materials, "C7B4C additionalResources.materials", 0, PHYSICS_VISUAL_PRESENTATION_CAPS.materialResources);
  const combinedResources = readSceneRecipeResources({ geometry: [...baseResources.geometry, ...additionalGeometry], materials: [...baseResources.materials, ...additionalMaterials] });
  const geometryById = new Map(combinedResources.geometry.map((entry) => [entry.id, entry])), materialIds = new Set(combinedResources.materials.map((entry) => entry.id)), bodyById = new Map(physics.recipe.bodies.map((entry) => [entry.id, entry])), constraintById = new Map(physics.recipe.constraints.map((entry) => [entry.id, entry]));
  const staticCollisionBindings = array(root.staticCollisionBindings, "C7B4C staticCollisionBindings", 0, PHYSICS_VISUAL_PRESENTATION_CAPS.staticCollisionBindings).map((entry, index) => readStaticBinding(entry, index, bodyById, geometryById, materialIds)), constraintBindings = array(root.constraintBindings, "C7B4C constraintBindings", 0, PHYSICS_VISUAL_PRESENTATION_CAPS.constraintBindings).map((entry, index) => readConstraintBinding(entry, index, constraintById, geometryById, materialIds)), presentationBindings = array(root.presentationBindings, "C7B4C presentationBindings", 0, PHYSICS_VISUAL_PRESENTATION_CAPS.presentationBindings).map((entry, index) => readPresentationBinding(entry, index, geometryById, materialIds));
  strictSourceOrder(staticCollisionBindings.map((entry) => entry.bodyId), physics.recipe.bodies.filter((entry) => entry.kind === "static").map((entry) => entry.id), "C7B4C static-body bindings");
  strictSourceOrder(constraintBindings.map((entry) => entry.constraintId), physics.recipe.constraints.map((entry) => entry.id), "C7B4C constraint bindings");
  for (let index = 1; index < presentationBindings.length; index += 1) if (presentationBindings[index - 1]!.id >= presentationBindings[index]!.id) throw new Error("C7B4C presentation ids must be strict code-unit ascending and unique.");
  const alphaIndexes = presentationBindings.flatMap((entry, index) => entry.opacity < 1 ? [index] : []);
  if (alphaIndexes.length > PHYSICS_VISUAL_PRESENTATION_CAPS.transparentPresentations || (alphaIndexes.length === 1 && alphaIndexes[0] !== presentationBindings.length - 1)) throw new Error("C7B4C permits at most one final translucent presentation binding.");
  const recipe = frozen({ schema: PHYSICS_VISUAL_PRESENTATION_SCHEMA, retainedStaticFingerprint: retained.fingerprint, physicsPlanFingerprint: physics.fingerprint, additionalResources: frozen({ geometry: frozen(combinedResources.geometry.slice(baseResources.geometry.length)), materials: frozen(combinedResources.materials.slice(baseResources.materials.length)) }), staticCollisionBindings: frozen(staticCollisionBindings), constraintBindings: frozen(constraintBindings), presentationBindings: frozen(presentationBindings) });
  return frozen({ recipe, combinedResources });
}

function readStaticBinding(value: unknown, index: number, bodies: ReadonlyMap<string, PhysicsBakeBody>, geometries: ReadonlyMap<string, SceneRecipe["resources"]["geometry"][number]>, materials: ReadonlySet<string>): PhysicsVisualPresentationStaticCollisionBinding {
  const label = `C7B4C staticCollisionBindings[${index}]`, root = exact(value, ["bodyId", "geometryRef", "materialRef"], label), bodyId = safeId(root.bodyId, `${label}.bodyId`), geometryRef = ref(root.geometryRef, `${label}.geometryRef`, geometries), materialRef = ref(root.materialRef, `${label}.materialRef`, materials), body = bodies.get(bodyId);
  if (!body || body.kind !== "static") throw new Error(`${label}.bodyId must identify an admitted static body.`);
  return frozen({ bodyId, geometryRef, materialRef });
}

function readConstraintBinding(value: unknown, index: number, constraints: ReadonlyMap<string, PhysicsBakeAdmissionPlan["recipe"]["constraints"][number]>, geometries: ReadonlyMap<string, SceneRecipe["resources"]["geometry"][number]>, materials: ReadonlySet<string>): PhysicsVisualPresentationConstraintBinding {
  const label = `C7B4C constraintBindings[${index}]`, root = exact(value, ["constraintId", "geometryRef", "materialRef"], label), constraintId = safeId(root.constraintId, `${label}.constraintId`), geometryRef = ref(root.geometryRef, `${label}.geometryRef`, geometries), materialRef = ref(root.materialRef, `${label}.materialRef`, materials), constraint = constraints.get(constraintId), geometry = geometries.get(geometryRef)!;
  if (!constraint || constraint.kind !== "distance") throw new Error(`${label}.constraintId must identify an admitted distance constraint.`);
  if (geometry.kind !== "box" || geometry.size[1] !== 1) throw new Error(`${label}.geometryRef must identify box geometry authored with unit Y length.`);
  return frozen({ constraintId, geometryRef, materialRef });
}

function readPresentationBinding(value: unknown, index: number, geometries: ReadonlyMap<string, SceneRecipe["resources"]["geometry"][number]>, materials: ReadonlySet<string>): PhysicsVisualPresentationFixedBinding {
  const label = `C7B4C presentationBindings[${index}]`, root = exact(value, ["id", "geometryRef", "materialRef", "opacity", "position", "rotation", "scale"], label), id = safeId(root.id, `${label}.id`), geometryRef = ref(root.geometryRef, `${label}.geometryRef`, geometries), materialRef = ref(root.materialRef, `${label}.materialRef`, materials), opacity = float(root.opacity, `${label}.opacity`, 0.05, 1), position = vec3(root.position, `${label}.position`, -10_000, 10_000), rotation = quaternion(root.rotation, `${label}.rotation`), scale = vec3(root.scale, `${label}.scale`, 0.001, 1_000);
  if (opacity !== 1 && opacity > Math.fround(0.95)) throw new Error(`${label}.opacity must equal 1 or be in 0.05..0.95.`);
  if (scale[0] !== scale[1] || scale[1] !== scale[2]) throw new Error(`${label}.scale must be uniform until the retained normal-matrix ABI is qualified.`);
  return frozen({ id, geometryRef, materialRef, opacity, position, rotation, scale });
}

function worldAnchor(bodyId: string, anchor: PhysicsBakeVec3, bodies: ReadonlyMap<string, PhysicsBakeBody>, dynamicPoses: ReadonlyMap<string, Readonly<{ position: PhysicsBakeVec3; rotation: PhysicsBakeQuaternion }>>): readonly [number, number, number] {
  const body = bodies.get(bodyId)! as PhysicsBakeBody, pose = body.kind === "dynamic" ? dynamicPoses.get(bodyId) : body;
  if (!pose) throw new Error(`C7B4C cannot resolve current pose for constraint body '${bodyId}'.`);
  const rotated = rotate(anchor, pose.rotation);
  return vec([float(pose.position[0] + rotated[0], "C7B4C world anchor.x", -20_000, 20_000), float(pose.position[1] + rotated[1], "C7B4C world anchor.y", -20_000, 20_000), float(pose.position[2] + rotated[2], "C7B4C world anchor.z", -20_000, 20_000)]);
}

function rotate(value: PhysicsBakeVec3, q: PhysicsBakeQuaternion): readonly [number, number, number] {
  const [x, y, z, w] = q, tx = 2 * (y * value[2] - z * value[1]), ty = 2 * (z * value[0] - x * value[2]), tz = 2 * (x * value[1] - y * value[0]);
  return vec([Math.fround(value[0] + w * tx + y * tz - z * ty), Math.fround(value[1] + w * ty + z * tx - x * tz), Math.fround(value[2] + w * tz + x * ty - y * tx)]);
}

function quaternionFromY(start: readonly [number, number, number], end: readonly [number, number, number], length: number): readonly [number, number, number, number] {
  const dx = (end[0] - start[0]) / length, dy = (end[1] - start[1]) / length, dz = (end[2] - start[2]) / length;
  if (dy < -0.999999) return frozen([1, 0, 0, 0]);
  const qx = dz, qy = 0, qz = -dx, qw = 1 + dy, inverse = 1 / Math.hypot(qx, qy, qz, qw);
  return frozen([Math.fround(qx * inverse), 0, Math.fround(qz * inverse), Math.fround(qw * inverse)]);
}

function enforceBudget(value: { geometryResourceCount: number; materialResourceCount: number; instanceSlotCount: number; vertexBufferBytes: number; indexBufferBytes: number; retainedGpuBytes: number }): void {
  if (value.geometryResourceCount > PHYSICS_VISUAL_PRESENTATION_CAPS.geometryResources || value.materialResourceCount > PHYSICS_VISUAL_PRESENTATION_CAPS.materialResources || value.instanceSlotCount > PHYSICS_VISUAL_PRESENTATION_CAPS.instanceSlots || value.vertexBufferBytes > PHYSICS_VISUAL_PRESENTATION_CAPS.vertexBytes || value.indexBufferBytes > PHYSICS_VISUAL_PRESENTATION_CAPS.indexBytes || value.retainedGpuBytes > PHYSICS_VISUAL_PRESENTATION_CAPS.retainedGpuBytes) throw new Error("C7B4C retained resource budget exceeds its fixed caps.");
}
function instanceId(kind: "static" | "constraint" | "fixed", id: string): string { return `c7b4c-${kind}-${id}`; }
function strictSourceOrder(selected: readonly string[], source: readonly string[], label: string): void { const indexes = selected.map((id) => source.indexOf(id)); if (indexes.some((entry) => entry < 0) || indexes.some((entry, index) => index > 0 && entry <= indexes[index - 1]!)) throw new Error(`${label} must be unique and preserve admitted source order.`); }
function exact(value: unknown, keys: readonly string[], label: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`${label} must be a plain object.`); const root = value as Record<string, unknown>, actual = Reflect.ownKeys(root); if (actual.length !== keys.length || actual.some((key) => typeof key !== "string" || !keys.includes(key)) || keys.some((key) => !Object.hasOwn(root, key))) throw new Error(`${label} has missing or unknown fields.`); return root; }
function array(value: unknown, label: string, minimum: number, maximum: number): unknown[] { if (!Array.isArray(value) || value.length < minimum || value.length > maximum) throw new Error(`${label} must contain ${minimum}..${maximum} entries.`); return value; }
function safeId(value: unknown, label: string): string { if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value)) throw new Error(`${label} must be a safe stable id.`); return value; }
function ref<T>(value: unknown, label: string, values: ReadonlyMap<string, T> | ReadonlySet<string>): string { const id = safeId(value, label); if (!values.has(id)) throw new Error(`${label} does not identify a combined C7B4C resource.`); return id; }
function float(value: unknown, label: string, minimum: number, maximum: number): number { if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`${label} must be finite in ${minimum}..${maximum}.`); const result = Math.fround(value); if (result < minimum || result > maximum) throw new Error(`${label} cannot be represented in the admitted f32 range.`); return Object.is(result, -0) ? 0 : result; }
function vec3(value: unknown, label: string, minimum: number, maximum: number): readonly [number, number, number] { if (!Array.isArray(value) || value.length !== 3) throw new Error(`${label} must be a three-number tuple.`); return vec(value.map((entry, index) => float(entry, `${label}[${index}]`, minimum, maximum)) as [number, number, number]); }
function quaternion(value: unknown, label: string): readonly [number, number, number, number] { if (!Array.isArray(value) || value.length !== 4) throw new Error(`${label} must be a four-number tuple.`); const result = value.map((entry, index) => float(entry, `${label}[${index}]`, -1, 1)) as [number, number, number, number], lengthSquared = result.reduce((sum, entry) => sum + entry * entry, 0); if (Math.abs(lengthSquared - 1) > 0.0001) throw new Error(`${label} must be a unit quaternion.`); return frozen(result); }
function vec(value: readonly [number, number, number]): readonly [number, number, number] { return frozen(value); }
function frozen<T extends object>(value: T): Readonly<T> { return Object.freeze(value); }
