/** Private P2B F/H/C and exact-inventory validation. */
import { lstat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { BoundedResourceBudget, canonicalJsonSha256, compareCodeUnits, DEFAULT_PACKAGE_ARCHIVE_WRITE_LIMITS, hashBuffer, verifyAttestedArtifactHandleReference, type OutputDirectoryTransactionExpectedInventory } from "@shellx-motion/core";
import type { ConnectorArtifact } from "./artifacts";
import type { FinalizedConnectorArtifactHandle } from "./artifact-handle";
import type { AdmittedPackageTree } from "./bounded-package-copy";
import type { PrivateConnectorDelivery } from "./connector-delivery";
import { assertNoP2BPrivateDeliveryPath, captureP2BDeliveryLeaf, p2bJsonBytes, p2bPlainRecord } from "./p2b-connector-delivery";

/** Validate F/H/C and every advertised available output before the one Core commit. */
export async function assertP2BAcceptedDeliveryCandidate(input: {
  delivery: PrivateConnectorDelivery; artifacts: ConnectorArtifact[]; connectorReceipt: { status: string; inputHashes: Record<string, string>; output: unknown }; stagedConnectorReceiptPath: string;
  renderReceipt: { inputHashes: Record<string, string>; output: unknown }; stagedRenderReceiptPath: string; cutPlan: unknown; finalizedArtifact: FinalizedConnectorArtifactHandle;
  stagedArtifactHandlePath: string; stagedRenderOutputPath: string; immutablePackageTreeSha256: string; packageId: string; motionId: string; operationHash: string;
}): Promise<void> {
  assertNoP2BPrivateDeliveryPath({ connectorReceipt: input.connectorReceipt, renderReceipt: input.renderReceipt, cutPlan: input.cutPlan }, input.delivery);
  if (input.connectorReceipt.status !== "passed" && input.connectorReceipt.status !== "warning") throw new Error("P2B accepted delivery cannot publish a failed connector candidate.");
  assertReceiptPackageTreeDigest(input.connectorReceipt, input.immutablePackageTreeSha256, "connector receipt");
  assertReceiptPackageTreeDigest(input.renderReceipt, input.immutablePackageTreeSha256, "render receipt");
  assertCutPlanPackageTreeDigest(input.cutPlan, input.immutablePackageTreeSha256);
  for (const artifact of input.artifacts) {
    if (artifact.status !== "available") continue;
    const publicPath = resolve(artifact.path), relation = relative(input.delivery.publicRoot, publicPath);
    if (!relation || relation === ".." || relation.startsWith(`..${sep}`)) throw new Error(`P2B accepted artifact escapes its delivery root: ${artifact.role}`);
    const facts = await lstat(input.delivery.stagePath(publicPath));
    if (facts.isSymbolicLink() || (artifact.role === "motion_package" ? !facts.isDirectory() : !facts.isFile())) throw new Error(`P2B accepted artifact is missing or unsafe: ${artifact.role}`);
  }
  const { handle, reference } = input.finalizedArtifact;
  if (!input.artifacts.some((artifact) => artifact.role === "artifact_handle" && artifact.status === "available")) throw new Error("P2B rendered-media delivery is missing its available artifact handle.");
  const expectedArtifactPath = relative(input.delivery.stagingRoot, input.stagedRenderOutputPath).split(sep).join("/");
  const expectedDescriptorPath = relative(input.delivery.stagingRoot, input.stagedArtifactHandlePath).split(sep).join("/");
  if (handle.rootRelativePath !== expectedArtifactPath || reference.rootRelativePath !== expectedDescriptorPath) throw new Error("P2B artifact handle does not bind the code-owned staged media and descriptor leaves.");
  assertExactHandleReceipt(handle.receipts, "render", relative(input.delivery.stagingRoot, input.stagedRenderReceiptPath).split(sep).join("/"), hashBuffer(p2bJsonBytes(input.renderReceipt)));
  assertExactHandleReceipt(handle.receipts, "connector", relative(input.delivery.stagingRoot, input.stagedConnectorReceiptPath).split(sep).join("/"), hashBuffer(p2bJsonBytes(input.connectorReceipt)));
  await verifyAttestedArtifactHandleReference(input.delivery.stagingRoot, reference, { expected: { packageId: input.packageId, motionId: input.motionId, operationHash: input.operationHash }, requiredReceiptRoles: ["render", "connector"], probe: false });
  const references = renderedMediaHandleReferences(input.cutPlan);
  if (references.length !== 1 || canonicalJsonSha256(references[0]) !== canonicalJsonSha256(reference)) throw new Error("P2B Cut plan does not bind the exact staged artifact handle.");
}

export async function p2bDeliveryExpectedInventory(input: {
  delivery: PrivateConnectorDelivery; admittedPackage: AdmittedPackageTree; /** Source uses cut/package rather than the outer package root. */ packageDir: string;
  previewReceiptPath: string; previewReceipt: unknown; previewEvidence: OutputDirectoryTransactionExpectedInventory[number]; renderReceiptPath: string; renderReceipt: unknown;
  renderedMedia: OutputDirectoryTransactionExpectedInventory[number]; artifact: FinalizedConnectorArtifactHandle; cutPlanPath: string; cutPlan: unknown; connectorReceiptPath: string; connectorReceipt: unknown;
  extras?: readonly { path: string; value: unknown }[];
}): Promise<OutputDirectoryTransactionExpectedInventory> {
  const budget = new BoundedResourceBudget(DEFAULT_PACKAGE_ARCHIVE_WRITE_LIMITS, "P2B accepted delivery");
  const entries: OutputDirectoryTransactionExpectedInventory[number][] = [];
  for (const entry of input.admittedPackage.evidence.entries) {
    if (entry.kind !== "file" || !entry.sha256 || entry.byteLength === undefined) continue;
    entries.push(knownP2BDeliveryInventoryEntry(input.delivery, relative(input.delivery.publicRoot, join(input.packageDir, entry.path)).split(sep).join("/"), entry.sha256, entry.byteLength, budget));
  }
  entries.push(
    knownP2BJsonDeliveryInventoryEntry(input.delivery, input.previewReceiptPath, input.previewReceipt, budget), input.previewEvidence,
    knownP2BJsonDeliveryInventoryEntry(input.delivery, input.renderReceiptPath, input.renderReceipt, budget), input.renderedMedia,
    knownP2BJsonDeliveryInventoryEntry(input.delivery, input.cutPlanPath, input.cutPlan, budget), knownP2BJsonDeliveryInventoryEntry(input.delivery, input.connectorReceiptPath, input.connectorReceipt, budget),
    await captureP2BDeliveryLeaf({ delivery: input.delivery, publicPath: join(input.delivery.publicRoot, input.artifact.reference.rootRelativePath), label: "P2B artifact-handle descriptor", maxBytes: 4 * 1024 * 1024 })
  );
  for (const extra of input.extras ?? []) entries.push(knownP2BJsonDeliveryInventoryEntry(input.delivery, extra.path, extra.value, budget));
  return mergeP2BExpectedInventory(entries);
}

export function p2bJsonInventoryEntry(delivery: PrivateConnectorDelivery, path: string, value: unknown): OutputDirectoryTransactionExpectedInventory[number] {
  const bytes = p2bJsonBytes(value);
  return Object.freeze({ path: relative(delivery.publicRoot, resolve(path)).split(sep).join("/"), sha256: hashBuffer(bytes), byteLength: bytes.byteLength });
}

export function mergeP2BExpectedInventory(entries: readonly OutputDirectoryTransactionExpectedInventory[number][]): OutputDirectoryTransactionExpectedInventory {
  const paths = new Set<string>();
  for (const entry of entries) {
    if (paths.has(entry.path)) throw new Error(`P2B exact inventory contains duplicate path: ${entry.path}`);
    paths.add(entry.path);
  }
  return [...entries].sort((left, right) => compareCodeUnits(left.path, right.path));
}

function knownP2BJsonDeliveryInventoryEntry(delivery: PrivateConnectorDelivery, publicPath: string, value: unknown, budget: BoundedResourceBudget): OutputDirectoryTransactionExpectedInventory[number] {
  const bytes = p2bJsonBytes(value);
  return knownP2BDeliveryInventoryEntry(delivery, relative(delivery.publicRoot, resolve(publicPath)).split(sep).join("/"), hashBuffer(bytes), bytes.byteLength, budget);
}

function knownP2BDeliveryInventoryEntry(delivery: PrivateConnectorDelivery, rootRelativePath: string, sha256: string, byteLength: number, budget: BoundedResourceBudget): OutputDirectoryTransactionExpectedInventory[number] {
  budget.reserve(join(delivery.stagingRoot, ...rootRelativePath.split("/")), byteLength, delivery.stagingRoot);
  return Object.freeze({ path: rootRelativePath, sha256, byteLength });
}

function assertExactHandleReceipt(receipts: readonly { role: string; rootRelativePath: string; sha256: string }[], role: "render" | "connector", path: string, sha256: string): void {
  const receipt = receipts.find((entry) => entry.role === role);
  if (!receipt || receipt.rootRelativePath !== path || receipt.sha256 !== sha256) throw new Error(`P2B artifact handle does not attest the exact ${role} receipt candidate.`);
}

function assertReceiptPackageTreeDigest(receipt: { inputHashes: Record<string, string> }, treeSha256: string, label: string): void {
  if (receipt.inputHashes["admitted-package-tree"] !== treeSha256) throw new Error(`P2B ${label} does not bind the immutable admitted package-tree identity.`);
}

function assertCutPlanPackageTreeDigest(plan: unknown, treeSha256: string): void {
  const receipt = p2bPlainRecord(p2bPlainRecord(plan)?.receipt), inputHashes = receipt ? p2bPlainRecord(receipt.inputHashes) : undefined;
  if (!inputHashes || inputHashes["admitted-package-tree"] !== treeSha256) throw new Error("P2B Cut plan does not bind the immutable admitted package-tree identity.");
}

function renderedMediaHandleReferences(plan: unknown): unknown[] {
  const record = p2bPlainRecord(plan);
  if (!record || !Array.isArray(record.operations)) return [];
  return record.operations.flatMap((operation) => {
    const operationRecord = p2bPlainRecord(operation);
    const rendered = operationRecord?.verb === "cut.media.import_rendered" ? p2bPlainRecord(operationRecord.renderedMedia) : undefined;
    return rendered?.handle ? [rendered.handle] : [];
  });
}
