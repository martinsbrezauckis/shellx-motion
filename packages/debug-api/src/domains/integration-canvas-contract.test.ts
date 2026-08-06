/**
 * Agent-facing contract for the Canvas import and for the validate verdict that follows it.
 *
 * Both behaviours pinned here were reproduced against the live MCP server by driving an external
 * agent blind during cross-host verification:
 *
 *   Invalid layer kind — a fixture whose layers used `kind: "rect"` packaged cleanly, `motion.package.validate`
 *        answered `valid: true`, and preview and render then both refused it with "Lane browser does
 *        not support rect layers". The engine declared the package valid and would not draw it, and
 *        nothing in the answer told the author what to change.
 *   Incomplete fixture shape — each rejection named exactly one missing field, so
 *        the contract cost thirteen calls to discover.
 *
 * Dependencies: the integration and workspace domain dispatchers, and the published argument
 * contract for `motion.canvas.package`.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderableLayerTypes, type MotionPackage } from "@shellx-motion/core";
import { CANVAS_FIXTURE_EXAMPLE } from "@shellx-motion/adapters-canvas";
import { buildDebugCommandContracts } from "../command-registry.js";
import { SURFACE_COMMAND_METADATA } from "../command-metadata-surfaces.js";
import { dispatchIntegrationCommand } from "./integration.js";
import { dispatchWorkspaceCommand } from "./workspace.js";

const tempDirs: string[] = [];

/** Minimal services: the Canvas import only needs somewhere to put the receipt JSON. */
const services = { writeJson: async () => {} };

function rectSelection(): Record<string, unknown> {
  return {
    schema: "shellx-canvas/frame-selection@1",
    selectedFrameId: "frame_intro",
    project: { id: "rect_probe", name: "Rect Probe" },
    brand: { tokens: {} },
    frames: [
      {
        id: "frame_intro",
        name: "Intro",
        durationMs: 1000,
        fps: 2,
        width: 640,
        height: 360,
        layers: [{ id: "box", kind: "rect", startMs: 0, durationMs: 1000 }]
      }
    ],
    imageEditorOutputs: []
  };
}

describe("motion.canvas.package fixture contract", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  async function packageSelection(selection: unknown) {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-canvas-contract-"));
    tempDirs.push(root);
    return await dispatchIntegrationCommand("motion.canvas.package", {
      selection,
      packageDir: join(root, "pkg")
    }, services);
  }

  it("refuses a kind no lane renders instead of writing a package validate would call valid", async () => {
    const result = await packageSelection(rectSelection());

    expect(result).toMatchObject({ ok: false, error: { code: "canvas_fixture_invalid" } });
    expect((result as any).result.problems).toEqual([
      {
        path: "frames[0].layers[0].kind",
        message: `no Motion render lane supports "rect" layers; accepted kinds are ${renderableLayerTypes().join(", ")}`,
        correction: 'write {"kind":"shape","shape":"rect"} instead of {"kind":"rect"}'
      }
    ]);
  });

  it("reports every problem in one answer and publishes the contract with it", async () => {
    const result = await packageSelection({});

    // Six problems in one call is the whole point: this used to be six calls.
    expect((result as any).result.problems.map((problem: any) => problem.path)).toEqual([
      "fixture.schema",
      "fixture.selectedFrameId",
      "project",
      "brand",
      "fixture.frames",
      "fixture.imageEditorOutputs"
    ]);
    const contract = (result as any).result.contract;
    expect(contract.schemas).toEqual(["shellx-motion/canvas-frame-selection@1", "shellx-canvas/frame-selection@1"]);
    expect(contract.layerKinds).toEqual([...renderableLayerTypes()]);
    expect(contract.example).toEqual(CANVAS_FIXTURE_EXAMPLE);
  });

  it("accepts the example it publishes", async () => {
    const result = await packageSelection(structuredClone(CANVAS_FIXTURE_EXAMPLE));

    expect(result).toMatchObject({ ok: true, result: { packageId: "pkg_demo_frame_intro" } });
  });

  it("keeps non-structural failures as a plain message", async () => {
    const selection = rectSelection();
    (selection.frames as any[])[0].layers[0].kind = "shape";
    selection.selectedFrameId = "frame_missing";

    const result = await packageSelection(selection);

    expect(result).toMatchObject({ ok: false, error: { code: "canvas_package_failed" } });
    expect((result as any).result).toBeUndefined();
  });

  it("publishes the accepted kinds and a working example in the argument contract", () => {
    const contract = buildDebugCommandContracts(SURFACE_COMMAND_METADATA)
      .find((candidate) => candidate.command === "motion.canvas.package");
    const description = contract?.argsSchema?.properties.selection.description ?? "";

    // The description is built from canvasFixtureContract(), so these assertions pin the published
    // text to the capability cards rather than to a list retyped into a doc string.
    for (const kind of renderableLayerTypes()) expect(description).toContain(kind);
    expect(description).toContain("shellx-canvas/frame-selection@1");
    expect(description).toContain(JSON.stringify(CANVAS_FIXTURE_EXAMPLE));
    expect(description).toContain('{"kind":"shape","shape":"rect"}');
  });
});

describe("motion.package.validate renderability verdict", () => {
  const summary = { packageId: "pkg_hand", motionId: "motion_hand", name: "Hand", layers: 1 };

  /**
   * A loaded package carrying one layer of `type`, enough for the renderability gate.
   *
   * The document is SCHEMA-COMPLETE . `motion.package.validate` now runs
   * `validateDocument` as a catch-all AFTER the renderability and keyframe verdicts — it never used
   * to run it at all, which is how it reported `valid: true` for documents the schema rejects. The
   * refusal case below still reaches its verdict either way, but the two PASS cases do not: a bare
   * `{ layers: [...] }` stub falls through to the schema and is refused for being malformed, so the
   * suite would assert nothing about renderability. An unknown layer `type` is deliberately still
   * schema-valid (the schema keeps layer types open), which is exactly why the capability-card
   * renderability check has to exist alongside the schema rather than behind it.
   */
  function loaderFor(type: string, extra: Record<string, unknown> = {}) {
    return async () => ({
      root: "/pkg",
      manifest: { compatibility: { lanes: ["browser"], hosts: ["motion"] } },
      motion: {
        schema: "shellx-motion/motion@1",
        id: "motion_hand",
        name: "Hand",
        durationMs: 1000,
        fps: 30,
        width: 640,
        height: 360,
        background: "#101820",
        assets: [],
        provenance: { sourceApp: "shellx-motion", createdBy: "test" },
        layers: [{ id: "box", type, startMs: 0, durationMs: 1000, ...extra }]
      }
    }) as unknown as MotionPackage;
  }

  it("refuses to call a package valid when no lane can render one of its layers", async () => {
    const result = await dispatchWorkspaceCommand("motion.package.validate", { packageRoot: "/pkg" }, {
      validatePackage: async () => summary,
      packageLoader: loaderFor("rect")
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "package_unrenderable", message: 'No render lane supports 1 layer: box (type "rect").' },
      result: { valid: false, unrenderableLayers: [{ layerId: "box", type: "rect" }] }
    });
  });

  it("still passes a package every layer of which some lane renders", async () => {
    const result = await dispatchWorkspaceCommand("motion.package.validate", { packageRoot: "/pkg" }, {
      validatePackage: async () => summary,
      packageLoader: loaderFor("shape")
    });

    expect(result).toMatchObject({ ok: true, result: { valid: true } });
  });

  it("matches the lanes by skipping hidden layers, as the render gate does", async () => {
    const result = await dispatchWorkspaceCommand("motion.package.validate", { packageRoot: "/pkg" }, {
      validatePackage: async () => summary,
      packageLoader: loaderFor("rect", { visible: false })
    });

    expect(result).toMatchObject({ ok: true, result: { valid: true } });
  });
});
