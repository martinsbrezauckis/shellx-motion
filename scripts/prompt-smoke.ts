/**
 * scripts/prompt-smoke.ts — one prompt run against a stubbed agent, printed as JSON.
 *
 * ROLE
 * ----
 * The cheapest end-to-end check that `runMotionPrompt` still plans an action, drives an adapter and
 * emits both receipts, without needing a subscription CLI to be installed and logged in. Run by
 * `pnpm --filter @shellx-motion/prompt run smoke`.
 *
 * WHY IT LIVES IN `scripts/` AND NOT IN THE PACKAGE
 * ------------------------------------------------
 * It used to be `packages/prompt/src/smoke.ts`, so the build emitted it and `dist/smoke.js` was
 * packed into the published `@shellx-motion/prompt` tarball even though no export subpath named it
 * in the published package. It also forced `scripts/shipping-reachability-gate.mjs` to treat
 * package.json script targets as entry points, which weakened that gate for every package. Dev
 * scripts belong in this directory, next to the other tsx smoke scripts: nothing here is compiled,
 * packed, or reachable from an installed package.
 *
 * DEPENDENCIES: the prompt package's public entry and its test-support fake runtime — both imported
 * by relative path, as every script in this directory does.
 *
 * USAGE
 *   pnpm --filter @shellx-motion/prompt run smoke
 *   tsx scripts/prompt-smoke.ts
 *
 * Exit code: 0 when the prompt run succeeds, 1 otherwise.
 */
import { runMotionPrompt } from "../packages/prompt/src/index";
import { createFakePromptRuntime } from "../packages/prompt/src/index.test-support";

const result = await runMotionPrompt({
  request: "preview current lower third package",
  tier: "render_motion",
  packageId: "lower-third",
  runtime: createFakePromptRuntime()
});

console.log(JSON.stringify({
  ok: result.ok,
  receipts: result.ok
    ? [result.agent.receipt.id, result.receipt.id]
    : result.receipt ? [result.receipt.id] : [],
  error: result.ok ? undefined : result.error
}));

if (!result.ok) {
  process.exitCode = 1;
}
