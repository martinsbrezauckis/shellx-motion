/**
 * Regression suite for the removed fake agent/prompt runtimes.
 *
 * Two independent guards, because either one alone rots:
 *
 *  1. BEHAVIOUR — the four command lines that used to produce a simulated success now refuse, and
 *     the refusal carries no receipt ids. Before this fix,
 *     `prompt run "make the title blue" --fake --tier edit_motion --trusted-local-tier` answered
 *     `{"ok":true,…,"receipts":["agent-efd2abbf1bbde3c1","prompt-c8fcc63ae965fd89"]}` with no agent
 *     executed, and `agent health --adapter fake` answered `available: true, status: "ready"` for a
 *     binary nobody can install.
 *  2. SOURCE CLASS — no shipping module in any package may construct a stubbed agent runtime again.
 *     Removing four call sites fixes today's finding; a grep over the shipped source set is what
 *     stops the fifth. Scaffolding is allowed to build one, which is the whole point of moving the
 *     constructors into `*.test-support.ts`.
 *
 * Dependencies: `runCli` and the non-shipping module convention documented in
 * `scripts/source-modules.mjs` (mirrored locally rather than imported, because that module is
 * untyped `.mjs` and this file is type-checked).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runCli } from "./main";

// Resolved from this module, not from cwd: the suite runs both as `pnpm --filter @shellx-motion/cli
// test` (cwd = packages/cli) and as `vitest --root packages/cli` from the repo root.
const PACKAGES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Mirrors `isNonShippingSource` in `scripts/source-modules.mjs`: nonshipping source is excluded
 * from the build and tarballs, while only test scaffolding is sanctioned for a scripted runtime.
 */
function isNonShippingSource(path: string): boolean {
  const segments = path.replaceAll("\\", "/").split("/");
  if (segments.some((segment) => ["test-support", "unadopted", "__tests__", "__fixtures__", "__mocks__"].includes(segment))) {
    return true;
  }
  return /\.(test|fixture|fixtures|test-support)(-[^.]+)?\.tsx?$/.test(segments.at(-1) ?? "");
}

/**
 * Drop whole-line comments and block comments.
 *
 * The guard is about what shipping code *does*, not what it explains: this repo requires modules to
 * document why a removed thing was removed, and those comments necessarily name it. Trailing
 * comments on a code line are deliberately left in place — a line that both runs and mentions a fake
 * runtime deserves to be looked at.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
}

/** Every shipping `.ts`/`.tsx` under `packages/<pkg>/src`. */
function shippingSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return shippingSources(full);
    if (!/\.tsx?$/.test(entry.name) || isNonShippingSource(full)) return [];
    return [full];
  });
}

describe("retired simulation options", () => {
  it("refuses prompt run --fake instead of returning a receipt pair", async () => {
    const result = await runCli(
      ["prompt", "run", "make the title blue", "--fake", "--tier", "edit_motion"],
      { trustedLocalTier: true }
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "retired_option", message: expect.stringContaining("--fake") }
    });
    // The point of the finding: no evidence-shaped output may come back from a simulated run.
    expect(result.receipts).toBeUndefined();
    expect(result.receiptPaths).toBeUndefined();
  });

  it("refuses debug prompt-run --fake", async () => {
    const result = await runCli(
      ["debug", "prompt-run", "--fake", "--tier", "render_motion", "--request", "preview current package", "--package-id", "pkg_cli_prompt"],
      { trustedLocalTier: true }
    );

    expect(result).toMatchObject({ ok: false, error: { code: "retired_option" } });
    expect(result.result).toBeUndefined();
  });

  it("refuses agent health --adapter fake instead of reporting a ready agent", async () => {
    const result = await runCli(["agent", "health", "--adapter", "fake"]);

    expect(result).toMatchObject({
      ok: false,
      error: { code: "retired_option", message: expect.stringContaining("--adapter fake") }
    });
    expect(result.agents).toBeUndefined();
  });

  it("refuses debug agent-health --adapter fake", async () => {
    const result = await runCli(["debug", "agent-health", "--adapter", "fake"]);

    expect(result).toMatchObject({ ok: false, error: { code: "retired_option" } });
    expect(result.result).toBeUndefined();
  });

  it("does not treat --fake as a real agent run by silently ignoring it", async () => {
    // The dangerous near-miss: an unrecognised --fake would let the command proceed for real while
    // the caller believed the run was simulated, and would swallow the following token as its value.
    const result = await runCli(["prompt", "run", "make the title blue", "--fake", "--package-id", "lower-third"]);

    expect(result.ok).toBe(false);
    expect(result.command).toBe("prompt");
  });
});

describe("simulated runtimes are absent from shipping source", () => {
  it("has no fake agent or prompt runtime construction in any package's shipping modules", () => {
    // A stubbed adapter is recognised by the constructor names that used to exist and by the stub
    // executable itself; any of them in shipping source means the class has come back.
    const forbidden = /createFakePromptRuntime|fakeAgentRuntime|fakeAdapter|shellx-motion-fake-agent/;
    const offenders: string[] = [];

    for (const entry of readdirSync(PACKAGES_DIR)) {
      const sourceDir = join(PACKAGES_DIR, entry, "src");
      let stats;
      try {
        stats = statSync(sourceDir);
      } catch {
        continue;
      }
      if (!stats.isDirectory()) continue;
      for (const file of shippingSources(sourceDir)) {
        if (forbidden.test(withoutComments(readFileSync(file, "utf8")))) offenders.push(file);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("keeps the fake prompt runtime out of the published @shellx-motion/prompt surface", async () => {
    const promptModule: Record<string, unknown> = await import("@shellx-motion/prompt");

    expect(Object.keys(promptModule)).not.toContain("createFakePromptRuntime");
  });
});
