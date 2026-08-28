import type { MotionAction } from "./catalog.js";

/** Discovery data for the general (non-template) copy-on-write package asset import. */
export const PACKAGE_ASSET_IMPORT_ACTION: MotionAction = {
  id: "motion.package.asset.import",
  aliases: ["import package asset", "add asset to package", "copy image into package", "copy video into package", "copy external file into package", "add local asset", "package asset import"],
  permission: "edit_motion",
  mutates: true,
  calls: ["motion.state", "motion.package.asset.import", "motion.package.validate", "motion.receipts.read"],
  verify: ["The copied revision records the package-local asset ref, hash, byte length, and receipt; validation refuses missing referenced assets before a render is attempted."],
  surfaces: ["packages", "assets", "prompt"]
};
