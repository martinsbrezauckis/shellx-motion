/**
 * The receipt status a debug batch reports for the injected-renderer fixtures, and why.
 *
 * Role: shared by `index.test.ts` (which asserts it across five batch tests) and
 * `batch-receipt-status.test.ts` (which proves the rule itself against a real render). Extracted
 * rather than inlined because `index.test.ts` sits at its module-size cap, and because a bare
 * `"warning"` literal repeated across five assertions teaches the next reader nothing.
 *
 * Every batch test that actually renders injects a frame renderer which writes the SAME
 * `CONTRAST_PNG` for every frame. The delivered pixels are therefore genuinely static, the engine
 * genuinely measures that, and the receipt genuinely carries two advisories:
 *
 *   "Rendered frame sequence is static; verify this is intentional before using it as product output."
 *   "Rendered motion is static for 100.0% of its duration (2.000s of 2.000s ...)"
 *
 * Under the one receipt-status rule (`receiptStatusForWarnings` in `@shellx-motion/core`) an
 * actionable warning escalates a `passed` claim, so `warning` is the TRUTHFUL answer here and the
 * `passed` these assertions carried previously was the obsolete one. It survived because the
 * debug batch was the surface the unified-rule sweep missed: it went on reporting `passed` while
 * carrying the advisory, which is the exact contradiction the rule exists to remove.
 *
 * Named rather than inlined so the next reader meets the reason instead of a literal, and so
 * flipping it back requires explaining why a static render should claim it passed.
 *
 * Dependencies: none. Primary callers: `index.test.ts`, `batch-receipt-status.test.ts`.
 */
export const BATCH_STATIC_FIXTURE_STATUS = "warning";

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Whether a template family exists in THIS tree.
 *
 * Two catalog tests in `index.test.ts` are specifically about `tutorial-overlay`: they prove that
 * exact design-family membership outranks regex-derived membership, using
 * tutorial-overlay (exact) against tracked-callout-overlay (matched only on the token "overlay").
 * That comparison cannot be retargeted to another pair without changing what it proves.
 *
 * `tutorial-overlay` is one of the three families the export manifest withholds, so in the published
 * tree the fixture is simply not there and those tests would fail on an absence rather than on
 * behaviour. They skip there instead, and the coverage is implementation-tree-only until the family
 * is fixed and re-added to the pack.
 *
 * @param dir Family directory name under templates/shellx-product-pack.
 * @returns True when the family is present in this tree.
 */
export function productFamilyPresent(dir: string): boolean {
  return existsSync(fileURLToPath(new URL(`../../../templates/shellx-product-pack/${dir}`, import.meta.url)));
}
