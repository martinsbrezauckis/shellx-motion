/** Fixed private receipt for C6B6b triangle geometry-keyframe COW installation; no Debug route imports it. */
import {
  canonicalJson,
  canonicalJsonSha256,
  compareCodeUnits,
  readBoundedStableFile,
  writeVerifiedBoundedFile,
} from "@shellx-motion/core";
import { readCheckpointStoryboard } from "@shellx-motion/core/internal/checkpoint-storyboard-scalar-spatial-materializer";
import { join } from "node:path";
import { PackageEditTransactionError } from "../package-edit-transaction.js";
import {
  C6B6B_LOGICAL_MOTION_PATH,
  C6B6B_RECEIPT_OPERATION,
  C6B6B_RECEIPT_PATH,
  C6B6B_RECEIPT_SCHEMA,
  type C6B6bExactBase,
  type C6B6bGeometry,
  type C6B6bInventory,
  type C6B6bPlanEvidence,
  type C6B6bProjectionIdentity,
  type CheckpointStoryboardGeometryMorphMaterializationReceipt,
} from "./checkpoint-storyboard-geometry-morph-materialize-receipt-contract-private.js";
export {
  C6B6B_LOGICAL_MOTION_PATH,
  C6B6B_RECEIPT_OPERATION,
  C6B6B_RECEIPT_PATH,
  C6B6B_RECEIPT_SCHEMA,
} from "./checkpoint-storyboard-geometry-morph-materialize-receipt-contract-private.js";
export type {
  C6B6bExactBase,
  C6B6bGeometry,
  C6B6bInventory,
  C6B6bPlanEvidence,
  C6B6bProjectionIdentity,
  CheckpointStoryboardGeometryMorphMaterializationReceipt,
} from "./checkpoint-storyboard-geometry-morph-materialize-receipt-contract-private.js";
const HASH = /^[a-f0-9]{64}$/u;
const STORYBOARD_ID = /^checkpoint_storyboard_[a-f0-9]{32}$/u;
const MAX_RECEIPT_BYTES = 1024 * 1024;
const MAX_IDENTIFIER_LENGTH = 128;
const MAX_INVENTORY_ENTRIES = 100_000;

/** Binds package observation to the complete, immutable B6a projection before any COW work begins. */
export function bindC6B6bExactBase(
  base: C6B6bExactBase,
  plan: C6B6bPlanEvidence,
  outputCanonicalMotionSha256: string,
): C6B6bExactBase {
  const accepted = readC6B6bPlanEvidence(plan);
  hash(outputCanonicalMotionSha256, "C6B6b output canonical Motion");
  const exact = frozen({
    ...readUnboundBase(base),
    planFingerprint: accepted.fingerprint,
    profileFingerprint: accepted.lowererProfile.fingerprint,
    storyboardId: accepted.storyboard.id,
    storyboardSha256: accepted.storyboard.sha256,
    storyboardRevision: accepted.storyboard.revision,
    sourceLayerId: accepted.objectLayerBinding.layerId,
    sourceLayerIndex: accepted.objectLayerBinding.layerIndex,
    sourceGeometrySha256: accepted.projection.staticGeometry.sha256,
    sourceGeometryKeyframes: "absent" as const,
    materializedGeometryKeyframesSha256: canonicalJsonSha256(accepted.projection.geometryKeyframes),
    outputCanonicalMotionSha256,
  });
  return readC6B6bExactBase(exact);
}

/** Creates the sealed B6b result only after source/output identities and all single-write facts agree. */
export function createC6B6bReceipt(
  plan: C6B6bPlanEvidence,
  storyboard: unknown,
  source: C6B6bExactBase,
  output: C6B6bExactBase,
  motionPath: string,
  nonReceiptInventory: C6B6bInventory,
  preservedLeaves: { readonly sha256: string; readonly count: number },
  workspaceCleanup: "not-attested" = "not-attested",
): CheckpointStoryboardGeometryMorphMaterializationReceipt {
  const accepted = readC6B6bPlanEvidence(plan), sealedStoryboard = readStoryboard(storyboard);
  const expected = readC6B6bExactBase(source), reopened = readC6B6bExactBase(output);
  const nonReceipt = readInventory(nonReceiptInventory, "C6B6b output non-receipt inventory");
  const preserved = readPreservedLeaves(preservedLeaves, "C6B6b output preserved leaves");
  if (!safePackagePath(motionPath)) fail("C6B6b materialization Motion path is invalid.");
  assertPlanBaseEvidence(accepted, expected);
  if (expected.packageId !== reopened.packageId || expected.manifestRawSha256 !== reopened.manifestRawSha256 || expected.manifestCanonicalSha256 !== reopened.manifestCanonicalSha256 || expected.sourceLayerId !== reopened.sourceLayerId || expected.sourceLayerIndex !== reopened.sourceLayerIndex || expected.sourceGeometrySha256 !== reopened.sourceGeometrySha256 || expected.sourceGeometryKeyframes !== reopened.sourceGeometryKeyframes || expected.materializedGeometryKeyframesSha256 !== reopened.materializedGeometryKeyframesSha256 || expected.outputCanonicalMotionSha256 !== reopened.outputCanonicalMotionSha256 || reopened.motionCanonicalSha256 !== expected.outputCanonicalMotionSha256) {
    fail("C6B6b output exact base does not retain the approved package/projection or canonical Motion identity.");
  }
  const payload: Omit<CheckpointStoryboardGeometryMorphMaterializationReceipt, "fingerprint"> = {
    schema: C6B6B_RECEIPT_SCHEMA,
    operation: C6B6B_RECEIPT_OPERATION,
    status: "passed",
    approval: frozen({
      storyboard: frozen({ id: sealedStoryboard.id, sha256: sealedStoryboard.sha256, revision: sealedStoryboard.revision, record: structuredClone(sealedStoryboard.record) }),
      plan: structuredClone(accepted),
      projection: projectionIdentity(accepted),
    }),
    base: frozen({ expected, reopened: expected }),
    output: frozen({
      packageId: reopened.packageId,
      manifestRawSha256: reopened.manifestRawSha256,
      manifestCanonicalSha256: reopened.manifestCanonicalSha256,
      motionRawSha256: reopened.motionRawSha256,
      canonicalMotionSha256: reopened.motionCanonicalSha256,
      nonReceiptInventory: nonReceipt,
      preservedLeaves: preserved,
      changed: frozen({ paths: fixedChangedPaths(motionPath), count: 2 as const, motionPropertyPaths: [C6B6B_LOGICAL_MOTION_PATH] as const, motionPropertyPathCount: 1 as const }),
    }),
    transaction: frozen({ cow: "closed-inventory-finalize-after-edit" as const, installed: true as const, exclusiveReceipt: true as const, workspaceCleanup }),
    renderer: frozen({ invoked: false as const, pixels: false as const }),
  };
  return frozen({ ...payload, fingerprint: canonicalJsonSha256(payload) });
}

/** Publishes exactly one bounded regular receipt leaf, then reopens and compares its complete identity. */
export async function writeC6B6bReceipt(root: string, receipt: CheckpointStoryboardGeometryMorphMaterializationReceipt): Promise<void> {
  const accepted = readC6B6bReceiptValue(receipt);
  const bytes = Buffer.from(`${canonicalJson(accepted)}\n`, "utf8");
  if (bytes.byteLength > MAX_RECEIPT_BYTES) throw new PackageEditTransactionError("package_limit_exceeded", "C6B6b receipt exceeds 1 MiB.");
  try {
    await writeVerifiedBoundedFile(join(root, C6B6B_RECEIPT_PATH), bytes, { label: "C6B6b geometry-morph materialization receipt", maxBytes: MAX_RECEIPT_BYTES, withinRoot: root });
  } catch {
    throw new PackageEditTransactionError("copy_mismatch", "C6B6b receipt could not be exclusively published.");
  }
  if (!same(await readC6B6bReceipt(root), accepted)) throw new PackageEditTransactionError("copy_mismatch", "C6B6b receipt differs after staged publication.");
}

/** Reads only one stable, single-link, canonical receipt file and revalidates every binding before returning it. */
export async function readC6B6bReceipt(root: string): Promise<CheckpointStoryboardGeometryMorphMaterializationReceipt> {
  const file = await readBoundedStableFile(join(root, C6B6B_RECEIPT_PATH), { label: "C6B6b geometry-morph materialization receipt", maxBytes: MAX_RECEIPT_BYTES, withinRoot: root, requireSingleLink: true });
  let parsed: unknown;
  try { parsed = JSON.parse(file.bytes.toString("utf8")); }
  catch { throw new PackageEditTransactionError("copy_mismatch", "C6B6b receipt is not JSON."); }
  const receipt = readC6B6bReceiptValue(parsed);
  if (file.bytes.toString("utf8") !== `${canonicalJson(receipt)}\n`) fail("C6B6b receipt bytes are not canonical.");
  return receipt;
}

/** Exact-base reader shared by the B6 main, facts, and output-only reopen adapters. */
export function readC6B6bExactBase(value: unknown): C6B6bExactBase {
  const base = record(value, ["packageId", "manifestRawSha256", "motionRawSha256", "manifestCanonicalSha256", "motionCanonicalSha256", "inventory", "planFingerprint", "profileFingerprint", "storyboardId", "storyboardSha256", "storyboardRevision", "sourceLayerId", "sourceLayerIndex", "sourceGeometrySha256", "sourceGeometryKeyframes", "materializedGeometryKeyframesSha256", "outputCanonicalMotionSha256"], "C6B6b exact base");
  identifier(base.packageId, "C6B6b exact base.packageId");
  for (const key of ["manifestRawSha256", "motionRawSha256", "manifestCanonicalSha256", "motionCanonicalSha256", "planFingerprint", "profileFingerprint", "storyboardSha256", "sourceGeometrySha256", "materializedGeometryKeyframesSha256", "outputCanonicalMotionSha256"] as const) hash(base[key], `C6B6b exact base.${key}`);
  const storyboardId = storyboardIdentifier(base.storyboardId, "C6B6b exact base.storyboardId"), storyboardSha256 = base.storyboardSha256 as string;
  if (storyboardId !== `checkpoint_storyboard_${storyboardSha256.slice(0, 32)}`) fail("C6B6b exact base storyboard id does not bind its sha256.");
  const exact = frozen({
    packageId: base.packageId as string,
    manifestRawSha256: base.manifestRawSha256 as string,
    motionRawSha256: base.motionRawSha256 as string,
    manifestCanonicalSha256: base.manifestCanonicalSha256 as string,
    motionCanonicalSha256: base.motionCanonicalSha256 as string,
    inventory: readInventory(base.inventory, "C6B6b exact base inventory"),
    planFingerprint: base.planFingerprint as string,
    profileFingerprint: base.profileFingerprint as string,
    storyboardId,
    storyboardSha256,
    storyboardRevision: positive(base.storyboardRevision, "C6B6b exact base.storyboardRevision", 1_000_000),
    sourceLayerId: identifier(base.sourceLayerId, "C6B6b exact base.sourceLayerId"),
    sourceLayerIndex: base.sourceLayerIndex === 0 ? 0 : fail("C6B6b exact base.sourceLayerIndex must equal zero."),
    sourceGeometrySha256: base.sourceGeometrySha256 as string,
    sourceGeometryKeyframes: base.sourceGeometryKeyframes === "absent" ? "absent" as const : fail("C6B6b exact base.sourceGeometryKeyframes must be absent."),
    materializedGeometryKeyframesSha256: base.materializedGeometryKeyframesSha256 as string,
    outputCanonicalMotionSha256: base.outputCanonicalMotionSha256 as string,
  });
  return exact;
}

/** Strict plan reader retained for host-only materializers; it accepts no renderer or package authority. */
export function readC6B6bPlanEvidence(value: unknown): C6B6bPlanEvidence {
  const plan = record(value, ["schema", "storyboard", "base", "lowererProfile", "objectLayerBinding", "projection", "intendedChanges", "budget", "evidence", "fingerprint"], "C6B6b plan");
  if (plan.schema !== "shellx-motion/private-checkpoint-storyboard-geometry-morph-profile-plan@1") fail("C6B6b plan schema is invalid.");
  const { fingerprint, ...payload } = plan;
  hash(fingerprint, "C6B6b plan fingerprint");
  if (canonicalJsonSha256(payload) !== fingerprint) fail("C6B6b plan fingerprint is stale.");
  const storyboard = readPlanStoryboard(plan.storyboard);
  const base = readPlanBase(plan.base);
  const profile = readProfile(plan.lowererProfile);
  const binding = readBinding(plan.objectLayerBinding);
  const projection = readProjection(plan.projection);
  const intendedChanges = readIntendedChanges(plan.intendedChanges);
  readBudget(plan.budget); readEvidence(plan.evidence);
  if (base.package.id !== base.manifest.id || base.canonicalMotion.id !== base.persistedMotion.id || binding.objectId !== binding.layerId || projection.staticGeometry.sha256 !== canonicalJsonSha256(projection.staticGeometry.geometry) || projection.topology.viewBoxSha256 !== canonicalJsonSha256(projection.staticGeometry.geometry.viewBox) || !sameViewBox(projection.staticGeometry.geometry, projection.endpoints[1].geometry) || projection.endpoints[0].sha256 !== projection.staticGeometry.sha256 || projection.endpoints[0].atUs !== projection.geometryKeyframes.keyframes[0].atUs || projection.endpoints[1].atUs !== projection.geometryKeyframes.keyframes[1].atUs || !same(projection.endpoints[0].geometry, projection.geometryKeyframes.keyframes[0].geometry) || !same(projection.endpoints[1].geometry, projection.geometryKeyframes.keyframes[1].geometry)) {
    fail("C6B6b plan target geometry projection is inconsistent.");
  }
  assertAreaProof(projection.areaProof, projection.endpoints[0].geometry, projection.endpoints[1].geometry);
  return frozen({ schema: plan.schema, storyboard, base, lowererProfile: profile, objectLayerBinding: binding, projection, intendedChanges, budget: plan.budget as C6B6bPlanEvidence["budget"], evidence: plan.evidence as C6B6bPlanEvidence["evidence"], fingerprint: fingerprint as string });
}

function readC6B6bReceiptValue(value: unknown): CheckpointStoryboardGeometryMorphMaterializationReceipt {
  const receipt = record(value, ["schema", "operation", "status", "approval", "base", "output", "transaction", "renderer", "fingerprint"], "C6B6b receipt");
  if (receipt.schema !== C6B6B_RECEIPT_SCHEMA || receipt.operation !== C6B6B_RECEIPT_OPERATION || receipt.status !== "passed") fail("C6B6b receipt identity is invalid.");
  const { fingerprint, ...payload } = receipt;
  hash(fingerprint, "C6B6b receipt fingerprint");
  if (canonicalJsonSha256(payload) !== fingerprint) fail("C6B6b receipt fingerprint is stale.");
  const approval = record(receipt.approval, ["storyboard", "plan", "projection"], "C6B6b receipt approval");
  const storyboard = readStoryboard(record(approval.storyboard, ["id", "sha256", "revision", "record"], "C6B6b receipt storyboard").record);
  const plan = readC6B6bPlanEvidence(approval.plan), projection = readProjectionIdentity(approval.projection, "C6B6b receipt projection");
  if (storyboard.id !== plan.storyboard.id || storyboard.sha256 !== plan.storyboard.sha256 || storyboard.revision !== plan.storyboard.revision || !same(projection, projectionIdentity(plan))) fail("C6B6b receipt approval does not bind its sealed storyboard and B6a projection.");
  const base = record(receipt.base, ["expected", "reopened"], "C6B6b receipt base"), expected = readC6B6bExactBase(base.expected), reopened = readC6B6bExactBase(base.reopened);
  if (!same(expected, reopened)) fail("C6B6b receipt exact-base reopen identity is inconsistent.");
  assertPlanBaseEvidence(plan, expected);
  const output = readOutput(receipt.output, expected);
  const transaction = readTransaction(receipt.transaction), renderer = readRenderer(receipt.renderer);
  return frozen({ schema: C6B6B_RECEIPT_SCHEMA, operation: C6B6B_RECEIPT_OPERATION, status: "passed" as const, approval: frozen({ storyboard: frozen(storyboard), plan, projection }), base: frozen({ expected, reopened }), output, transaction, renderer, fingerprint: fingerprint as string });
}

function readUnboundBase(value: unknown) {
  const base = record(value, ["packageId", "manifestRawSha256", "motionRawSha256", "manifestCanonicalSha256", "motionCanonicalSha256", "inventory", "planFingerprint", "profileFingerprint", "storyboardId", "storyboardSha256", "storyboardRevision", "sourceLayerId", "sourceLayerIndex", "sourceGeometrySha256", "sourceGeometryKeyframes", "materializedGeometryKeyframesSha256", "outputCanonicalMotionSha256"], "C6B6b unbound base");
  identifier(base.packageId, "C6B6b unbound base.packageId");
  for (const key of ["manifestRawSha256", "motionRawSha256", "manifestCanonicalSha256", "motionCanonicalSha256"] as const) hash(base[key], `C6B6b unbound base.${key}`);
  if (base.sourceGeometryKeyframes !== "absent") fail("C6B6b unbound base must explicitly retain absent geometryKeyframes.");
  return frozen({ packageId: base.packageId as string, manifestRawSha256: base.manifestRawSha256 as string, motionRawSha256: base.motionRawSha256 as string, manifestCanonicalSha256: base.manifestCanonicalSha256 as string, motionCanonicalSha256: base.motionCanonicalSha256 as string, inventory: readInventory(base.inventory, "C6B6b unbound base inventory") });
}
function readPlanStoryboard(value: unknown) {
  const storyboard = record(value, ["id", "sha256", "revision", "fingerprint"], "C6B6b plan storyboard"), id = storyboardIdentifier(storyboard.id, "C6B6b plan storyboard.id");
  hash(storyboard.sha256, "C6B6b plan storyboard.sha256"); hash(storyboard.fingerprint, "C6B6b plan storyboard.fingerprint");
  if (id !== `checkpoint_storyboard_${String(storyboard.sha256).slice(0, 32)}`) fail("C6B6b plan storyboard id does not bind its sha256.");
  return frozen({ id, sha256: storyboard.sha256 as string, revision: positive(storyboard.revision, "C6B6b plan storyboard.revision", 1_000_000), fingerprint: storyboard.fingerprint as string });
}
function readPlanBase(value: unknown) {
  const base = record(value, ["package", "manifest", "canonicalMotion", "persistedMotion"], "C6B6b plan base");
  const reference = (candidate: unknown, label: string, keys: readonly string[]) => {
    const item = record(candidate, keys, label); identifier(item.id, `${label}.id`); hash(item.sha256, `${label}.sha256`); return frozen({ ...item }) as { readonly id: string; readonly sha256: string };
  };
  const packageFact = record(base.package, ["id", "motionPath"], "C6B6b plan package"); identifier(packageFact.id, "C6B6b plan package.id"); if (!safePackagePath(packageFact.motionPath)) fail("C6B6b plan Motion path is invalid.");
  return frozen({ package: frozen({ id: packageFact.id as string, motionPath: packageFact.motionPath as string }), manifest: reference(base.manifest, "C6B6b plan manifest", ["id", "sha256"]), canonicalMotion: reference(base.canonicalMotion, "C6B6b plan canonical Motion", ["id", "sha256"]), persistedMotion: reference(base.persistedMotion, "C6B6b plan persisted Motion", ["id", "sha256"]) });
}
function readProfile(value: unknown) {
  const profile = record(value, ["schema", "requiredCapability", "rootShapeKind", "geometryKind", "pointCount", "correspondence", "easing", "lifecycle", "ownedWriteMask", "fingerprint"], "C6B6b plan profile"), { fingerprint, ...payload } = profile;
  if (profile.schema !== "shellx-motion/private-checkpoint-storyboard-geometry-morph-profile@1" || profile.requiredCapability !== "renderer.gpu" || profile.rootShapeKind !== "geometry" || profile.geometryKind !== "polygon" || profile.pointCount !== 3 || profile.correspondence !== "ordinal" || profile.easing !== "linear" || profile.lifecycle !== "preserve" || !same(profile.ownedWriteMask, ["geometry"])) fail("C6B6b plan profile is widened or invalid.");
  hash(fingerprint, "C6B6b plan profile fingerprint"); if (canonicalJsonSha256(payload) !== fingerprint) fail("C6B6b plan profile fingerprint is stale.");
  return frozen({ ...profile }) as unknown as C6B6bPlanEvidence["lowererProfile"];
}
function readBinding(value: unknown) {
  const binding = record(value, ["objectId", "layerId", "layerIndex", "rootShapeKind"], "C6B6b plan object/layer binding");
  identifier(binding.objectId, "C6B6b plan object binding object id"); identifier(binding.layerId, "C6B6b plan object binding layer id");
  if (binding.objectId !== binding.layerId || binding.layerIndex !== 0 || binding.rootShapeKind !== "geometry") fail("C6B6b plan object/layer binding is invalid.");
  return frozen({ objectId: binding.objectId as string, layerId: binding.layerId as string, layerIndex: 0 as const, rootShapeKind: "geometry" as const });
}
function readProjection(value: unknown) {
  const projection = record(value, ["edge", "recipe", "path", "staticGeometry", "endpoints", "geometryKeyframes", "topology", "areaProof"], "C6B6b plan projection");
  if (projection.path !== C6B6B_LOGICAL_MOTION_PATH) fail("C6B6b plan projection path is invalid.");
  const edge = record(projection.edge, ["id", "fromCheckpointId", "toCheckpointId"], "C6B6b projection edge"); [edge.id, edge.fromCheckpointId, edge.toCheckpointId].forEach((item, index) => identifier(item, `C6B6b projection edge.${index}`));
  const recipe = record(projection.recipe, ["id", "sha256", "revision", "recipeId"], "C6B6b projection recipe"); identifier(recipe.id, "C6B6b projection recipe.id"); identifier(recipe.recipeId, "C6B6b projection recipe.recipeId"); hash(recipe.sha256, "C6B6b projection recipe.sha256"); positive(recipe.revision, "C6B6b projection recipe.revision", 1_000_000);
  const staticGeometry = record(projection.staticGeometry, ["sha256", "geometry"], "C6B6b static geometry"); hash(staticGeometry.sha256, "C6B6b static geometry.sha256"); const geometry = readGeometry(staticGeometry.geometry, "C6B6b static geometry.geometry"); if (canonicalJsonSha256(geometry) !== staticGeometry.sha256) fail("C6B6b static geometry hash is stale.");
  const endpoints = tuple(projection.endpoints, 2, "C6B6b projection endpoints").map((entry, index) => readEndpoint(entry, `C6B6b projection endpoint ${index}`)) as unknown as C6B6bPlanEvidence["projection"]["endpoints"];
  if (endpoints[0].atUs !== 0 || endpoints[0].atUs >= endpoints[1].atUs) fail("C6B6b projection endpoints are not a closed 0..D sequence.");
  const keyframes = readGeometryKeyframes(projection.geometryKeyframes, endpoints);
  const topology = record(projection.topology, ["kind", "viewBoxSha256", "pointCount", "correspondence"], "C6B6b projection topology");
  if (topology.kind !== "polygon" || topology.pointCount !== 3 || topology.correspondence !== "ordinal") fail("C6B6b projection topology is invalid."); hash(topology.viewBoxSha256, "C6B6b projection topology.viewBoxSha256"); if (topology.viewBoxSha256 !== canonicalJsonSha256(geometry.viewBox)) fail("C6B6b projection viewBox identity is stale.");
  return frozen({ edge: frozen({ id: edge.id as string, fromCheckpointId: edge.fromCheckpointId as string, toCheckpointId: edge.toCheckpointId as string }), recipe: frozen({ id: recipe.id as string, sha256: recipe.sha256 as string, revision: recipe.revision as number, recipeId: recipe.recipeId as string }), path: C6B6B_LOGICAL_MOTION_PATH, staticGeometry: frozen({ sha256: staticGeometry.sha256 as string, geometry }), endpoints, geometryKeyframes: keyframes, topology: frozen({ kind: "polygon" as const, viewBoxSha256: topology.viewBoxSha256 as string, pointCount: 3 as const, correspondence: "ordinal" as const }), areaProof: readAreaProof(projection.areaProof) }) as C6B6bPlanEvidence["projection"];
}
function readEndpoint(value: unknown, label: string) {
  const endpoint = record(value, ["atUs", "geometry", "sha256", "evaluationFingerprint"], label), atUs = nonNegative(endpoint.atUs, `${label}.atUs`), geometry = readGeometry(endpoint.geometry, `${label}.geometry`);
  hash(endpoint.sha256, `${label}.sha256`); hash(endpoint.evaluationFingerprint, `${label}.evaluationFingerprint`); if (canonicalJsonSha256(geometry) !== endpoint.sha256) fail(`${label} geometry hash is stale.`);
  return frozen({ atUs, geometry, sha256: endpoint.sha256 as string, evaluationFingerprint: endpoint.evaluationFingerprint as string });
}
function readGeometryKeyframes(value: unknown, endpoints: C6B6bPlanEvidence["projection"]["endpoints"]) {
  const keyframes = record(value, ["schema", "keyframes"], "C6B6b geometry keyframes"); if (keyframes.schema !== "shellx-motion/shape-geometry-keyframes@1") fail("C6B6b geometry-keyframes schema is invalid.");
  const entries = tuple(keyframes.keyframes, 2, "C6B6b geometry keyframes");
  const first = record(entries[0], ["atUs", "geometry", "easing"], "C6B6b geometry keyframe 0"), second = record(entries[1], ["atUs", "geometry"], "C6B6b geometry keyframe 1");
  if (first.easing !== "linear" || nonNegative(first.atUs, "C6B6b geometry keyframe 0.atUs") !== endpoints[0].atUs || nonNegative(second.atUs, "C6B6b geometry keyframe 1.atUs") !== endpoints[1].atUs) fail("C6B6b geometry-keyframe timing/easing is invalid.");
  const start = readGeometry(first.geometry, "C6B6b geometry keyframe 0.geometry"), end = readGeometry(second.geometry, "C6B6b geometry keyframe 1.geometry");
  if (!same(start, endpoints[0].geometry) || !same(end, endpoints[1].geometry)) fail("C6B6b geometry-keyframes do not bind endpoint geometry.");
  return frozen({ schema: "shellx-motion/shape-geometry-keyframes@1" as const, keyframes: frozen([frozen({ atUs: endpoints[0].atUs, geometry: start, easing: "linear" as const }), frozen({ atUs: endpoints[1].atUs, geometry: end })]) as C6B6bPlanEvidence["projection"]["geometryKeyframes"]["keyframes"] });
}
function readAreaProof(value: unknown) {
  const proof = record(value, ["polynomial", "orientation", "minimumAbsoluteTwiceArea", "witnessTimes", "witnessTwiceAreas"], "C6B6b area proof"), polynomial = record(proof.polynomial, ["constant", "linear", "quadratic"], "C6B6b area polynomial");
  if (proof.orientation !== "clockwise" && proof.orientation !== "counterclockwise") fail("C6B6b area proof orientation is invalid.");
  const witnessTimes = finiteArray(proof.witnessTimes, "C6B6b area witness times", 2, 3), witnessTwiceAreas = finiteArray(proof.witnessTwiceAreas, "C6B6b area witness areas", 2, 3);
  if (witnessTimes.length !== witnessTwiceAreas.length || !Number.isFinite(proof.minimumAbsoluteTwiceArea) || (proof.minimumAbsoluteTwiceArea as number) < 1e-6) fail("C6B6b area proof minimum is invalid.");
  return frozen({ polynomial: frozen({ constant: finite(polynomial.constant, "C6B6b area polynomial.constant"), linear: finite(polynomial.linear, "C6B6b area polynomial.linear"), quadratic: finite(polynomial.quadratic, "C6B6b area polynomial.quadratic") }), orientation: proof.orientation, minimumAbsoluteTwiceArea: proof.minimumAbsoluteTwiceArea as number, witnessTimes, witnessTwiceAreas }) as C6B6bPlanEvidence["projection"]["areaProof"];
}
function assertAreaProof(proof: C6B6bPlanEvidence["projection"]["areaProof"], start: C6B6bGeometry, end: C6B6bGeometry): void {
  const twiceArea = (points: readonly { readonly x: number; readonly y: number }[]) => cross(delta(points[1], points[0]), delta(points[2], points[0]));
  const d01 = delta(delta(end.points[1], end.points[0]), delta(start.points[1], start.points[0])), d02 = delta(delta(end.points[2], end.points[0]), delta(start.points[2], start.points[0]));
  const expected = { constant: twiceArea(start.points), linear: cross(d01, delta(start.points[2], start.points[0])) + cross(delta(start.points[1], start.points[0]), d02), quadratic: cross(d01, d02) };
  if (!same(expected, proof.polynomial)) fail("C6B6b area proof polynomial is stale.");
  const times = expected.quadratic === 0 ? [0, 1] : (() => { const vertex = -expected.linear / (2 * expected.quadratic); return vertex > 0 && vertex < 1 ? [0, vertex, 1] : [0, 1]; })();
  const areas = times.map((time) => expected.constant + expected.linear * time + expected.quadratic * time * time), orientation = areas[0]! > 0 ? "counterclockwise" : "clockwise", minimum = Math.min(...areas.map(Math.abs));
  if (!same(times, proof.witnessTimes) || !same(areas, proof.witnessTwiceAreas) || orientation !== proof.orientation || minimum !== proof.minimumAbsoluteTwiceArea || minimum < 1e-6 || areas.some((area) => (area > 0 ? "counterclockwise" : "clockwise") !== orientation)) fail("C6B6b area proof does not establish non-zero fixed orientation.");
}
function readIntendedChanges(value: unknown) {
  const changes = record(value, ["paths", "geometryKeyframes"], "C6B6b intended changes"); if (!same(changes.paths, [C6B6B_LOGICAL_MOTION_PATH])) fail("C6B6b intended logical path is invalid.");
  const geometry = record(changes.geometryKeyframes, ["operation", "keyframeCount"], "C6B6b intended geometry-keyframe changes"); if (geometry.operation !== "replace-absent" || geometry.keyframeCount !== 2) fail("C6B6b intended geometry-keyframe operation is invalid.");
  return frozen({ paths: [C6B6B_LOGICAL_MOTION_PATH] as const, geometryKeyframes: frozen({ operation: "replace-absent" as const, keyframeCount: 2 as const }) });
}
function readBudget(value: unknown): void { const budget = record(value, ["objects", "checkpoints", "edges", "recipes", "snapshots", "interpolationScalars", "changedPaths"], "C6B6b plan budget"); if (budget.objects !== 1 || budget.checkpoints !== 2 || budget.edges !== 1 || budget.recipes !== 1 || budget.snapshots !== 2 || budget.interpolationScalars !== 6 || budget.changedPaths !== 1) fail("C6B6b plan budget is invalid."); }
function readEvidence(value: unknown): void { const evidence = record(value, ["noPackageIO", "noPackageWrites", "noCOW", "noReceipt", "noPublicSurface", "noRenderer"], "C6B6b plan evidence"); if (evidence.noPackageIO !== true || evidence.noPackageWrites !== true || evidence.noCOW !== true || evidence.noReceipt !== true || evidence.noPublicSurface !== true || evidence.noRenderer !== true) fail("C6B6b plan evidence is invalid."); }
function readProjectionIdentity(value: unknown, label: string): C6B6bProjectionIdentity {
  const identity = record(value, ["sourceLayerId", "sourceLayerIndex", "sourceGeometrySha256", "sourceGeometryKeyframes", "materializedGeometryKeyframesSha256", "endpointSequenceSha256", "topologySha256", "areaProofSha256"], label);
  identifier(identity.sourceLayerId, `${label}.sourceLayerId`); if (identity.sourceLayerIndex !== 0 || identity.sourceGeometryKeyframes !== "absent") fail(`${label} target binding/presence is invalid.`);
  for (const key of ["sourceGeometrySha256", "materializedGeometryKeyframesSha256", "endpointSequenceSha256", "topologySha256", "areaProofSha256"] as const) hash(identity[key], `${label}.${key}`);
  return frozen({ sourceLayerId: identity.sourceLayerId as string, sourceLayerIndex: 0 as const, sourceGeometrySha256: identity.sourceGeometrySha256 as string, sourceGeometryKeyframes: "absent" as const, materializedGeometryKeyframesSha256: identity.materializedGeometryKeyframesSha256 as string, endpointSequenceSha256: identity.endpointSequenceSha256 as string, topologySha256: identity.topologySha256 as string, areaProofSha256: identity.areaProofSha256 as string });
}
function projectionIdentity(plan: C6B6bPlanEvidence): C6B6bProjectionIdentity { return frozen({ sourceLayerId: plan.objectLayerBinding.layerId, sourceLayerIndex: 0 as const, sourceGeometrySha256: plan.projection.staticGeometry.sha256, sourceGeometryKeyframes: "absent" as const, materializedGeometryKeyframesSha256: canonicalJsonSha256(plan.projection.geometryKeyframes), endpointSequenceSha256: canonicalJsonSha256(plan.projection.endpoints), topologySha256: canonicalJsonSha256(plan.projection.topology), areaProofSha256: canonicalJsonSha256(plan.projection.areaProof) }); }
function assertPlanBaseEvidence(plan: C6B6bPlanEvidence, base: C6B6bExactBase): void {
  const projection = projectionIdentity(plan);
  if (plan.base.package.id !== base.packageId || plan.base.manifest.sha256 !== base.manifestCanonicalSha256 || plan.base.canonicalMotion.sha256 !== base.motionCanonicalSha256 || plan.base.persistedMotion.sha256 !== base.motionRawSha256 || plan.fingerprint !== base.planFingerprint || plan.lowererProfile.fingerprint !== base.profileFingerprint || plan.storyboard.id !== base.storyboardId || plan.storyboard.sha256 !== base.storyboardSha256 || plan.storyboard.revision !== base.storyboardRevision || base.sourceLayerId !== projection.sourceLayerId || base.sourceLayerIndex !== projection.sourceLayerIndex || base.sourceGeometrySha256 !== projection.sourceGeometrySha256 || base.sourceGeometryKeyframes !== "absent" || base.materializedGeometryKeyframesSha256 !== projection.materializedGeometryKeyframesSha256) fail("C6B6b exact base does not bind its complete B6a plan/projection.");
}
function readOutput(value: unknown, expected: C6B6bExactBase) {
  const output = record(value, ["packageId", "manifestRawSha256", "manifestCanonicalSha256", "motionRawSha256", "canonicalMotionSha256", "nonReceiptInventory", "preservedLeaves", "changed"], "C6B6b receipt output");
  identifier(output.packageId, "C6B6b receipt output.packageId"); for (const key of ["manifestRawSha256", "manifestCanonicalSha256", "motionRawSha256", "canonicalMotionSha256"] as const) hash(output[key], `C6B6b receipt output.${key}`);
  if (output.packageId !== expected.packageId || output.manifestRawSha256 !== expected.manifestRawSha256 || output.manifestCanonicalSha256 !== expected.manifestCanonicalSha256 || output.canonicalMotionSha256 !== expected.outputCanonicalMotionSha256) fail("C6B6b receipt output package/Motion identity is inconsistent.");
  const nonReceiptInventory = readInventory(output.nonReceiptInventory, "C6B6b receipt output non-receipt inventory"), preservedLeaves = readPreservedLeaves(output.preservedLeaves, "C6B6b receipt output preserved leaves"), changed = record(output.changed, ["paths", "count", "motionPropertyPaths", "motionPropertyPathCount"], "C6B6b receipt output changed leaves");
  const paths = stringArray(changed.paths, "C6B6b receipt output changed paths", 2); if (paths.length !== 2 || !same(paths, fixedChangedPaths(paths.find((path) => path !== C6B6B_RECEIPT_PATH)!)) || changed.count !== 2 || !same(changed.motionPropertyPaths, [C6B6B_LOGICAL_MOTION_PATH]) || changed.motionPropertyPathCount !== 1) fail("C6B6b receipt output changed paths are invalid.");
  return frozen({ packageId: output.packageId as string, manifestRawSha256: output.manifestRawSha256 as string, manifestCanonicalSha256: output.manifestCanonicalSha256 as string, motionRawSha256: output.motionRawSha256 as string, canonicalMotionSha256: output.canonicalMotionSha256 as string, nonReceiptInventory, preservedLeaves, changed: frozen({ paths: fixedChangedPaths(paths.find((path) => path !== C6B6B_RECEIPT_PATH)!), count: 2 as const, motionPropertyPaths: [C6B6B_LOGICAL_MOTION_PATH] as const, motionPropertyPathCount: 1 as const }) });
}
function readTransaction(value: unknown) { const transaction = record(value, ["cow", "installed", "exclusiveReceipt", "workspaceCleanup"], "C6B6b receipt transaction"); if (transaction.cow !== "closed-inventory-finalize-after-edit" || transaction.installed !== true || transaction.exclusiveReceipt !== true || transaction.workspaceCleanup !== "not-attested") fail("C6B6b receipt transaction is invalid."); return frozen({ cow: "closed-inventory-finalize-after-edit" as const, installed: true as const, exclusiveReceipt: true as const, workspaceCleanup: "not-attested" as const }); }
function readRenderer(value: unknown) { const renderer = record(value, ["invoked", "pixels"], "C6B6b receipt renderer"); if (renderer.invoked !== false || renderer.pixels !== false) fail("C6B6b receipt renderer evidence is invalid."); return frozen({ invoked: false as const, pixels: false as const }); }
function readStoryboard(value: unknown): { readonly id: string; readonly sha256: string; readonly revision: number; readonly record: unknown } {
  try { const storyboard = readCheckpointStoryboard(value); return frozen({ id: storyboard.id, sha256: storyboard.sha256, revision: storyboard.revision, record: structuredClone(storyboard) }); }
  catch { fail("C6B6b receipt storyboard record is not a complete sealed C6A record."); }
}
function readGeometry(value: unknown, label: string): C6B6bGeometry {
  const geometry = record(value, ["schema", "kind", "viewBox", "points"], label); if (geometry.schema !== "shellx-motion/shape-geometry@1" || geometry.kind !== "polygon") fail(`${label} is not v1 polygon geometry.`);
  const viewBox = record(geometry.viewBox, ["x", "y", "width", "height"], `${label}.viewBox`), x = finite(viewBox.x, `${label}.viewBox.x`), y = finite(viewBox.y, `${label}.viewBox.y`), width = finite(viewBox.width, `${label}.viewBox.width`), height = finite(viewBox.height, `${label}.viewBox.height`);
  if (width <= 0 || height <= 0) fail(`${label} viewBox is invalid.`);
  const points = tuple(geometry.points, 3, `${label}.points`).map((point, index) => { const entry = record(point, ["x", "y"], `${label}.points[${index}]`); return frozen({ x: finite(entry.x, `${label}.points[${index}].x`), y: finite(entry.y, `${label}.points[${index}].y`) }); }) as unknown as C6B6bGeometry["points"];
  return frozen({ schema: "shellx-motion/shape-geometry@1", kind: "polygon", viewBox: frozen({ x, y, width, height }), points });
}
function readInventory(value: unknown, label: string): C6B6bInventory { const inventory = record(value, ["sha256", "entryCount", "leafCount"], label); hash(inventory.sha256, `${label}.sha256`); return frozen({ sha256: inventory.sha256 as string, entryCount: nonNegative(inventory.entryCount, `${label}.entryCount`, MAX_INVENTORY_ENTRIES), leafCount: nonNegative(inventory.leafCount, `${label}.leafCount`, MAX_INVENTORY_ENTRIES) }); }
function readPreservedLeaves(value: unknown, label: string) { const leaves = record(value, ["sha256", "count"], label); hash(leaves.sha256, `${label}.sha256`); return frozen({ sha256: leaves.sha256 as string, count: nonNegative(leaves.count, `${label}.count`, MAX_INVENTORY_ENTRIES) }); }
function fixedChangedPaths(motionPath: string) { if (!safePackagePath(motionPath)) fail("C6B6b physical Motion path is invalid."); const paths = [motionPath, C6B6B_RECEIPT_PATH].sort(compareCodeUnits); return frozen(paths) as unknown as readonly [string, typeof C6B6B_RECEIPT_PATH] | readonly [typeof C6B6B_RECEIPT_PATH, string]; }
function record(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  const item = object(value, label), actual = Reflect.ownKeys(item);
  if (actual.length !== keys.length || actual.some((key) => typeof key !== "string" || !keys.includes(key)) || keys.some((key) => !actual.includes(key))) fail(`${label} has unsupported fields.`);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(item, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail(`${label}.${key} must be an enumerable data field.`);
  }
  return item as Record<string, unknown>;
}
function object(value: unknown, label: string): object { if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(`${label} is invalid.`); return value as object; }
function tuple(value: unknown, length: number, label: string): unknown[] { if (!Array.isArray(value) || value.length !== length || Reflect.ownKeys(value).length !== length + 1) fail(`${label} must be a dense ${length}-entry array.`); return value; }
function stringArray(value: unknown, label: string, maximum: number): readonly string[] { if (!Array.isArray(value) || value.length < 1 || value.length > maximum || value.some((item) => typeof item !== "string") || value.some((item, index) => index > 0 && compareCodeUnits(value[index - 1] as string, item as string) >= 0)) fail(`${label} is invalid.`); return frozen([...value]) as readonly string[]; }
function finiteArray(value: unknown, label: string, minimum: number, maximum: number): readonly number[] { if (!Array.isArray(value) || value.length < minimum || value.length > maximum) fail(`${label} is invalid.`); return frozen(value.map((entry, index) => finite(entry, `${label}[${index}]`))); }
function identifier(value: unknown, label: string): string { if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) fail(`${label} is invalid.`); return value; }
function storyboardIdentifier(value: unknown, label: string): string { if (typeof value !== "string" || !STORYBOARD_ID.test(value)) fail(`${label} is invalid.`); return value; }
function hash(value: unknown, label: string): string { if (typeof value !== "string" || !HASH.test(value)) fail(`${label} is invalid.`); return value; }
function positive(value: unknown, label: string, maximum: number): number { if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) fail(`${label} is invalid.`); return value as number; }
function nonNegative(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number { if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) fail(`${label} is invalid.`); return value as number; }
function finite(value: unknown, label: string): number { if (typeof value !== "number" || !Number.isFinite(value)) fail(`${label} is invalid.`); return Object.is(value, -0) ? 0 : value; }
function safePackagePath(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256 && value === value.normalize("NFC") && !value.startsWith("/") && !value.includes("\\") && !/[\u0000-\u001F\u007F-\u009F]/u.test(value) && value.split("/").every((segment) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment) && segment !== "." && segment !== ".."); }
function sameViewBox(left: C6B6bGeometry, right: C6B6bGeometry): boolean { return same(left.viewBox, right.viewBox); }
function delta(left: { readonly x: number; readonly y: number }, right: { readonly x: number; readonly y: number }) { return { x: left.x - right.x, y: left.y - right.y }; }
function cross(left: { readonly x: number; readonly y: number }, right: { readonly x: number; readonly y: number }): number { return left.x * right.y - left.y * right.x; }
function same(left: unknown, right: unknown): boolean { return canonicalJsonSha256(left) === canonicalJsonSha256(right); }
function frozen<T>(value: T, seen = new WeakSet<object>()): T { if (!value || typeof value !== "object" || seen.has(value as object)) return value; seen.add(value as object); for (const child of Object.values(value as Record<string, unknown>)) frozen(child, seen); return Object.freeze(value); }
function fail(message: string): never { throw new PackageEditTransactionError("copy_mismatch", message); }
