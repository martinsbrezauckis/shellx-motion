/**
 * Coverage for the Lottie / dotLottie import commands.
 *
 * The defect these close: Motion carried ~2,800 lines of tested Lottie lowering — precomp
 * flattening, theming, bundled image and font extraction, zip container handling — reachable
 * from no product surface at all. The writers were exported as library functions with no command
 * and no CLI verb, so a documented capability could not be invoked.
 *
 * These drive the real writers against real fixture files rather than stubs, because the point
 * being proven is reachability end to end, not that a router forwards arguments.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEBUG_COMMANDS, dispatchDebugCommand } from "../index";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const LOTTIE_FIXTURE = resolve("../../fixtures/imports/lottie-static-shape/input.json");

async function outputRoot(): Promise<{ root: string; outDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-lottie-import-"));
  tempDirs.push(root);
  return { root, outDir: join(root, "package") };
}

describe("Lottie import is reachable", () => {
  it("registers both import commands", () => {
    // Reachability is the whole point: an unregistered command cannot be dispatched at all.
    expect(DEBUG_COMMANDS).toContain("motion.lottie.import");
    expect(DEBUG_COMMANDS).toContain("motion.dotlottie.import");
  });

  it("imports a real Lottie file into a package with its receipts on disk", async () => {
    const { root, outDir } = await outputRoot();

    const result = await dispatchDebugCommand(
      "motion.lottie.import",
      { sourcePath: LOTTIE_FIXTURE, outDir, createdBy: "lottie-import-test", createdAt: "2026-08-02T00:00:00.000Z" },
      {
        tier: "write_local",
        authoringInputRoots: [dirname(LOTTIE_FIXTURE)],
        authoringOutputRoots: [root]
      }
    );

    expect(result.ok).toBe(true);
    const visible = (result as { visibleState: Record<string, unknown> }).visibleState;
    expect(visible.operation).toBe("lottie.import");
    expect(String(visible.packageId)).toMatch(/^pkg_lottie/);
    // The import must leave attestations behind, not just a package directory.
    const lowering = JSON.parse(await readFile(String(visible.loweringReceiptPath), "utf8")) as Record<string, unknown>;
    expect(lowering.schema).toBe("shellx-motion/receipt@1");
    const diagnostics = JSON.parse(await readFile(String(visible.diagnosticsReceiptPath), "utf8")) as Record<string, unknown>;
    expect(diagnostics.schema).toBe("shellx-motion/receipt@1");
  });

  it("refuses to write outside the roots the host approved", async () => {
    const { outDir } = await outputRoot();

    const result = await dispatchDebugCommand(
      "motion.lottie.import",
      { sourcePath: LOTTIE_FIXTURE, outDir },
      { tier: "write_local" }
    );

    // Same posture as every other authoring import: no approved roots, no write.
    expect(result).toMatchObject({ ok: false, error: { code: "capability_unavailable" } });
  });

  it("requires both a source and an output directory", async () => {
    const { root, outDir } = await outputRoot();
    const services = {
      tier: "write_local" as const,
      authoringInputRoots: [dirname(LOTTIE_FIXTURE)],
      authoringOutputRoots: [root]
    };

    expect(await dispatchDebugCommand("motion.lottie.import", { outDir }, services))
      .toMatchObject({ ok: false, error: { code: "invalid_args" } });
    expect(await dispatchDebugCommand("motion.lottie.import", { sourcePath: LOTTIE_FIXTURE }, services))
      .toMatchObject({ ok: false, error: { code: "invalid_args" } });
  });

  it("reports a failed import rather than throwing", async () => {
    const { root, outDir } = await outputRoot();

    const result = await dispatchDebugCommand(
      "motion.lottie.import",
      { sourcePath: join(dirname(LOTTIE_FIXTURE), "does-not-exist.json"), outDir },
      {
        tier: "write_local",
        authoringInputRoots: [dirname(LOTTIE_FIXTURE)],
        authoringOutputRoots: [root]
      }
    );

    expect(result).toMatchObject({ ok: false, error: { code: "lottie_import_failed" } });
  });

  it("needs write_local, not a lower tier", async () => {
    const { root, outDir } = await outputRoot();

    const result = await dispatchDebugCommand(
      "motion.lottie.import",
      { sourcePath: LOTTIE_FIXTURE, outDir },
      {
        tier: "read_motion",
        authoringInputRoots: [dirname(LOTTIE_FIXTURE)],
        authoringOutputRoots: [root]
      }
    );

    // Importing writes a package, so it sits behind the same tier as every other writer. The
    // tier check runs before the handler, so this is permission_denied rather than the
    // capability_unavailable a correctly-tiered caller sees when roots are missing.
    expect(result).toMatchObject({ ok: false, error: { code: "permission_denied" } });
  });
});
