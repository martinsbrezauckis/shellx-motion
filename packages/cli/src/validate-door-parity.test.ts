/**
 * validate-door-parity.test.ts — one directory, one verdict, whichever door asks.
 *
 * "Is this package sound?" has three doors: `shellx-motion validate` (CLI), `motion.package.validate`
 * (Debug API / MCP) and the SDK's `validate`, which calls the same debug command. They have now
 * can drift apart:
 *
 *   - once on the renderability and keyframe verdicts, which only the MCP door ran;
 *   - on the schema verdict, if a door only loads shape and never validates. `motion.package.validate`
 *     loaded the package and returned metadata — `loadMotionPackage` reads shape, it does not
 *     validate — so a document `core.validateDocument` rejects outright must never be reported `valid: true`.
 *
 * It does not assert a fixed message; it asserts that the two
 * doors return THE SAME verdict for the same directory, so a fix applied to one and not the other
 * fails here regardless of what the wording becomes.
 *
 * The invalid package is BUILT here from a shipped fixture rather than read from `artifacts/`
 * (untracked evidence would not survive a clean checkout). The mutation is a named CSS colour where
 * the schema requires `#RRGGBB`.
 *
 * Dependencies: `./main` (CLI), `@shellx-motion/debug-api` (dispatch), a copied fixture package.
 */
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dispatchDebugCommand } from "@shellx-motion/debug-api";
import { runCli } from "./main";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** The verdict both doors must agree on, projected out of their two different envelopes. */
interface Verdict {
  ok: boolean;
  code?: string;
  message?: string;
  schemaErrorCount?: number;
  schemaErrors?: unknown;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** `shellx-motion validate <root>` — the CLI door. */
async function cliVerdict(packageRoot: string): Promise<Verdict> {
  const result = record(await runCli(["validate", packageRoot]));
  const error = record(result.error);
  return {
    ok: result.ok === true,
    ...(typeof error.code === "string" ? { code: error.code } : {}),
    ...(typeof error.message === "string" ? { message: error.message } : {}),
    ...(result.schemaErrorCount !== undefined ? { schemaErrorCount: result.schemaErrorCount as number } : {}),
    ...(result.schemaErrors !== undefined ? { schemaErrors: result.schemaErrors } : {})
  };
}

/** `motion.package.validate` — the Debug API / MCP door the SDK also dispatches into. */
async function mcpVerdict(packageRoot: string): Promise<Verdict> {
  const response = await dispatchDebugCommand("motion.package.validate", { packageRoot }, { tier: "read_motion" });
  const result = record((response as { result?: unknown }).result);
  const error = record((response as { error?: unknown }).error);
  return {
    ok: response.ok === true,
    ...(typeof error.code === "string" ? { code: error.code } : {}),
    ...(typeof error.message === "string" ? { message: error.message } : {}),
    ...(result.schemaErrorCount !== undefined ? { schemaErrorCount: result.schemaErrorCount as number } : {}),
    ...(result.schemaErrors !== undefined ? { schemaErrors: result.schemaErrors } : {})
  };
}

/** Copy a shipped fixture into a temp dir and hand its parsed motion document to `mutate`. */
async function brokenCopyOf(
  fixture: string,
  mutate: (motion: { layers: Array<Record<string, unknown>> }) => void
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-validate-parity-"));
  tempDirs.push(root);
  const packageRoot = join(root, "package");
  await cp(resolve(`../../fixtures/packages/${fixture}`), packageRoot, { recursive: true });
  const motionPath = join(packageRoot, "motion.json");
  const motion = JSON.parse(await readFile(motionPath, "utf8")) as { layers: Array<Record<string, unknown>> };
  mutate(motion);
  await writeFile(motionPath, `${JSON.stringify(motion, null, 2)}\n`, "utf8");
  return packageRoot;
}

/**
 * A package that is renderable and whose keyframes read fine, and whose ONLY fault is a schema one.
 *
 * `environment.backgroundColor` set to a named CSS colour is the real defect that shipped: it loads
 * cleanly, passes the renderability and keyframe verdicts, and fails only the schema's `#RRGGBB`
 * rule — the exact case that used to pass validation and then be refused at preview. It is also why
 * the schema check has to exist behind the two specialised ones rather than instead of them.
 */
function schemaInvalidPackage(): Promise<string> {
  return brokenCopyOf("environment-rain-cinematic", (motion) => {
    const environment = motion.layers.find((layer) => layer.type === "environment");
    expect(environment, "fixture must still carry an environment layer").toBeDefined();
    (environment as { environment: Record<string, unknown> }).environment.backgroundColor = "midnightblue";
  });
}

describe("motion.package.validate and shellx-motion validate — one verdict per directory", () => {
  it("both doors REFUSE a schema-invalid document, with the same code and offenders", async () => {
    const packageRoot = await schemaInvalidPackage();

    const cli = await cliVerdict(packageRoot);
    const mcp = await mcpVerdict(packageRoot);

    // The regression: this document used to be reported valid by both doors, then refused at preview.
    expect(cli.ok).toBe(false);
    expect(mcp.ok).toBe(false);
    expect(mcp.code).toBe("invalid_motion_document");
    expect(mcp.schemaErrors).toEqual([
      { path: "/layers/0/environment/backgroundColor", message: "must be a #RRGGBB color" }
    ]);
    // The point of the file: not "each says something sensible" but "they say the SAME thing".
    expect(mcp).toEqual(cli);
  }, 60000);

  it("both doors give the SPECIALISED keyframe verdict, not the schema one, for {t,v} keyframes", async () => {
    // Ordering, not just presence. `{ t, v }` keyframes fail the schema too, so a door that ran the
    // schema first would answer "does not satisfy shellx-motion/motion@1: N error(s)" instead of
    // naming the four unreadable keyframes and the correct `{ atMs, value }` form. The general
    // checker must cover what the specific ones do not — never shadow them.
    const packageRoot = await brokenCopyOf("keyframed-lower-third", (motion) => {
      const layer = motion.layers.find((entry) => entry.keyframes) as { keyframes: Record<string, unknown[]> };
      expect(layer, "fixture must still carry a keyframed layer").toBeDefined();
      const track = Object.keys(layer.keyframes)[0];
      layer.keyframes[track] = (layer.keyframes[track] as Array<{ atMs: number; value: unknown }>)
        .map((entry) => ({ t: entry.atMs, v: entry.value }));
    });

    const cli = await cliVerdict(packageRoot);
    const mcp = await mcpVerdict(packageRoot);

    expect(mcp.code).toBe("keyframes_unreadable");
    expect(mcp.message).toContain("cannot be read by the timeline evaluator");
    expect(mcp).toEqual(cli);
  }, 60000);

  it("both doors PASS a sound document, and neither invents a schema error", async () => {
    const packageRoot = resolve("../../fixtures/packages/keyframed-lower-third");

    const cli = await cliVerdict(packageRoot);
    const mcp = await mcpVerdict(packageRoot);

    expect(cli.ok).toBe(true);
    expect(mcp.ok).toBe(true);
    expect(mcp.schemaErrors).toBeUndefined();
    expect(mcp).toEqual(cli);
  }, 60000);

  it("both doors PASS every shipped environment fixture unmodified", async () => {
    // Guards the other direction: a validator wired in too aggressively would refuse what ships.
    for (const fixture of ["environment-rain-cinematic", "environment-water-cinematic", "environment-rain-footage"]) {
      const packageRoot = resolve(`../../fixtures/packages/${fixture}`);
      const cli = await cliVerdict(packageRoot);
      const mcp = await mcpVerdict(packageRoot);
      expect(cli.ok, `${fixture} must pass the CLI door`).toBe(true);
      expect(mcp, `${fixture} doors disagree`).toEqual(cli);
    }
  }, 60000);
});
