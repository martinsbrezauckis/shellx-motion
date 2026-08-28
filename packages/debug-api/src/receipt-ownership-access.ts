/** Bind receipt-store readers to one authenticated caller-visible scope. */
import type { OperationReceipt } from "@shellx-motion/core";
import { receiptVisibleToCaller, visibleReceiptEntries, type ReceiptAccessScope } from "./receipt-ownership.js";

export interface ReceiptStoreEntryRead<E> {
  insideRoot: boolean;
  entry: E | null;
}

export interface ReceiptOwnershipReaders<E extends { receipt: OperationReceipt }, S, T extends { entries: E[] }> {
  readEntries: (receiptsRoot: string, services?: S) => Promise<E[]>;
  readEntry: (receiptsRoot: string, receiptPath: string) => Promise<ReceiptStoreEntryRead<E>>;
  readEntriesWithStatus: (receiptsRoot: string) => Promise<T>;
}

export function createReceiptOwnershipAccess<E extends { receipt: OperationReceipt }, S, T extends { entries: E[] }>(
  scope: ReceiptAccessScope,
  readers: ReceiptOwnershipReaders<E, S, T>
) {
  return {
    visible: (entries: readonly E[]) => visibleReceiptEntries(entries, scope),
    list: async (receiptsRoot: string, services?: S) => visibleReceiptEntries(await readers.readEntries(receiptsRoot, services), scope),
    entry: async (receiptsRoot: string, receiptPath: string): Promise<ReceiptStoreEntryRead<E>> => {
      const read = await readers.readEntry(receiptsRoot, receiptPath);
      return { insideRoot: read.insideRoot, entry: read.entry && receiptVisibleToCaller(read.entry.receipt, scope) ? read.entry : null };
    },
    status: async (receiptsRoot: string): Promise<T> => {
      const read = await readers.readEntriesWithStatus(receiptsRoot);
      return { ...read, entries: visibleReceiptEntries(read.entries, scope) };
    }
  };
}
