/**
 * Test-only interruption points for direct CLI receipt traversal. This module is deliberately
 * outside Core's package exports: product callers cannot supply traversal callbacks.
 */
export interface ReviewBundleReceiptTraversalTestHooks {
  afterDirectoryClassifiedBeforeOpen?: (path: string) => Promise<void> | void;
  afterDirectoryTraversedBeforeRecheck?: (path: string) => Promise<void> | void;
  afterReceiptPreflight?: (path: string) => Promise<void> | void;
}

let activeHooks: ReviewBundleReceiptTraversalTestHooks | undefined;

export async function withReviewBundleReceiptTraversalTestHooks<T>(
  hooks: ReviewBundleReceiptTraversalTestHooks,
  action: () => Promise<T>
): Promise<T> {
  if (activeHooks) throw new Error("Review bundle receipt traversal test hooks are already active.");
  activeHooks = hooks;
  try {
    return await action();
  } finally {
    activeHooks = undefined;
  }
}

export function activeReviewBundleReceiptTraversalTestHooks(): ReviewBundleReceiptTraversalTestHooks {
  return activeHooks ?? {};
}
