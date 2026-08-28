/** Action catalog entry for the bounded atomic revision surface. */
import type { MotionAction } from "./catalog.js";

export const REVISION_TRANSACTION_ACTION: MotionAction = {
  id: "motion.revision.transaction",
  aliases: ["apply atomic revision", "apply multiple timeline edits atomically", "one revision for several edits", "transactional timeline revision"],
  permission: "edit_motion",
  mutates: true,
  calls: ["motion.state", "motion.revision.transaction", "motion.preview.frame", "motion.receipts.read"],
  verify: ["One aggregate revision.transaction receipt binds the exact base identity, source/final authored-document hashes, canonical transaction hash, every typed step hash and changed path, and validation result."],
  surfaces: ["timeline", "preview", "receipts"]
};

export const REVISION_TRANSACTION_PLAN_ACTION: MotionAction = {
  id: "motion.revision.transaction.plan",
  aliases: ["plan atomic revision", "preview atomic timeline revision", "validate several timeline edits", "plan transactional timeline revision"],
  permission: "read_motion",
  mutates: false,
  calls: ["motion.state", "motion.revision.transaction.plan"],
  verify: ["Read-only plan binds the exact base, canonical normalized transaction hash, each typed step hash and changed path, predicted final authored-document hash, and compact passed validation without writing a receipt or package."],
  surfaces: ["timeline"]
};
