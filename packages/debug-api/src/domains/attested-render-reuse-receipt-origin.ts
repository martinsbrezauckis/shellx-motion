/** Bind source-receipt attestation to the receipt the trusted host actually persisted. */
import { attestArtifactReceipt, hashBuffer, type ArtifactReceiptAttestation, type OperationReceipt } from "@shellx-motion/core";
import { isInside } from "./attested-render-reuse-root.js";

export async function attestHostPersistedRenderReceipt(input: {
  root: string;
  receiptsRoot: string;
  receipt: OperationReceipt;
  writeReceipt: (root: string, receipt: OperationReceipt) => Promise<string>;
}): Promise<ArtifactReceiptAttestation> {
  // The producer supplied its original receipt path in a shared output root. Re-persist the
  // host-held receipt and bind the bytes we subsequently attest to that exact in-memory value so
  // a co-writer cannot substitute a self-consistent receipt/output pair before proof issuance.
  const receiptPath = await input.writeReceipt(input.receiptsRoot, input.receipt);
  if (!isInside(input.root, receiptPath)) {
    throw new Error("The host-persisted source render receipt is outside the attested-reuse root.");
  }
  const expectedSha256 = hashBuffer(Buffer.from(`${JSON.stringify(input.receipt, null, 2)}\n`, "utf8"));
  const attestation = await attestArtifactReceipt(input.root, receiptPath, "render");
  if (attestation.sha256 !== expectedSha256) {
    throw new Error("The host-persisted source render receipt changed before producer proof issuance.");
  }
  return attestation;
}
