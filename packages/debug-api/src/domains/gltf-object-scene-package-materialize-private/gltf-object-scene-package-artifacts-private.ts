/** Canonical C7A3f sidecar and receipt bytes. This module has no renderer or GPU authority. */
import { join } from "node:path";
import { canonicalJson, canonicalJsonSha256, hashBuffer, MAX_GLTF_SOURCE_BYTES, readBoundedStableFile, writeVerifiedBoundedFile } from "@shellx-motion/core";
import { PackageEditTransactionError } from "../package-edit-transaction.js";
import {
  C7A3F_RECEIPT_PATH,
  C7A3F_SIDECAR_PATH,
  c7A3fSame,
  type C7A3fInventory,
  type C7A3fPackageFacts,
  type C7A3fPackageIdentity,
  type C7A3fPlanIdentities,
  type C7A3fRecipeBundle,
  type C7A3fSourceIdentity,
  type CompiledC7A3fRecipeBundle,
} from "./gltf-object-scene-package-facts-private.js";

const SIDECAR_SCHEMA = "shellx-motion/private-gltf-object-scene-recipe-sidecar@1" as const;
const RECEIPT_SCHEMA = "shellx-motion/private-gltf-object-scene-materialization-receipt@1" as const;
const RECEIPT_OPERATION = "scene-recipe.gltf-object.materialize" as const;
const MAX_SIDECAR_BYTES = 4 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/u;

export interface C7A3fArtifactIdentity { readonly path: string; readonly rawSha256: string; readonly byteLength: number; readonly canonicalSha256: string }
export interface C7A3fSidecar {
  readonly schema: typeof SIDECAR_SCHEMA;
  readonly package: C7A3fPackageIdentity;
  readonly source: C7A3fSourceIdentity;
  readonly recipes: C7A3fRecipeBundle;
  readonly plans: C7A3fPlanIdentities;
  readonly recipeBundleFingerprint: string;
  readonly evidence: {
    readonly sourcePackageOwned: true;
    readonly canonicalRecipesOnly: true;
    readonly compiledGeometryPersisted: false;
    readonly evaluatedFramesPersisted: false;
    readonly rendererInvoked: false;
    readonly physicsInvoked: false;
  };
  readonly fingerprint: string;
}
export interface C7A3fExactBase {
  readonly source: C7A3fPackageIdentity;
  readonly sourceAsset: C7A3fSourceIdentity;
  readonly recipeBundleFingerprint: string;
  readonly plans: C7A3fPlanIdentities;
  readonly sourceArtifacts: { readonly sidecar: "absent"; readonly receipt: "absent" };
}
export interface GltfObjectScenePackageMaterializationReceipt {
  readonly schema: typeof RECEIPT_SCHEMA;
  readonly operation: typeof RECEIPT_OPERATION;
  readonly status: "passed";
  readonly approval: { readonly base: C7A3fExactBase };
  readonly output: {
    readonly package: C7A3fPackageIdentity;
    readonly virtualSourceInventory: C7A3fInventory;
    readonly nonMaterializationInventory: C7A3fInventory;
    readonly preservedLeaves: { readonly sha256: string; readonly count: number };
    readonly createdDirectories: readonly string[];
    readonly changed: { readonly paths: readonly [typeof C7A3F_SIDECAR_PATH, typeof C7A3F_RECEIPT_PATH]; readonly count: 2; readonly motionAndManifest: "unchanged"; readonly gltfSource: "unchanged" };
    readonly sidecar: C7A3fArtifactIdentity;
  };
  readonly transaction: { readonly cow: "closed-inventory-finalize-after-edit"; readonly installed: true; readonly exclusiveArtifacts: true; readonly workspaceCleanup: "not-attested" };
  readonly renderer: { readonly invoked: false; readonly pixels: false; readonly gpuAbi: "none"; readonly upload: "none" };
  readonly fingerprint: string;
}

export function createC7A3fSidecar(facts: C7A3fPackageFacts, compiled: CompiledC7A3fRecipeBundle): C7A3fSidecar {
  const payload = {
    schema: SIDECAR_SCHEMA,
    package: facts.base,
    source: facts.source,
    recipes: compiled.recipes,
    plans: compiled.plans,
    recipeBundleFingerprint: compiled.recipeBundleFingerprint,
    evidence: freeze({ sourcePackageOwned: true as const, canonicalRecipesOnly: true as const, compiledGeometryPersisted: false as const, evaluatedFramesPersisted: false as const, rendererInvoked: false as const, physicsInvoked: false as const }),
  };
  return readC7A3fSidecarValue({ ...payload, fingerprint: canonicalJsonSha256(payload) });
}

export function exactC7A3fBase(facts: C7A3fPackageFacts, compiled: CompiledC7A3fRecipeBundle): C7A3fExactBase {
  return freeze({ source: facts.base, sourceAsset: facts.source, recipeBundleFingerprint: compiled.recipeBundleFingerprint, plans: compiled.plans, sourceArtifacts: freeze({ sidecar: "absent" as const, receipt: "absent" as const }) });
}

export function c7A3fSidecarIdentity(sidecar: C7A3fSidecar): C7A3fArtifactIdentity {
  const bytes = sidecarBytes(sidecar);
  return freeze({ path: C7A3F_SIDECAR_PATH, rawSha256: hashBuffer(bytes), byteLength: bytes.byteLength, canonicalSha256: canonicalJsonSha256(sidecar) });
}

export async function writeC7A3fSidecar(root: string, sidecar: C7A3fSidecar): Promise<C7A3fArtifactIdentity> {
  const accepted = readC7A3fSidecarValue(sidecar), bytes = sidecarBytes(accepted), identity = c7A3fSidecarIdentity(accepted);
  try { await writeVerifiedBoundedFile(join(root, C7A3F_SIDECAR_PATH), bytes, { label: "C7A3f imported-object recipe sidecar", maxBytes: MAX_SIDECAR_BYTES, withinRoot: root, expectedSha256: identity.rawSha256 }); }
  catch { throw new PackageEditTransactionError("copy_mismatch", "C7A3f sidecar could not be exclusively published."); }
  return identity;
}

export async function readC7A3fSidecar(root: string): Promise<C7A3fSidecar> {
  const file = await readBoundedStableFile(join(root, C7A3F_SIDECAR_PATH), { label: "C7A3f imported-object recipe sidecar", maxBytes: MAX_SIDECAR_BYTES, withinRoot: root, requireSingleLink: true });
  let value: unknown; try { value = JSON.parse(file.bytes.toString("utf8")); } catch { throw new PackageEditTransactionError("copy_mismatch", "C7A3f sidecar is not JSON."); }
  const sidecar = readC7A3fSidecarValue(value);
  if (!file.bytes.equals(sidecarBytes(sidecar))) throw new PackageEditTransactionError("copy_mismatch", "C7A3f sidecar bytes are not canonical.");
  return sidecar;
}

export function createC7A3fReceipt(input: Omit<GltfObjectScenePackageMaterializationReceipt, "schema" | "operation" | "status" | "fingerprint">): GltfObjectScenePackageMaterializationReceipt {
  const payload = { schema: RECEIPT_SCHEMA, operation: RECEIPT_OPERATION, status: "passed" as const, ...input };
  return readC7A3fReceiptValue({ ...payload, fingerprint: canonicalJsonSha256(payload) });
}

export async function writeC7A3fReceipt(root: string, receipt: GltfObjectScenePackageMaterializationReceipt): Promise<void> {
  const accepted = readC7A3fReceiptValue(receipt), bytes = Buffer.from(`${canonicalJson(accepted)}\n`, "utf8");
  if (bytes.byteLength > MAX_RECEIPT_BYTES) throw new PackageEditTransactionError("package_limit_exceeded", "C7A3f receipt exceeds 1 MiB.");
  try { await writeVerifiedBoundedFile(join(root, C7A3F_RECEIPT_PATH), bytes, { label: "C7A3f imported-object recipe receipt", maxBytes: MAX_RECEIPT_BYTES, withinRoot: root }); }
  catch { throw new PackageEditTransactionError("copy_mismatch", "C7A3f receipt could not be exclusively published."); }
}

export async function readC7A3fReceipt(root: string): Promise<GltfObjectScenePackageMaterializationReceipt> {
  const file = await readBoundedStableFile(join(root, C7A3F_RECEIPT_PATH), { label: "C7A3f imported-object recipe receipt", maxBytes: MAX_RECEIPT_BYTES, withinRoot: root, requireSingleLink: true });
  let value: unknown; try { value = JSON.parse(file.bytes.toString("utf8")); } catch { throw new PackageEditTransactionError("copy_mismatch", "C7A3f receipt is not JSON."); }
  const receipt = readC7A3fReceiptValue(value), bytes = Buffer.from(`${canonicalJson(receipt)}\n`, "utf8");
  if (!file.bytes.equals(bytes)) throw new PackageEditTransactionError("copy_mismatch", "C7A3f receipt bytes are not canonical.");
  return receipt;
}

export function readC7A3fSidecarValue(value: unknown): C7A3fSidecar {
  const root = record(value, ["schema", "package", "source", "recipes", "plans", "recipeBundleFingerprint", "evidence", "fingerprint"], "C7A3f sidecar"), { fingerprint, ...payload } = root;
  if (root.schema !== SIDECAR_SCHEMA || !hash(fingerprint) || canonicalJsonSha256(payload) !== fingerprint) fail("C7A3f sidecar identity or fingerprint is invalid.");
  const recipes = record(root.recipes, ["declaration", "story", "scene", "evaluation", "retainedRender"], "C7A3f recipes"), plans = readPlans(root.plans), evidence = record(root.evidence, ["sourcePackageOwned", "canonicalRecipesOnly", "compiledGeometryPersisted", "evaluatedFramesPersisted", "rendererInvoked", "physicsInvoked"], "C7A3f sidecar evidence");
  if (!hash(root.recipeBundleFingerprint) || canonicalJsonSha256(recipes) !== root.recipeBundleFingerprint || !c7A3fSame(evidence, { sourcePackageOwned: true, canonicalRecipesOnly: true, compiledGeometryPersisted: false, evaluatedFramesPersisted: false, rendererInvoked: false, physicsInvoked: false })) fail("C7A3f sidecar recipes or authority evidence is invalid.");
  return freeze({ schema: SIDECAR_SCHEMA, package: readPackageIdentity(root.package), source: readSourceIdentity(root.source), recipes: freeze(recipes) as unknown as C7A3fRecipeBundle, plans, recipeBundleFingerprint: root.recipeBundleFingerprint, evidence: freeze({ sourcePackageOwned: true as const, canonicalRecipesOnly: true as const, compiledGeometryPersisted: false as const, evaluatedFramesPersisted: false as const, rendererInvoked: false as const, physicsInvoked: false as const }), fingerprint });
}

export function readC7A3fExactBase(value: unknown): C7A3fExactBase {
  const root = record(value, ["source", "sourceAsset", "recipeBundleFingerprint", "plans", "sourceArtifacts"], "C7A3f exact base"), artifacts = record(root.sourceArtifacts, ["sidecar", "receipt"], "C7A3f source artifacts");
  if (!hash(root.recipeBundleFingerprint) || !c7A3fSame(artifacts, { sidecar: "absent", receipt: "absent" })) fail("C7A3f exact base is invalid.");
  return freeze({ source: readPackageIdentity(root.source), sourceAsset: readSourceIdentity(root.sourceAsset), recipeBundleFingerprint: root.recipeBundleFingerprint, plans: readPlans(root.plans), sourceArtifacts: freeze({ sidecar: "absent" as const, receipt: "absent" as const }) });
}

export function readC7A3fReceiptValue(value: unknown): GltfObjectScenePackageMaterializationReceipt {
  const root = record(value, ["schema", "operation", "status", "approval", "output", "transaction", "renderer", "fingerprint"], "C7A3f receipt"), { fingerprint, ...payload } = root;
  if (root.schema !== RECEIPT_SCHEMA || root.operation !== RECEIPT_OPERATION || root.status !== "passed" || !hash(fingerprint) || canonicalJsonSha256(payload) !== fingerprint) fail("C7A3f receipt identity or fingerprint is invalid.");
  const approval = record(root.approval, ["base"], "C7A3f receipt approval"), output = record(root.output, ["package", "virtualSourceInventory", "nonMaterializationInventory", "preservedLeaves", "createdDirectories", "changed", "sidecar"], "C7A3f receipt output"), transaction = record(root.transaction, ["cow", "installed", "exclusiveArtifacts", "workspaceCleanup"], "C7A3f transaction"), renderer = record(root.renderer, ["invoked", "pixels", "gpuAbi", "upload"], "C7A3f renderer evidence");
  const base = readC7A3fExactBase(approval.base), packageIdentity = readPackageIdentity(output.package), virtualSourceInventory = readInventory(output.virtualSourceInventory), nonMaterializationInventory = readInventory(output.nonMaterializationInventory), preservedLeaves = readPreserved(output.preservedLeaves), createdDirectories = readStrings(output.createdDirectories), changed = record(output.changed, ["paths", "count", "motionAndManifest", "gltfSource"], "C7A3f changed paths"), sidecar = readArtifact(output.sidecar);
  if (!c7A3fSame(base.source.inventory, virtualSourceInventory) || sidecar.path !== C7A3F_SIDECAR_PATH || !validCreatedDirectories(createdDirectories) || !c7A3fSame(changed, { paths: [C7A3F_SIDECAR_PATH, C7A3F_RECEIPT_PATH], count: 2, motionAndManifest: "unchanged", gltfSource: "unchanged" }) || !c7A3fSame(transaction, { cow: "closed-inventory-finalize-after-edit", installed: true, exclusiveArtifacts: true, workspaceCleanup: "not-attested" }) || !c7A3fSame(renderer, { invoked: false, pixels: false, gpuAbi: "none", upload: "none" })) fail("C7A3f receipt widened package, transaction or renderer authority.");
  return freeze({ schema: RECEIPT_SCHEMA, operation: RECEIPT_OPERATION, status: "passed" as const, approval: freeze({ base }), output: freeze({ package: packageIdentity, virtualSourceInventory, nonMaterializationInventory, preservedLeaves, createdDirectories, changed: freeze({ paths: [C7A3F_SIDECAR_PATH, C7A3F_RECEIPT_PATH] as const, count: 2 as const, motionAndManifest: "unchanged" as const, gltfSource: "unchanged" as const }), sidecar }), transaction: freeze({ cow: "closed-inventory-finalize-after-edit" as const, installed: true as const, exclusiveArtifacts: true as const, workspaceCleanup: "not-attested" as const }), renderer: freeze({ invoked: false as const, pixels: false as const, gpuAbi: "none" as const, upload: "none" as const }), fingerprint });
}

function sidecarBytes(sidecar: C7A3fSidecar): Buffer { const bytes = Buffer.from(`${canonicalJson(sidecar)}\n`, "utf8"); if (bytes.byteLength > MAX_SIDECAR_BYTES) throw new PackageEditTransactionError("package_limit_exceeded", "C7A3f canonical recipe sidecar exceeds 4 MiB."); return bytes; }
function readPackageIdentity(value: unknown): C7A3fPackageIdentity { const root = record(value, ["packageId", "manifestRawSha256", "manifestCanonicalSha256", "motionRawSha256", "motionCanonicalSha256", "inventory"], "C7A3f package identity"); if (typeof root.packageId !== "string" || root.packageId.length < 1 || ![root.manifestRawSha256, root.manifestCanonicalSha256, root.motionRawSha256, root.motionCanonicalSha256].every(hash)) fail("C7A3f package identity is invalid."); return freeze({ packageId: root.packageId, manifestRawSha256: root.manifestRawSha256, manifestCanonicalSha256: root.manifestCanonicalSha256, motionRawSha256: root.motionRawSha256, motionCanonicalSha256: root.motionCanonicalSha256, inventory: readInventory(root.inventory) }); }
function readSourceIdentity(value: unknown): C7A3fSourceIdentity { const root = record(value, ["assetRef", "format", "sha256", "jsonSha256", "bufferSha256", "byteLength"], "C7A3f source identity"); if (typeof root.assetRef !== "string" || root.assetRef.length < 1 || root.assetRef.length > 512 || (root.format !== "gltf" && root.format !== "glb") || !hash(root.sha256) || !hash(root.jsonSha256) || !Array.isArray(root.bufferSha256) || root.bufferSha256.some((item) => !hash(item)) || typeof root.byteLength !== "number" || !Number.isSafeInteger(root.byteLength) || root.byteLength < 1 || root.byteLength > MAX_GLTF_SOURCE_BYTES) fail("C7A3f source identity is invalid."); return freeze({ assetRef: root.assetRef, format: root.format, sha256: root.sha256, jsonSha256: root.jsonSha256, bufferSha256: freeze([...root.bufferSha256]), byteLength: root.byteLength }); }
function readPlans(value: unknown): C7A3fPlanIdentities { const root = record(value, ["objectFingerprint", "storyFingerprint", "sceneFingerprint", "evaluationFingerprint", "retainedRenderFingerprint"], "C7A3f plan identities"); if (![root.objectFingerprint, root.storyFingerprint, root.sceneFingerprint, root.evaluationFingerprint, root.retainedRenderFingerprint].every(hash)) fail("C7A3f plan identities are invalid."); return freeze({ objectFingerprint: root.objectFingerprint, storyFingerprint: root.storyFingerprint, sceneFingerprint: root.sceneFingerprint, evaluationFingerprint: root.evaluationFingerprint, retainedRenderFingerprint: root.retainedRenderFingerprint }); }
function readInventory(value: unknown): C7A3fInventory { const root = record(value, ["sha256", "entryCount", "leafCount"], "C7A3f inventory"); if (!hash(root.sha256) || typeof root.entryCount !== "number" || !Number.isSafeInteger(root.entryCount) || root.entryCount < 0 || typeof root.leafCount !== "number" || !Number.isSafeInteger(root.leafCount) || root.leafCount < 0) fail("C7A3f inventory is invalid."); return freeze({ sha256: root.sha256, entryCount: root.entryCount, leafCount: root.leafCount }); }
function readPreserved(value: unknown): { readonly sha256: string; readonly count: number } { const root = record(value, ["sha256", "count"], "C7A3f preserved leaves"); if (!hash(root.sha256) || typeof root.count !== "number" || !Number.isSafeInteger(root.count) || root.count < 0) fail("C7A3f preserved leaves are invalid."); return freeze({ sha256: root.sha256, count: root.count }); }
function readArtifact(value: unknown): C7A3fArtifactIdentity { const root = record(value, ["path", "rawSha256", "byteLength", "canonicalSha256"], "C7A3f sidecar identity"); if (typeof root.path !== "string" || !hash(root.rawSha256) || !hash(root.canonicalSha256) || typeof root.byteLength !== "number" || !Number.isSafeInteger(root.byteLength) || root.byteLength < 1 || root.byteLength > MAX_SIDECAR_BYTES) fail("C7A3f sidecar identity is invalid."); return freeze({ path: root.path, rawSha256: root.rawSha256, byteLength: root.byteLength, canonicalSha256: root.canonicalSha256 }); }
function readStrings(value: unknown): readonly string[] { if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length < 1 || item.length > 512)) fail("C7A3f created directories are invalid."); return freeze([...value] as string[]); }
function validCreatedDirectories(value: readonly string[]): boolean { const allowed = ["analysis", "analysis/scene-recipe", "receipts"]; return value.length <= allowed.length && value.every((item, index) => allowed.includes(item) && (index === 0 || value[index - 1]! < item)); }
function record(value: unknown, keys: readonly string[], label: string): Record<string, any> { if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(`${label} must be a plain object.`); const root = value as Record<string, unknown>, actual = Reflect.ownKeys(root); if (actual.length !== keys.length || !actual.every((key) => typeof key === "string" && keys.includes(key)) || !keys.every((key) => Object.hasOwn(root, key))) fail(`${label} has unsupported fields.`); return root; }
function hash(value: unknown): value is string { return typeof value === "string" && HASH.test(value); }
function fail(message: string): never { throw new PackageEditTransactionError("copy_mismatch", message); }
function freeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value as object)) freeze(child); Object.freeze(value); } return value; }
