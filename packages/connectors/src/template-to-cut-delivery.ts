/** Private P2A delivery mechanics; not a connector package export. */
import { lstat, mkdir, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  activeScriptLayers,
  BoundedResourceBudget,
  canonicalJsonSha256,
  compareCodeUnits,
  DEFAULT_PACKAGE_ARCHIVE_WRITE_LIMITS,
  hashBuffer,
  readBoundedStableFile,
  verifyAttestedArtifactHandleReference,
  type MotionPackage,
  type OperationReceipt,
  type OutputDirectoryTransactionExpectedInventory
} from "@shellx-motion/core";
import type { ConnectorArtifact } from "./artifacts";
import { finalizeConnectorArtifactHandle } from "./artifact-handle";
import type { PrivateConnectorDelivery } from "./connector-delivery";
import type { AdmittedPackageTree } from "./bounded-package-copy";
export const TEMPLATE_CLOSED_DELIVERY_MAX_MEDIA_BYTES = 64 * 1024 * 1024;
const TEMPLATE_CLOSED_DELIVERY_MAX_PACKAGE_BYTES = 120 * 1024 * 1024;
const TEMPLATE_CLOSED_DELIVERY_METADATA_RESERVE_BYTES = 8 * 1024 * 1024;
const TEMPLATE_CLOSED_DELIVERY_MAX_FILES = 1_024;

export async function writeDeliveryJson(delivery: PrivateConnectorDelivery, path: string, value: unknown, exclusive = false): Promise<void> {
  assertNoPrivateDeliveryPath(value, delivery);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const bytes = jsonBytes(value);
  if (exclusive) {
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
    return;
  }
  await writeFile(path, bytes);
}

export function setReceiptOutputPath(receipt: OperationReceipt, path: string): void {
  if (!receipt.output || typeof receipt.output !== "object" || Array.isArray(receipt.output)) {
    throw new Error("Template-to-Cut render receipt has no mutable output record.");
  }
  (receipt.output as Record<string, unknown>).path = path;
}

/** P2A has one immutable Browser fulfillment and refuses every package mode that still needs a path-bound producer. */
export function assertP2APathlessExecutionInput(pkg: MotionPackage): void {
  if (activeScriptLayers(pkg.motion).length > 0) {
    throw new Error("Template-to-Cut accepted delivery refuses active agent scripts until their execution provenance is closed over the admitted package snapshot.");
  }
  const audioLayer = pkg.motion.layers.find((layer) => layer.type === "audio" || layer.includeAudio === true);
  if (audioLayer || pkg.motion.audio?.master) {
    throw new Error("Template-to-Cut accepted delivery refuses audio because P2A has no immutable admitted-package audio fulfillment.");
  }
  const gpuLayer = pkg.motion.layers.find((layer) => layer.type === "shader" || layer.type === "scene3d" || layer.type === "environment");
  if (gpuLayer) {
    throw new Error(`Template-to-Cut accepted delivery refuses ${gpuLayer.type} layer ${gpuLayer.id}: P2A has no closed GPU provenance.`);
  }
}

export function bindPackageTreeDigestToReceipt(receipt: OperationReceipt, treeSha256: string): void {
  const existing = receipt.inputHashes["admitted-package-tree"];
  if (existing !== undefined && existing !== treeSha256) {
    throw new Error("Template-to-Cut receipt conflicts with the immutable admitted package-tree identity.");
  }
  receipt.inputHashes = { "admitted-package-tree": treeSha256, ...receipt.inputHashes };
}

export function bindPackageTreeDigestToCutPlan(plan: { receipt: OperationReceipt }, treeSha256: string): void {
  bindPackageTreeDigestToReceipt(plan.receipt, treeSha256);
}

export function assertBrowserPreviewPackageTreeDigest(receipt: OperationReceipt, treeSha256: string): void {
  if (receipt.inputHashes["admitted-package-tree"] !== treeSha256) {
    throw new Error("Template-to-Cut browser preview did not attest the immutable admitted package-tree identity.");
  }
}

export function assertBrowserStreamingPackageTreeDigest(receipt: OperationReceipt, treeSha256: string): void {
  const output = plainRecord(receipt.output);
  const frameTransport = output ? plainRecord(output.frameTransport) : undefined;
  const producer = frameTransport ? plainRecord(frameTransport.producer) : undefined;
  const evidence = producer ? plainRecord(producer.evidence) : undefined;
  const union = evidence ? plainRecord(evidence.stableInputHashUnion) : undefined;
  const conflicts = evidence?.stableInputHashConflictKeys;
  if (!union || union["admitted-package-tree"] !== treeSha256
    || !Array.isArray(conflicts)
    || conflicts.some((entry) => entry === "admitted-package-tree")
    || evidence?.stableInputHashConflictKeysOmitted !== 0) {
    throw new Error("Template-to-Cut browser final render did not prove a conflict-free immutable admitted package-tree input.");
  }
}

/** Core exact trees infer parent directories from leaves, so source empty directories are not representable. */
export function assertClosedDeliveryPackageDirectories(tree: AdmittedPackageTree): void {
  const files = tree.evidence.entries.filter((entry) => entry.kind === "file").map((entry) => entry.path);
  for (const directory of tree.evidence.entries) {
    if (directory.kind !== "directory" || directory.path === "") continue;
    if (!files.some((path) => path.startsWith(`${directory.path}/`))) {
      throw new Error(`Template-to-Cut accepted delivery cannot represent empty package directory: ${directory.path}`);
    }
  }
}

/** Reserve every route-owned leaf before creating a delivery stage. */
export function assertP2AClosedTreeCapacity(tree: AdmittedPackageTree, renderRequired = true): void {
  const tooDeep = tree.evidence.entries.find((entry) => entry.kind === "file" && entry.path.split("/").length > 15);
  if (tooDeep) {
    throw new Error(`Template-to-Cut accepted delivery cannot place package/${tooDeep.path}: P1 permits at most 16 final root-relative path components.`);
  }
  const reservedLeaves = renderRequired ? 8 : 6;
  if (tree.evidence.fileCount + reservedLeaves > TEMPLATE_CLOSED_DELIVERY_MAX_FILES) {
    throw new Error(`Template-to-Cut accepted delivery reserves ${reservedLeaves} non-package leaves, so the admitted package may contain at most ${TEMPLATE_CLOSED_DELIVERY_MAX_FILES - reservedLeaves} files.`);
  }
  if (tree.evidence.aggregateBytes > TEMPLATE_CLOSED_DELIVERY_MAX_PACKAGE_BYTES) {
    throw new Error(`Template-to-Cut accepted delivery limits admitted package bytes to ${TEMPLATE_CLOSED_DELIVERY_MAX_PACKAGE_BYTES} so P1 can retain preview, media, and receipt leaves.`);
  }
  const reservedBytes = TEMPLATE_CLOSED_DELIVERY_MAX_MEDIA_BYTES
    + (renderRequired ? TEMPLATE_CLOSED_DELIVERY_MAX_MEDIA_BYTES : 0)
    + TEMPLATE_CLOSED_DELIVERY_METADATA_RESERVE_BYTES;
  if (tree.evidence.aggregateBytes + reservedBytes > 256 * 1024 * 1024) {
    throw new Error("Template-to-Cut accepted delivery cannot fit the exact P1 closed-tree aggregate limit.");
  }
}

/** Delete no tree recursively: this fixed, private, connector-owned directory must already be empty. */
export async function removeKnownEmptyPrivateDirectory(path: string, reason: string): Promise<void> {
  await rmdir(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return;
    if (error.code === "ENOTEMPTY" || error.code === "EEXIST") {
      throw new Error(`Template-to-Cut ${reason} left an unrepresentable private directory.`);
    }
    throw error;
  });
}

/** Build P2A's explicit code-owned leaves; Core performs the sole recursive closed-tree proof. */
export async function templateDeliveryExpectedInventory(input: {
  delivery: PrivateConnectorDelivery;
  admittedPackage: AdmittedPackageTree;
  templateApplyReceiptPath: string;
  templateReceipt: OperationReceipt;
  previewReceiptPath: string;
  previewReceipt: OperationReceipt;
  previewEvidence?: OutputDirectoryTransactionExpectedInventory[number];
  renderReceiptPath: string;
  renderReceipt: OperationReceipt;
  artifact?: Awaited<ReturnType<typeof finalizeConnectorArtifactHandle>>;
  cutPlanPath: string;
  cutPlan: unknown;
  connectorReceiptPath: string;
  connectorReceipt: OperationReceipt;
}): Promise<OutputDirectoryTransactionExpectedInventory> {
  const budget = new BoundedResourceBudget(DEFAULT_PACKAGE_ARCHIVE_WRITE_LIMITS, "Template-to-Cut accepted delivery");
  const entries: OutputDirectoryTransactionExpectedInventory[number][] = [];
  for (const entry of input.admittedPackage.evidence.entries) {
    if (entry.kind !== "file" || !entry.sha256 || entry.byteLength === undefined) continue;
    entries.push(knownDeliveryInventoryEntry(input.delivery, `package/${entry.path}`, entry.sha256, entry.byteLength, budget));
  }
  entries.push(
    knownJsonDeliveryInventoryEntry(input.delivery, input.templateApplyReceiptPath, input.templateReceipt, budget),
    knownJsonDeliveryInventoryEntry(input.delivery, input.previewReceiptPath, input.previewReceipt, budget),
    knownJsonDeliveryInventoryEntry(input.delivery, input.renderReceiptPath, input.renderReceipt, budget),
    knownJsonDeliveryInventoryEntry(input.delivery, input.cutPlanPath, input.cutPlan, budget),
    knownJsonDeliveryInventoryEntry(input.delivery, input.connectorReceiptPath, input.connectorReceipt, budget)
  );
  if (input.previewEvidence) entries.push(knownDeliveryInventoryEntry(input.delivery, input.previewEvidence.path, input.previewEvidence.sha256, input.previewEvidence.byteLength, budget));
  if (input.artifact) {
    const descriptor = await captureArtifactHandleDescriptorInventoryEntry(input.delivery, input.artifact);
    entries.push(
      knownDeliveryInventoryEntry(input.delivery, input.artifact.handle.rootRelativePath, input.artifact.handle.sha256, input.artifact.handle.byteLength, budget),
      knownDeliveryInventoryEntry(input.delivery, descriptor.path, descriptor.sha256, descriptor.byteLength, budget)
    );
  }
  return entries.sort((left, right) => compareCodeUnits(left.path, right.path));
}

/** Refuse a preview whose staged bytes no longer match the render receipt that names it. */
export async function captureReceiptBoundDeliveryLeaf(input: {
  delivery: PrivateConnectorDelivery;
  publicPath: string;
  receipt: OperationReceipt;
  label: string;
}): Promise<OutputDirectoryTransactionExpectedInventory[number]> {
  const expected = receiptOutputBinding(input.receipt, input.publicPath, input.label);
  const stagedPath = input.delivery.stagePath(input.publicPath);
  const captured = await readBoundedStableFile(stagedPath, {
    label: input.label,
    maxBytes: TEMPLATE_CLOSED_DELIVERY_MAX_MEDIA_BYTES,
    withinRoot: input.delivery.stagingRoot,
    requireSingleLink: true
  });
  if (captured.sha256 !== expected.sha256) {
    throw new Error(`${input.label} changed after its receipt was assembled.`);
  }
  return Object.freeze({
    path: relative(input.delivery.stagingRoot, stagedPath).split(sep).join("/"),
    sha256: expected.sha256,
    byteLength: captured.byteLength
  });
}

/** Candidate H/C/F consistency is verified before Core's one rename. */
export async function assertTemplateAcceptedDeliveryCandidate(input: {
  delivery: PrivateConnectorDelivery;
  sourcePackageRoot: string;
  artifacts: ConnectorArtifact[];
  connectorReceipt: OperationReceipt;
  stagedConnectorReceiptPath: string;
  renderReceipt: OperationReceipt;
  stagedRenderReceiptPath: string;
  cutPlan: unknown;
  finalizedArtifact?: Awaited<ReturnType<typeof finalizeConnectorArtifactHandle>>;
  stagedArtifactHandlePath: string;
  stagedRenderOutputPath: string;
  immutablePackageTreeSha256: string;
  packageId: string;
  motionId: string;
  operationHash: string;
}): Promise<void> {
  assertNoPrivateDeliveryPath({ connectorReceipt: input.connectorReceipt, renderReceipt: input.renderReceipt, cutPlan: input.cutPlan }, input.delivery);
  const accepted = input.connectorReceipt.status === "passed" || input.connectorReceipt.status === "warning";
  if (!accepted) return;
  assertReceiptPackageTreeDigest(input.connectorReceipt, input.immutablePackageTreeSha256, "connector receipt");
  assertReceiptPackageTreeDigest(input.renderReceipt, input.immutablePackageTreeSha256, "render receipt");
  assertCutPlanPackageTreeDigest(input.cutPlan, input.immutablePackageTreeSha256);
  for (const artifact of input.artifacts) {
    if (artifact.status !== "available") continue;
    const publicPath = resolve(artifact.path);
    if (publicPath === input.sourcePackageRoot || publicPath.startsWith(`${input.sourcePackageRoot}${sep}`)) {
      throw new Error("Template-to-Cut cannot advertise an external template source as an available delivery artifact.");
    }
    const facts = await lstat(input.delivery.stagePath(publicPath));
    const packageArtifact = artifact.role === "motion_package";
    if (facts.isSymbolicLink() || (packageArtifact ? !facts.isDirectory() : !facts.isFile())) {
      throw new Error(`Template-to-Cut accepted artifact is missing or unsafe: ${artifact.role}`);
    }
  }
  if (!input.finalizedArtifact) throw new Error("Template-to-Cut accepted rendered-media delivery is missing its final artifact handle.");
  const { handle, reference } = input.finalizedArtifact;
  const handleArtifact = input.artifacts.find((artifact) => artifact.role === "artifact_handle");
  if (!handleArtifact || handleArtifact.status !== "available") throw new Error("Template-to-Cut rendered-media delivery is missing its available artifact handle.");
  const expectedArtifactPath = relative(input.delivery.stagingRoot, input.stagedRenderOutputPath).split(sep).join("/");
  const expectedDescriptorPath = relative(input.delivery.stagingRoot, input.stagedArtifactHandlePath).split(sep).join("/");
  if (handle.rootRelativePath !== expectedArtifactPath || reference.rootRelativePath !== expectedDescriptorPath) {
    throw new Error("Template-to-Cut artifact handle does not bind the code-owned staged media and descriptor leaves.");
  }
  assertExactHandleReceipt(handle.receipts, "render", relative(input.delivery.stagingRoot, input.stagedRenderReceiptPath).split(sep).join("/"), hashBuffer(jsonBytes(input.renderReceipt)));
  assertExactHandleReceipt(handle.receipts, "connector", relative(input.delivery.stagingRoot, input.stagedConnectorReceiptPath).split(sep).join("/"), hashBuffer(jsonBytes(input.connectorReceipt)));
  await verifyAttestedArtifactHandleReference(input.delivery.stagingRoot, reference, {
    expected: { packageId: input.packageId, motionId: input.motionId, operationHash: input.operationHash },
    requiredReceiptRoles: ["render", "connector"],
    probe: false
  });
  const references = renderedMediaHandleReferences(input.cutPlan);
  if (references.length !== 1 || canonicalJsonSha256(references[0]) !== canonicalJsonSha256(reference)) {
    throw new Error("Template-to-Cut Cut plan does not bind the exact staged artifact handle.");
  }
}

export function remapPrivateDeliveryPaths<T>(value: T, delivery: PrivateConnectorDelivery): T {
  if (typeof value === "string") {
    return (value === delivery.stagingRoot
      ? delivery.publicRoot
      : value.startsWith(`${delivery.stagingRoot}${sep}`)
        ? `${delivery.publicRoot}${value.slice(delivery.stagingRoot.length)}`
        : value) as T;
  }
  if (Array.isArray(value)) return value.map((entry) => remapPrivateDeliveryPaths(entry, delivery)) as T;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => [key, remapPrivateDeliveryPaths(entry, delivery)])) as T;
  }
  return value;
}

export function assertNoPrivateDeliveryPath(value: unknown, delivery: PrivateConnectorDelivery): void {
  if (JSON.stringify(value).includes(delivery.stagingRoot)) {
    throw new Error("Template-to-Cut final delivery leaked a private staging path.");
  }
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function knownJsonDeliveryInventoryEntry(delivery: PrivateConnectorDelivery, publicPath: string, value: unknown, budget: BoundedResourceBudget): OutputDirectoryTransactionExpectedInventory[number] {
  const bytes = jsonBytes(value);
  return knownDeliveryInventoryEntry(delivery, relative(delivery.publicRoot, resolve(publicPath)).split(sep).join("/"), hashBuffer(bytes), bytes.byteLength, budget);
}

function knownDeliveryInventoryEntry(delivery: PrivateConnectorDelivery, rootRelativePath: string, sha256: string, byteLength: number, budget: BoundedResourceBudget): OutputDirectoryTransactionExpectedInventory[number] {
  const stagedPath = join(delivery.stagingRoot, ...rootRelativePath.split("/"));
  budget.reserve(stagedPath, byteLength, delivery.stagingRoot);
  return Object.freeze({ path: rootRelativePath, sha256, byteLength });
}

async function captureArtifactHandleDescriptorInventoryEntry(delivery: PrivateConnectorDelivery, artifact: Awaited<ReturnType<typeof finalizeConnectorArtifactHandle>>): Promise<OutputDirectoryTransactionExpectedInventory[number]> {
  const stagedPath = join(delivery.stagingRoot, ...artifact.reference.rootRelativePath.split("/"));
  const captured = await readBoundedStableFile(stagedPath, {
    label: "Template-to-Cut artifact-handle descriptor", maxBytes: 4 * 1024 * 1024,
    withinRoot: delivery.stagingRoot, requireSingleLink: true
  });
  if (captured.sha256 !== artifact.reference.sha256) {
    throw new Error("Template-to-Cut artifact-handle descriptor changed after its reference was assembled.");
  }
  return Object.freeze({ path: artifact.reference.rootRelativePath, sha256: artifact.reference.sha256, byteLength: captured.byteLength });
}

function receiptOutputBinding(receipt: OperationReceipt, publicPath: string, label: string): { sha256: string } {
  const record = plainRecord(receipt.output);
  if (resolve(String(record?.path ?? "")) !== resolve(publicPath) || typeof record?.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.sha256)) {
    throw new Error(`${label} receipt does not bind its code-owned output path and sha256.`);
  }
  return { sha256: record.sha256 };
}

function assertExactHandleReceipt(receipts: readonly { role: string; rootRelativePath: string; sha256: string }[], role: "render" | "connector", path: string, sha256: string): void {
  const receipt = receipts.find((entry) => entry.role === role);
  if (!receipt || receipt.rootRelativePath !== path || receipt.sha256 !== sha256) {
    throw new Error(`Template-to-Cut artifact handle does not attest the exact ${role} receipt candidate.`);
  }
}

function assertReceiptPackageTreeDigest(receipt: OperationReceipt, treeSha256: string, label: string): void {
  if (receipt.inputHashes["admitted-package-tree"] !== treeSha256) throw new Error(`Template-to-Cut ${label} does not bind the immutable admitted package-tree identity.`);
}

function assertCutPlanPackageTreeDigest(plan: unknown, treeSha256: string): void {
  const receipt = plainRecord(plainRecord(plan)?.receipt);
  const inputHashes = receipt ? plainRecord(receipt.inputHashes) : undefined;
  if (!inputHashes || inputHashes["admitted-package-tree"] !== treeSha256) throw new Error("Template-to-Cut Cut plan does not bind the immutable admitted package-tree identity.");
}

function renderedMediaHandleReferences(plan: unknown): unknown[] {
  const record = plainRecord(plan);
  if (!record || !Array.isArray(record.operations)) return [];
  return record.operations.flatMap((operation) => {
    const operationRecord = plainRecord(operation);
    if (operationRecord?.verb !== "cut.media.import_rendered") return [];
    const rendered = plainRecord(operationRecord.renderedMedia);
    return rendered?.handle ? [rendered.handle] : [];
  });
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
    ? value as Record<string, unknown>
    : undefined;
}
