import type { MotionAction } from "./catalog.js";

/** Published import workflows for the existing bounded Lottie lowerers. */
export const LOTTIE_ACTIONS: MotionAction[] = [
  {
    id: "motion.lottie.import",
    aliases: [
      "import lottie",
      "import lottie json",
      "load lottie animation",
      "convert lottie to motion",
      "create motion package from lottie"
    ],
    permission: "write_local",
    mutates: true,
    calls: ["motion.lottie.import"],
    verify: [
      "Import returns the created package root plus loweringReceiptPath and diagnosticsReceiptPath; inspect both because success does not claim complete representation.",
      "The source and output remain bounded by host-approved roots, and the lowerer records unsupported or flattened content in its diagnostics."
    ],
    surfaces: ["packages", "receipts", "prompt"]
  },
  {
    id: "motion.dotlottie.import",
    aliases: [
      "import dotlottie",
      "load dotlottie animation",
      "convert dotlottie to motion",
      "create motion package from dotlottie"
    ],
    permission: "write_local",
    mutates: true,
    calls: ["motion.dotlottie.import"],
    verify: [
      "Import returns the created package root plus loweringReceiptPath and diagnosticsReceiptPath; inspect both because success does not claim complete representation.",
      "Optional animationId/themeId select one container animation/theme; state machines are preserved but never executed."
    ],
    surfaces: ["packages", "receipts", "prompt"]
  }
];
