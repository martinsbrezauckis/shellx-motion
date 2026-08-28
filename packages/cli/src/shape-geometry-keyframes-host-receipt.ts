/** Host-owned, collision-isolated receipt publication for CLI shape snapshot COW edits. */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { OutputDirectoryTransaction, type OperationReceipt } from "@shellx-motion/core";
import type { MotionDebugCommand } from "@shellx-motion/debug-api";

const UPSERT = "motion.timeline.shape.geometry-keyframes.upsert";
const DELETE = "motion.timeline.shape.geometry-keyframes.delete";
const MOVE = "motion.timeline.shape.geometry-keyframes.move";
const BEHAVIOR_UPSERT = "motion.timeline.behaviors.upsert";
const BEHAVIOR_REMOVE = "motion.timeline.behaviors.remove";
const RECEIPT_FILE_NAME = "host.receipt.json";

export interface CliShapeGeometryKeyframeHostReceiptStore {
  /** Host-generated fresh directory; no caller argument can name or reuse it. */
  receiptsRoot: string;
  writeReceipt(receiptsRoot: string, receipt: OperationReceipt): Promise<string>;
}

export interface CliShapeGeometryKeyframeHostReceiptStoreOptions {
  /** Test-only workspace seam; the CLI always leaves this undefined. */
  workspaceRoot?: string;
  /** Test-only replacement seam after the private stage has its canonical receipt bytes. */
  afterStageWritten?: (input: { outputPath: string; stagingPath: string }) => Promise<void> | void;
}

/**
 * Mint one absent, private destination per CLI invocation. Its root is part of the operation's
 * trusted-workspace anchor, and publication uses Core's retained topology transaction rather than
 * Debug's generic mkdir/rename receipt helper.
 */
export function createCliShapeGeometryKeyframeHostReceiptStore(
  command: MotionDebugCommand,
  options: CliShapeGeometryKeyframeHostReceiptStoreOptions = {},
): CliShapeGeometryKeyframeHostReceiptStore | undefined {
  if (!isShapeGeometryKeyframeMutation(command)) return undefined;
  return createCliTimelineHostReceiptStore(command, options);
}

/** The CLI mints one opaque host receipt root for each closed timeline COW family. */
export function createCliTimelineHostReceiptStore(
  command: MotionDebugCommand,
  options: CliShapeGeometryKeyframeHostReceiptStoreOptions = {},
): CliShapeGeometryKeyframeHostReceiptStore | undefined {
  const receiptScope = timelineHostReceiptScope(command);
  if (!receiptScope) return undefined;
  const workspaceRoot = options.workspaceRoot === undefined ? sourceCheckoutWorkspaceRoot() : resolve(options.workspaceRoot);
  if (!workspaceRoot) return undefined;
  const receiptsRoot = join(workspaceRoot, ".scratch", "cli-host-receipts", receiptScope, randomUUID());
  return {
    receiptsRoot,
    writeReceipt: async (requestedRoot, receipt) => {
      if (resolve(requestedRoot) !== receiptsRoot) {
        throw new Error("CLI shape geometry keyframe receipt writer refused an unexpected receipt root.");
      }
      const transaction = await OutputDirectoryTransaction.create(receiptsRoot, { requireAbsent: true });
      let committed = false;
      try {
        await transaction.assertCurrent();
        const stagedReceiptPath = join(transaction.stagingPath, RECEIPT_FILE_NAME);
        await writeFile(stagedReceiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
        await transaction.assertCurrent();
        await options.afterStageWritten?.({ outputPath: transaction.outputPath, stagingPath: transaction.stagingPath });
        await transaction.commit();
        committed = true;
        await transaction.assertPublishedCurrent();
        return join(transaction.outputPath, RECEIPT_FILE_NAME);
      } catch (error) {
        if (!committed) await transaction.abort();
        throw error;
      }
    },
  };
}

export function isShapeGeometryKeyframeMutation(command: MotionDebugCommand): boolean {
  return command === UPSERT || command === DELETE || command === MOVE;
}

function timelineHostReceiptScope(command: MotionDebugCommand): string | undefined {
  if (isShapeGeometryKeyframeMutation(command)) return "timeline-shape-geometry-keyframes";
  if (command === BEHAVIOR_UPSERT || command === BEHAVIOR_REMOVE) return "timeline-behaviors";
  return undefined;
}

function sourceCheckoutWorkspaceRoot(): string | undefined {
  const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
  return existsSync(join(root, "pnpm-workspace.yaml")) ? root : undefined;
}
