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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { dispatchDebugCommand } from "@shellx-motion/debug-api";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { runCli } from "./main";

const tempDirs: string[] = [];
const fixturePackagesRoot = fileURLToPath(new URL("../../../fixtures/packages/", import.meta.url));

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** The verdict both doors must agree on, projected out of their two different envelopes. */
interface Verdict {
  ok: boolean;
  code?: string;
  message?: string;
  validation?: unknown;
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
    ...(result.validation !== undefined ? { validation: result.validation } : {}),
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
    ...(result.validation !== undefined ? { validation: result.validation } : {}),
    ...(result.schemaErrorCount !== undefined ? { schemaErrorCount: result.schemaErrorCount as number } : {}),
    ...(result.schemaErrors !== undefined ? { schemaErrors: result.schemaErrors } : {})
  };
}

/** Exercise both public doors inside the same explicit host-approved workspace authority. */
async function bothVerdicts(packageRoot: string): Promise<readonly [Verdict, Verdict]> {
  const anchor = await createTrustedWorkspaceAnchor(dirname(packageRoot));
  return await withTrustedWorkspaceAnchor(anchor, async () => [
    await cliVerdict(packageRoot),
    await mcpVerdict(packageRoot),
  ] as const);
}

/** Copy a shipped fixture into a temp dir and hand its parsed motion document to `mutate`. */
async function brokenCopyOf(
  fixture: string,
  mutate: (motion: { layers: Array<Record<string, unknown>> }) => void
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-validate-parity-"));
  tempDirs.push(root);
  const packageRoot = join(root, "package");
  await cp(resolve(fixturePackagesRoot, fixture), packageRoot, { recursive: true });
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
 * rule — the exact case that used to pass validation and then be refused at preview. It must fail
 * structural stage one before any semantic/renderability claim is considered.
 */
function schemaInvalidPackage(): Promise<string> {
  return brokenCopyOf("environment-rain-cinematic", (motion) => {
    const environment = motion.layers.find((layer) => layer.type === "environment");
    expect(environment, "fixture must still carry an environment layer").toBeDefined();
    (environment as { environment: Record<string, unknown> }).environment.backgroundColor = "midnightblue";
  });
}

async function missingPackageAsset(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-validate-missing-asset-"));
  tempDirs.push(root);
  const packageRoot = join(root, "package");
  await cp(resolve(fixturePackagesRoot, "keyframed-lower-third"), packageRoot, { recursive: true });
  const manifestPath = join(packageRoot, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { assets: string[] };
  manifest.assets = [...manifest.assets, "assets/missing-before-render.png"];
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return packageRoot;
}

describe("motion.package.validate and shellx-motion validate — one verdict per directory", () => {
  it("both doors REFUSE a schema-invalid document, with the same code and offenders", async () => {
    const packageRoot = await schemaInvalidPackage();

    const [cli, mcp] = await bothVerdicts(packageRoot);

    // The regression: this document used to be reported valid by both doors, then refused at preview.
    expect(cli.ok).toBe(false);
    expect(mcp.ok).toBe(false);
    expect(mcp.code).toBe("invalid_motion_document");
    expect(mcp.schemaErrors).toEqual([
      { path: "/layers/0/environment/backgroundColor", message: "must match pattern ^#[0-9A-Fa-f]{6}$" }
    ]);
    expect(mcp.validation).toEqual({
      contract: "shellx-motion/motion-validation@1",
      structural: "failed",
      semantic: "not_run",
      renderability: "not_proven",
    });
    // The point of the file: not "each says something sensible" but "they say the SAME thing".
    expect(mcp).toEqual(cli);
  }, 60000);

  it("both doors stop at structural stage one for {t,v} keyframes", async () => {
    // `{ t, v }` keyframes fail JSON Schema. The timeline panel can still explain unreadable
    // keyframes separately, but package validation must not imply runtime semantic/renderability
    // work ran after stage one failed.
    const packageRoot = await brokenCopyOf("keyframed-lower-third", (motion) => {
      const layer = motion.layers.find((entry) => entry.keyframes) as { keyframes: Record<string, unknown[]> };
      expect(layer, "fixture must still carry a keyframed layer").toBeDefined();
      const track = Object.keys(layer.keyframes)[0];
      layer.keyframes[track] = (layer.keyframes[track] as Array<{ atMs: number; value: unknown }>)
        .map((entry) => ({ t: entry.atMs, v: entry.value }));
    });

    const [cli, mcp] = await bothVerdicts(packageRoot);

    expect(mcp.code).toBe("invalid_motion_document");
    expect(mcp.validation).toMatchObject({ structural: "failed", semantic: "not_run", renderability: "not_proven" });
    expect(mcp).toEqual(cli);
  }, 60000);

  it("both doors PASS a sound document, and neither invents a schema error", async () => {
    const packageRoot = resolve(fixturePackagesRoot, "keyframed-lower-third");

    const [cli, mcp] = await bothVerdicts(packageRoot);

    expect(cli.ok).toBe(true);
    expect(mcp.ok).toBe(true);
    expect(mcp.schemaErrors).toBeUndefined();
    expect(mcp.validation).toMatchObject({ structural: "passed", semantic: "passed", renderability: "not_proven" });
    expect(mcp).toEqual(cli);
  }, 60000);

  it("both doors refuse a missing package-local asset before rendering", async () => {
    const packageRoot = await missingPackageAsset();
    const [cli, mcp] = await bothVerdicts(packageRoot);

    expect(cli).toMatchObject({ ok: false, code: "invalid_package_assets", message: expect.stringContaining("1 invalid package-local asset") });
    expect(mcp).toEqual(cli);
  }, 60000);

  it("both doors PASS every shipped environment fixture unmodified", async () => {
    // Guards the other direction: a validator wired in too aggressively would refuse what ships.
    for (const fixture of ["environment-rain-cinematic", "environment-water-cinematic", "environment-rain-footage"]) {
      const packageRoot = resolve(fixturePackagesRoot, fixture);
      const [cli, mcp] = await bothVerdicts(packageRoot);
      expect(cli.ok, `${fixture} must pass the CLI door`).toBe(true);
      expect(mcp, `${fixture} doors disagree`).toEqual(cli);
    }
  }, 60000);
});
