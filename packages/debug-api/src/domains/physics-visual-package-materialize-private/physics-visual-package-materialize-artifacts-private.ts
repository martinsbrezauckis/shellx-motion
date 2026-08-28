/** Canonical C7B4D recipe sidecar and identity-only package receipt. */
import { join } from "node:path";
import { canonicalJson, canonicalJsonSha256, hashBuffer, readBoundedStableFile, writeVerifiedBoundedFile } from "@shellx-motion/core";
import { PackageEditTransactionError } from "../package-edit-transaction.js";
import type { PhysicsBakeDurableReopenResult } from "../physics-bake-durable-private/physics-bake-durable-types-private.js";
import {
  C7B4D_ARTIFACT_ROOT,
  C7B4D_RECEIPT_PATH,
  C7B4D_SIDECAR_PATH,
  c7B4dSame,
  type C7B4dInventory,
  type C7B4dPackageDocuments,
  type C7B4dPackageIdentity,
} from "./physics-visual-package-materialize-facts-private.js";

const SIDECAR_SCHEMA = "shellx-motion/private-physics-visual-recipe-sidecar@1" as const;
const RECEIPT_SCHEMA = "shellx-motion/private-physics-visual-materialization-receipt@1" as const;
const RECEIPT_OPERATION = "physics-visual.materialize" as const;
const MAX_SIDECAR_BYTES = 16 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/u;

export interface PhysicsVisualPackageRecipeBundle {
  readonly physicsBake: unknown;
  readonly visualBinding: unknown;
  readonly retainedRender: unknown;
  readonly presentation: unknown;
}
export interface PhysicsVisualPackageArtifactIdentity {
  readonly manifestFingerprint: string;
  readonly receiptFingerprint: string;
  readonly planFingerprint: string;
  readonly recipeSha256: string;
  readonly providerResultFingerprint: string;
  readonly primaryBodyObservationId: string;
  readonly primaryBodyObservationSha256: string;
  readonly schedule: Readonly<{ startUs: number; endUs: number; stepsPerSecond: number; stepCount: number }>;
  readonly segmentInventorySha256: string;
  readonly inventoryContractSha256: string;
  readonly segmentCount: number;
  readonly segmentBytes: number;
}
export interface PhysicsVisualPackagePlanIdentities {
  readonly physicsPlanFingerprint: string;
  readonly physicsRecipeSha256: string;
  readonly visualBindingFingerprint: string;
  readonly visualBindingRecipeSha256: string;
  readonly retainedStaticFingerprint: string;
  readonly retainedRenderRecipeSha256: string;
  readonly presentationStaticFingerprint: string;
  readonly presentationRecipeSha256: string;
  readonly visualResourceFingerprint: string;
  readonly retainedResourceFingerprint: string;
  readonly presentationResourceFingerprint: string;
  readonly visualBindingsSha256: string;
  readonly presentationBindingsSha256: string;
  readonly retainedInstanceSlotsSha256: string;
  readonly presentationInstanceSlotsSha256: string;
  readonly scheduleSha256: string;
}
export interface PhysicsVisualPackageArtifactFileIdentity {
  readonly path: typeof C7B4D_SIDECAR_PATH;
  readonly rawSha256: string;
  readonly byteLength: number;
  readonly canonicalSha256: string;
}
export interface PhysicsVisualPackageSidecar {
  readonly schema: typeof SIDECAR_SCHEMA;
  readonly package: C7B4dPackageIdentity;
  readonly artifact: PhysicsVisualPackageArtifactIdentity;
  readonly recipes: PhysicsVisualPackageRecipeBundle;
  readonly plans: PhysicsVisualPackagePlanIdentities;
  readonly recipeBundleFingerprint: string;
  readonly evidence: Readonly<{
    canonicalRecipesOnly: true;
    externalArtifactEmbedded: true;
    decodedObservationsPersisted: false;
    compiledGeometryPersisted: false;
    framePlansPersisted: false;
    rendererInvoked: false;
    providerInvoked: false;
    videoInvoked: false;
  }>;
  readonly fingerprint: string;
}
export interface PhysicsVisualPackageExactBase {
  readonly sourcePackage: C7B4dPackageIdentity;
  readonly externalArtifact: PhysicsVisualPackageArtifactIdentity;
  readonly recipeBundleFingerprint: string;
  readonly plans: PhysicsVisualPackagePlanIdentities;
  readonly sourceArtifacts: Readonly<{ physicsBake: "absent"; sidecar: "absent"; receipt: "absent" }>;
}
export interface PhysicsVisualPackageMaterializationReceipt {
  readonly schema: typeof RECEIPT_SCHEMA;
  readonly operation: typeof RECEIPT_OPERATION;
  readonly status: "passed";
  readonly approval: Readonly<{ base: PhysicsVisualPackageExactBase }>;
  readonly output: Readonly<{
    package: C7B4dPackageIdentity;
    virtualSourceInventory: C7B4dInventory;
    nonMaterializationInventory: C7B4dInventory;
    preservedSourceLeaves: Readonly<{ sha256: string; count: number }>;
    createdDirectories: readonly string[];
    changed: Readonly<{ physicsBake: typeof C7B4D_ARTIFACT_ROOT; sidecar: typeof C7B4D_SIDECAR_PATH; receipt: typeof C7B4D_RECEIPT_PATH; manifestAndMotion: "unchanged" }>;
    sidecar: PhysicsVisualPackageArtifactFileIdentity;
    embeddedArtifact: PhysicsVisualPackageArtifactIdentity;
  }>;
  readonly transaction: Readonly<{ cow: "closed-inventory-finalize-after-edit"; installed: true; exclusiveArtifacts: true; workspaceCleanup: "not-attested" }>;
  readonly evidence: Readonly<{ rendererInvoked: false; pixels: false; providerInvoked: false; videoInvoked: false }>;
  readonly fingerprint: string;
}

export function durableArtifactIdentity(value: PhysicsBakeDurableReopenResult): PhysicsVisualPackageArtifactIdentity {
  const { manifest, receipt } = value;
  const primary = manifest.bodyObservations.find((entry) => entry.id === manifest.primaryBodyObservationId);
  if (!primary) throw new PackageEditTransactionError("copy_mismatch", "C7B4D C7B3 artifact has no primary body observation identity.");
  return freeze({
    manifestFingerprint: manifest.fingerprint,
    receiptFingerprint: receipt.fingerprint,
    planFingerprint: manifest.source.planFingerprint,
    recipeSha256: manifest.source.recipeSha256,
    providerResultFingerprint: manifest.source.resultFingerprint,
    primaryBodyObservationId: primary.id,
    primaryBodyObservationSha256: primary.sourceSha256,
    schedule: freeze({ ...manifest.schedule }),
    segmentInventorySha256: receipt.artifact.segmentInventorySha256,
    inventoryContractSha256: receipt.artifact.inventoryContractSha256,
    segmentCount: receipt.artifact.segmentCount,
    segmentBytes: receipt.artifact.segmentBytes,
  });
}

/** Canonical identity projection; plans themselves remain process-local compiler authority. */
export function physicsVisualPackagePlanIdentities(physics: any, visual: any, retained: any, presentation: any): PhysicsVisualPackagePlanIdentities {
  return freeze({
    physicsPlanFingerprint: physics.fingerprint,
    physicsRecipeSha256: physics.recipeSha256,
    visualBindingFingerprint: visual.fingerprint,
    visualBindingRecipeSha256: visual.recipeSha256,
    retainedStaticFingerprint: retained.fingerprint,
    retainedRenderRecipeSha256: retained.recipeSha256,
    presentationStaticFingerprint: presentation.fingerprint,
    presentationRecipeSha256: presentation.recipeSha256,
    visualResourceFingerprint: visual.resourceFingerprint,
    retainedResourceFingerprint: retained.source.compiledResourceFingerprint,
    presentationResourceFingerprint: presentation.resourceFingerprint,
    visualBindingsSha256: canonicalJsonSha256(visual.bindings),
    presentationBindingsSha256: canonicalJsonSha256({ staticCollisionBindings: presentation.recipe.staticCollisionBindings, constraintBindings: presentation.recipe.constraintBindings, presentationBindings: presentation.recipe.presentationBindings }),
    retainedInstanceSlotsSha256: canonicalJsonSha256(retained.instanceSlots),
    presentationInstanceSlotsSha256: canonicalJsonSha256(presentation.instanceSlots),
    scheduleSha256: canonicalJsonSha256({ physics: physics.schedule, visual: visual.schedule }),
  });
}

export function createPhysicsVisualPackageSidecar(input: Omit<PhysicsVisualPackageSidecar, "schema" | "recipeBundleFingerprint" | "evidence" | "fingerprint">): PhysicsVisualPackageSidecar {
  const recipes = freeze({ ...input.recipes });
  const payload = {
    schema: SIDECAR_SCHEMA,
    package: input.package,
    artifact: input.artifact,
    recipes,
    plans: input.plans,
    recipeBundleFingerprint: canonicalJsonSha256(recipes),
    evidence: freeze({ canonicalRecipesOnly: true as const, externalArtifactEmbedded: true as const, decodedObservationsPersisted: false as const, compiledGeometryPersisted: false as const, framePlansPersisted: false as const, rendererInvoked: false as const, providerInvoked: false as const, videoInvoked: false as const }),
  };
  return readPhysicsVisualPackageSidecarValue({ ...payload, fingerprint: canonicalJsonSha256(payload) });
}

export function exactPhysicsVisualPackageBase(sourcePackage: C7B4dPackageIdentity, artifact: PhysicsVisualPackageArtifactIdentity, sidecar: PhysicsVisualPackageSidecar): PhysicsVisualPackageExactBase {
  return freeze({ sourcePackage, externalArtifact: artifact, recipeBundleFingerprint: sidecar.recipeBundleFingerprint, plans: sidecar.plans, sourceArtifacts: freeze({ physicsBake: "absent" as const, sidecar: "absent" as const, receipt: "absent" as const }) });
}

export function physicsVisualPackageSidecarIdentity(sidecar: PhysicsVisualPackageSidecar): PhysicsVisualPackageArtifactFileIdentity {
  const bytes = sidecarBytes(sidecar);
  return freeze({ path: C7B4D_SIDECAR_PATH, rawSha256: hashBuffer(bytes), byteLength: bytes.byteLength, canonicalSha256: canonicalJsonSha256(sidecar) });
}
export async function writePhysicsVisualPackageSidecar(root: string, sidecar: PhysicsVisualPackageSidecar): Promise<PhysicsVisualPackageArtifactFileIdentity> {
  const accepted = readPhysicsVisualPackageSidecarValue(sidecar), bytes = sidecarBytes(accepted), identity = physicsVisualPackageSidecarIdentity(accepted);
  try { await writeVerifiedBoundedFile(join(root, C7B4D_SIDECAR_PATH), bytes, { label: "C7B4D physics-visual recipe sidecar", maxBytes: MAX_SIDECAR_BYTES, withinRoot: root, expectedSha256: identity.rawSha256 }); }
  catch { throw new PackageEditTransactionError("copy_mismatch", "C7B4D sidecar could not be exclusively published."); }
  return identity;
}
export async function readPhysicsVisualPackageSidecar(root: string): Promise<PhysicsVisualPackageSidecar> {
  const file = await readBoundedStableFile(join(root, C7B4D_SIDECAR_PATH), { label: "C7B4D physics-visual recipe sidecar", maxBytes: MAX_SIDECAR_BYTES, withinRoot: root, requireSingleLink: true });
  let value: unknown; try { value = JSON.parse(file.bytes.toString("utf8")); } catch { throw new PackageEditTransactionError("copy_mismatch", "C7B4D sidecar is not JSON."); }
  const sidecar = readPhysicsVisualPackageSidecarValue(value);
  if (!file.bytes.equals(sidecarBytes(sidecar))) throw new PackageEditTransactionError("copy_mismatch", "C7B4D sidecar bytes are not canonical.");
  return sidecar;
}

export function createPhysicsVisualPackageReceipt(input: Omit<PhysicsVisualPackageMaterializationReceipt, "schema" | "operation" | "status" | "fingerprint">): PhysicsVisualPackageMaterializationReceipt {
  const payload = { schema: RECEIPT_SCHEMA, operation: RECEIPT_OPERATION, status: "passed" as const, ...input };
  return readPhysicsVisualPackageReceiptValue({ ...payload, fingerprint: canonicalJsonSha256(payload) });
}
export async function writePhysicsVisualPackageReceipt(root: string, receipt: PhysicsVisualPackageMaterializationReceipt): Promise<void> {
  const accepted = readPhysicsVisualPackageReceiptValue(receipt), bytes = Buffer.from(`${canonicalJson(accepted)}\n`, "utf8");
  if (bytes.byteLength > MAX_RECEIPT_BYTES) throw new PackageEditTransactionError("package_limit_exceeded", "C7B4D receipt exceeds 1 MiB.");
  try { await writeVerifiedBoundedFile(join(root, C7B4D_RECEIPT_PATH), bytes, { label: "C7B4D physics-visual materialization receipt", maxBytes: MAX_RECEIPT_BYTES, withinRoot: root }); }
  catch { throw new PackageEditTransactionError("copy_mismatch", "C7B4D receipt could not be exclusively published."); }
}
export async function readPhysicsVisualPackageReceipt(root: string): Promise<PhysicsVisualPackageMaterializationReceipt> {
  const file = await readBoundedStableFile(join(root, C7B4D_RECEIPT_PATH), { label: "C7B4D physics-visual materialization receipt", maxBytes: MAX_RECEIPT_BYTES, withinRoot: root, requireSingleLink: true });
  let value: unknown; try { value = JSON.parse(file.bytes.toString("utf8")); } catch { throw new PackageEditTransactionError("copy_mismatch", "C7B4D receipt is not JSON."); }
  const receipt = readPhysicsVisualPackageReceiptValue(value);
  if (!file.bytes.equals(Buffer.from(`${canonicalJson(receipt)}\n`, "utf8"))) throw new PackageEditTransactionError("copy_mismatch", "C7B4D receipt bytes are not canonical.");
  return receipt;
}

export function readPhysicsVisualPackageRecipeBundle(value: unknown): PhysicsVisualPackageRecipeBundle {
  const root = record(value, ["physicsBake", "visualBinding", "retainedRender", "presentation"], "C7B4D recipe bundle");
  return freeze({ physicsBake: root.physicsBake, visualBinding: root.visualBinding, retainedRender: root.retainedRender, presentation: root.presentation });
}
export function readPhysicsVisualPackageSidecarValue(value: unknown): PhysicsVisualPackageSidecar {
  const root = record(value, ["schema", "package", "artifact", "recipes", "plans", "recipeBundleFingerprint", "evidence", "fingerprint"], "C7B4D sidecar"), { fingerprint, ...payload } = root;
  if (root.schema !== SIDECAR_SCHEMA || !hash(fingerprint) || canonicalJsonSha256(payload) !== fingerprint) fail("C7B4D sidecar identity or fingerprint is invalid.");
  const recipes = readPhysicsVisualPackageRecipeBundle(root.recipes), plans = readPlans(root.plans), evidence = record(root.evidence, ["canonicalRecipesOnly", "externalArtifactEmbedded", "decodedObservationsPersisted", "compiledGeometryPersisted", "framePlansPersisted", "rendererInvoked", "providerInvoked", "videoInvoked"], "C7B4D sidecar evidence");
  if (!hash(root.recipeBundleFingerprint) || canonicalJsonSha256(recipes) !== root.recipeBundleFingerprint || !c7B4dSame(evidence, { canonicalRecipesOnly: true, externalArtifactEmbedded: true, decodedObservationsPersisted: false, compiledGeometryPersisted: false, framePlansPersisted: false, rendererInvoked: false, providerInvoked: false, videoInvoked: false })) fail("C7B4D sidecar widened data or execution authority.");
  return freeze({ schema: SIDECAR_SCHEMA, package: readPackageIdentity(root.package), artifact: readArtifact(root.artifact), recipes, plans, recipeBundleFingerprint: root.recipeBundleFingerprint, evidence: freeze({ canonicalRecipesOnly: true as const, externalArtifactEmbedded: true as const, decodedObservationsPersisted: false as const, compiledGeometryPersisted: false as const, framePlansPersisted: false as const, rendererInvoked: false as const, providerInvoked: false as const, videoInvoked: false as const }), fingerprint });
}
export function readPhysicsVisualPackageExactBase(value: unknown): PhysicsVisualPackageExactBase {
  const root = record(value, ["sourcePackage", "externalArtifact", "recipeBundleFingerprint", "plans", "sourceArtifacts"], "C7B4D exact base"), artifacts = record(root.sourceArtifacts, ["physicsBake", "sidecar", "receipt"], "C7B4D source artifacts");
  if (!hash(root.recipeBundleFingerprint) || !c7B4dSame(artifacts, { physicsBake: "absent", sidecar: "absent", receipt: "absent" })) fail("C7B4D exact base is invalid.");
  return freeze({ sourcePackage: readPackageIdentity(root.sourcePackage), externalArtifact: readArtifact(root.externalArtifact), recipeBundleFingerprint: root.recipeBundleFingerprint, plans: readPlans(root.plans), sourceArtifacts: freeze({ physicsBake: "absent" as const, sidecar: "absent" as const, receipt: "absent" as const }) });
}
export function readPhysicsVisualPackageReceiptValue(value: unknown): PhysicsVisualPackageMaterializationReceipt {
  const root = record(value, ["schema", "operation", "status", "approval", "output", "transaction", "evidence", "fingerprint"], "C7B4D receipt"), { fingerprint, ...payload } = root;
  if (root.schema !== RECEIPT_SCHEMA || root.operation !== RECEIPT_OPERATION || root.status !== "passed" || !hash(fingerprint) || canonicalJsonSha256(payload) !== fingerprint) fail("C7B4D receipt identity or fingerprint is invalid.");
  const approval = record(root.approval, ["base"], "C7B4D receipt approval"), output = record(root.output, ["package", "virtualSourceInventory", "nonMaterializationInventory", "preservedSourceLeaves", "createdDirectories", "changed", "sidecar", "embeddedArtifact"], "C7B4D receipt output"), transaction = record(root.transaction, ["cow", "installed", "exclusiveArtifacts", "workspaceCleanup"], "C7B4D receipt transaction"), evidence = record(root.evidence, ["rendererInvoked", "pixels", "providerInvoked", "videoInvoked"], "C7B4D receipt evidence");
  const base = readPhysicsVisualPackageExactBase(approval.base), packageIdentity = readPackageIdentity(output.package), virtualSourceInventory = readInventory(output.virtualSourceInventory), nonMaterializationInventory = readInventory(output.nonMaterializationInventory), preservedSourceLeaves = readPreserved(output.preservedSourceLeaves), createdDirectories = readStrings(output.createdDirectories), changed = record(output.changed, ["physicsBake", "sidecar", "receipt", "manifestAndMotion"], "C7B4D changed paths"), sidecar = readSidecarIdentity(output.sidecar), embeddedArtifact = readArtifact(output.embeddedArtifact);
  if (!c7B4dSame(base.sourcePackage.inventory, virtualSourceInventory) || !c7B4dSame(base.externalArtifact, embeddedArtifact) || !validCreatedDirectories(createdDirectories) || !c7B4dSame(changed, { physicsBake: C7B4D_ARTIFACT_ROOT, sidecar: C7B4D_SIDECAR_PATH, receipt: C7B4D_RECEIPT_PATH, manifestAndMotion: "unchanged" }) || !c7B4dSame(transaction, { cow: "closed-inventory-finalize-after-edit", installed: true, exclusiveArtifacts: true, workspaceCleanup: "not-attested" }) || !c7B4dSame(evidence, { rendererInvoked: false, pixels: false, providerInvoked: false, videoInvoked: false })) fail("C7B4D receipt widened package or execution authority.");
  return freeze({ schema: RECEIPT_SCHEMA, operation: RECEIPT_OPERATION, status: "passed" as const, approval: freeze({ base }), output: freeze({ package: packageIdentity, virtualSourceInventory, nonMaterializationInventory, preservedSourceLeaves, createdDirectories, changed: freeze({ physicsBake: C7B4D_ARTIFACT_ROOT, sidecar: C7B4D_SIDECAR_PATH, receipt: C7B4D_RECEIPT_PATH, manifestAndMotion: "unchanged" as const }), sidecar, embeddedArtifact }), transaction: freeze({ cow: "closed-inventory-finalize-after-edit" as const, installed: true as const, exclusiveArtifacts: true as const, workspaceCleanup: "not-attested" as const }), evidence: freeze({ rendererInvoked: false as const, pixels: false as const, providerInvoked: false as const, videoInvoked: false as const }), fingerprint });
}

function sidecarBytes(value: PhysicsVisualPackageSidecar): Buffer { const bytes = Buffer.from(`${canonicalJson(value)}\n`, "utf8"); if (bytes.byteLength > MAX_SIDECAR_BYTES) throw new PackageEditTransactionError("package_limit_exceeded", "C7B4D canonical recipe sidecar exceeds 16 MiB."); return bytes; }
function readPackageIdentity(value: unknown): C7B4dPackageIdentity { const root = record(value, ["packageId", "manifestRawSha256", "manifestCanonicalSha256", "motionRawSha256", "motionCanonicalSha256", "inventory"], "C7B4D package identity"); if (typeof root.packageId !== "string" || root.packageId.length < 1 || ![root.manifestRawSha256, root.manifestCanonicalSha256, root.motionRawSha256, root.motionCanonicalSha256].every(hash)) fail("C7B4D package identity is invalid."); return freeze({ packageId: root.packageId, manifestRawSha256: root.manifestRawSha256, manifestCanonicalSha256: root.manifestCanonicalSha256, motionRawSha256: root.motionRawSha256, motionCanonicalSha256: root.motionCanonicalSha256, inventory: readInventory(root.inventory) }); }
function readDocuments(value: unknown): C7B4dPackageDocuments { const root = record(value, ["packageId", "manifestRawSha256", "manifestCanonicalSha256", "motionRawSha256", "motionCanonicalSha256"], "C7B4D package documents"); if (typeof root.packageId !== "string" || root.packageId.length < 1 || ![root.manifestRawSha256, root.manifestCanonicalSha256, root.motionRawSha256, root.motionCanonicalSha256].every(hash)) fail("C7B4D package documents are invalid."); return freeze({ packageId: root.packageId, manifestRawSha256: root.manifestRawSha256, manifestCanonicalSha256: root.manifestCanonicalSha256, motionRawSha256: root.motionRawSha256, motionCanonicalSha256: root.motionCanonicalSha256 }); }
export function readPhysicsVisualPackageDocuments(value: unknown): C7B4dPackageDocuments { return readDocuments(value); }
function readInventory(value: unknown): C7B4dInventory { const root = record(value, ["sha256", "entryCount", "leafCount"], "C7B4D inventory"); if (!hash(root.sha256) || !integer(root.entryCount, 0) || !integer(root.leafCount, 0)) fail("C7B4D inventory is invalid."); return freeze({ sha256: root.sha256, entryCount: root.entryCount, leafCount: root.leafCount }); }
function readArtifact(value: unknown): PhysicsVisualPackageArtifactIdentity { const root = record(value, ["manifestFingerprint", "receiptFingerprint", "planFingerprint", "recipeSha256", "providerResultFingerprint", "primaryBodyObservationId", "primaryBodyObservationSha256", "schedule", "segmentInventorySha256", "inventoryContractSha256", "segmentCount", "segmentBytes"], "C7B4D durable artifact identity"), schedule = record(root.schedule, ["startUs", "endUs", "stepsPerSecond", "stepCount"], "C7B4D durable artifact schedule"); if (![root.manifestFingerprint, root.receiptFingerprint, root.planFingerprint, root.recipeSha256, root.providerResultFingerprint, root.primaryBodyObservationSha256, root.segmentInventorySha256, root.inventoryContractSha256].every(hash) || typeof root.primaryBodyObservationId !== "string" || root.primaryBodyObservationId.length < 1 || root.primaryBodyObservationId.length > 128 || !integer(schedule.startUs, 0) || !integer(schedule.endUs, schedule.startUs) || !integer(schedule.stepsPerSecond, 1) || !integer(schedule.stepCount, 1) || !integer(root.segmentCount, 0) || !integer(root.segmentBytes, 0)) fail("C7B4D durable artifact identity is invalid."); return freeze({ manifestFingerprint: root.manifestFingerprint, receiptFingerprint: root.receiptFingerprint, planFingerprint: root.planFingerprint, recipeSha256: root.recipeSha256, providerResultFingerprint: root.providerResultFingerprint, primaryBodyObservationId: root.primaryBodyObservationId, primaryBodyObservationSha256: root.primaryBodyObservationSha256, schedule: freeze({ startUs: schedule.startUs, endUs: schedule.endUs, stepsPerSecond: schedule.stepsPerSecond, stepCount: schedule.stepCount }), segmentInventorySha256: root.segmentInventorySha256, inventoryContractSha256: root.inventoryContractSha256, segmentCount: root.segmentCount, segmentBytes: root.segmentBytes }); }
function readPlans(value: unknown): PhysicsVisualPackagePlanIdentities { const root = record(value, ["physicsPlanFingerprint", "physicsRecipeSha256", "visualBindingFingerprint", "visualBindingRecipeSha256", "retainedStaticFingerprint", "retainedRenderRecipeSha256", "presentationStaticFingerprint", "presentationRecipeSha256", "visualResourceFingerprint", "retainedResourceFingerprint", "presentationResourceFingerprint", "visualBindingsSha256", "presentationBindingsSha256", "retainedInstanceSlotsSha256", "presentationInstanceSlotsSha256", "scheduleSha256"], "C7B4D plan identities"); if (!Object.values(root).every(hash)) fail("C7B4D plan identities are invalid."); return freeze(root as unknown as PhysicsVisualPackagePlanIdentities); }
function readSidecarIdentity(value: unknown): PhysicsVisualPackageArtifactFileIdentity { const root = record(value, ["path", "rawSha256", "byteLength", "canonicalSha256"], "C7B4D sidecar identity"); if (root.path !== C7B4D_SIDECAR_PATH || !hash(root.rawSha256) || !hash(root.canonicalSha256) || !integer(root.byteLength, 1) || root.byteLength > MAX_SIDECAR_BYTES) fail("C7B4D sidecar identity is invalid."); return freeze({ path: C7B4D_SIDECAR_PATH, rawSha256: root.rawSha256, byteLength: root.byteLength, canonicalSha256: root.canonicalSha256 }); }
function readPreserved(value: unknown): { readonly sha256: string; readonly count: number } { const root = record(value, ["sha256", "count"], "C7B4D preserved source leaves"); if (!hash(root.sha256) || !integer(root.count, 0)) fail("C7B4D preserved source leaves are invalid."); return freeze({ sha256: root.sha256, count: root.count }); }
function readStrings(value: unknown): readonly string[] { if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length < 1 || item.length > 512)) fail("C7B4D created directories are invalid."); return freeze([...value] as string[]); }
function validCreatedDirectories(value: readonly string[]): boolean { const allowed = ["analysis", C7B4D_ARTIFACT_ROOT, `${C7B4D_ARTIFACT_ROOT}/segments`, "analysis/scene-recipe", "receipts"]; return value.length <= allowed.length && value.every((item, index) => allowed.includes(item) && (index === 0 || value[index - 1]! < item)); }
function record(value: unknown, keys: readonly string[], label: string): Record<string, any> { if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(`${label} must be a plain object.`); const root = value as Record<string, unknown>, actual = Reflect.ownKeys(root); if (actual.length !== keys.length || !actual.every((key) => typeof key === "string" && keys.includes(key)) || !keys.every((key) => Object.hasOwn(root, key))) fail(`${label} has unsupported fields.`); return root; }
function hash(value: unknown): value is string { return typeof value === "string" && HASH.test(value); }
function integer(value: unknown, minimum: number): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum; }
function fail(message: string): never { throw new PackageEditTransactionError("copy_mismatch", message); }
function freeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value as object)) freeze(child); Object.freeze(value); } return value; }
