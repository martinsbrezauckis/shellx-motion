/** Hidden-copy publication seam for one verified revision transaction. */
import { compileMotionDocumentCompositing, hashBuffer, hashPackageFile, loadMotionPackage, resolvePackageAsset, type MotionDocument, type MotionPackage, type OperationReceipt } from "@shellx-motion/core";
import { join, resolve } from "node:path";
import {
  assertParsedPackageIdentity, assertReceiptInputHashes, commitPackageEdit, jsonHash,
  PackageEditTransactionError, writeJson, type MotionDocumentEditResult
} from "./package-edit-transaction.js";

export interface MotionDocumentTransactionOptions<T extends { motion: MotionDocument }> {
  sourcePackage: MotionPackage;
  outputRoot: string;
  receipt: OperationReceipt;
  receiptFileName: string;
  expectedPersistedMotionSha256: string;
  apply: (motion: MotionDocument) => Promise<T> | T;
}
export interface MotionDocumentTransactionResult<T extends { motion: MotionDocument }> extends MotionDocumentEditResult { editResult: T; }

/** Hash the exact pretty-printed JSON bytes this transaction writes into a package. */
export function motionDocumentFileSha256(value: MotionDocument): string {
  return hashBuffer(Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"));
}

export async function commitMotionDocumentTransaction<T extends { motion: MotionDocument }>(options: MotionDocumentTransactionOptions<T>): Promise<MotionDocumentTransactionResult<T>> {
  const packageRoot = resolve(options.outputRoot);
  const manifestPath = join(packageRoot, "manifest.json");
  const motionPath = join(packageRoot, options.sourcePackage.manifest.motion);
  const receiptPath = join(packageRoot, "receipts", options.receiptFileName);
  const transaction = await commitPackageEdit({
    sourceRoot: options.sourcePackage.root,
    outputRoot: packageRoot,
    edit: async (stagedRoot) => {
      const stagedPkg = await loadMotionPackage(stagedRoot);
      assertParsedPackageIdentity(options.sourcePackage, stagedPkg);
      await assertReceiptInputHashes(options.receipt, stagedPkg);
      const editResult = await options.apply(stagedPkg.motion);
      const persistedMotion = compileMotionDocumentCompositing(editResult.motion);
      if (motionDocumentFileSha256(persistedMotion) !== options.expectedPersistedMotionSha256) {
        throw new PackageEditTransactionError("copy_mismatch", "Staged revision transaction did not match its prevalidated final Motion document.");
      }
      await writeJson(join(stagedRoot, stagedPkg.manifest.motion), persistedMotion);
      await writeJson(join(stagedRoot, "receipts", options.receiptFileName), options.receipt);
      return { editResult: { ...editResult, motion: persistedMotion } };
    },
    validate: async (stagedRoot, result) => {
      const stagedPkg = await loadMotionPackage(stagedRoot);
      const actualMotionSha256 = await hashPackageFile(resolvePackageAsset(stagedPkg, stagedPkg.manifest.motion));
      if (actualMotionSha256 !== options.expectedPersistedMotionSha256) {
        throw new PackageEditTransactionError("copy_mismatch", "Staged revision transaction wrote unexpected Motion bytes.");
      }
      if (jsonHash(stagedPkg.motion) !== jsonHash(result.editResult.motion)) {
        throw new PackageEditTransactionError("copy_mismatch", "Staged revision transaction did not preserve its validated Motion document.");
      }
    }
  });
  return { packageRoot, manifestPath, motionPath, receiptPath, editResult: transaction.editResult.editResult };
}
