import { describe, expect, it } from "vitest";
import { loadSchema, validateDocument } from "./validate";

describe("support-bundle schema", () => {
  it("validates redacted support bundle diagnostics", async () => {
    const schema = await loadSchema("supportBundle");
    expect(schema).toMatchObject({
      name: "supportBundle",
      schema: "shellx-motion/support-bundle@1"
    });

    const bundle = {
      schema: "shellx-motion/support-bundle@1",
      createdAt: "2026-07-01T00:00:00.000Z",
      package: {
        id: "pkg_debug_timeline",
        name: "Debug Timeline",
        motionId: "motion_debug_timeline",
        sourceApp: "shellx-motion",
        compatibility: { lanes: ["native", "ffmpeg"], hosts: ["shellx-motion"] },
        motion: { durationMs: 4000, fps: 30, width: 1920, height: 1080 },
        layerCount: 1,
        assetCount: 0,
        timeline: { trackCount: 1, sceneCount: 1, markerCount: 2 },
        inputHashes: { "manifest.json": "a".repeat(64), "motion.json": "b".repeat(64) }
      },
      receipts: {
        receiptCount: 1,
        receipts: [
          {
            id: "render-final-debug",
            operation: "render.final",
            status: "passed",
            packageId: "pkg_debug_timeline",
            lane: "ffmpeg",
            createdAt: "2026-07-01T00:00:01.000Z",
            warnings: []
          }
        ]
      },
      platformVerification: {
        receiptCount: 1,
        receipts: [
          {
            schema: "shellx-motion/platform-verification@1",
            status: "passed",
            dryRun: false,
            commandCount: 1,
            failedCommandCount: 0
          }
        ]
      },
      debug: {
        commandCount: 2,
        commands: ["motion.support.bundle", "motion.package.patch"],
        actionCount: 1,
        actions: [
          { id: "motion.support.bundle", permission: "write_local", mutates: false, calls: ["motion.support.bundle"], surfaces: ["debug-api"] }
        ]
      },
      runtime: { node: "v24.0.0", platform: "linux", arch: "x64" },
      redactions: { envValues: "omitted", hostPaths: "omitted", diagnosticPaths: "redacted" }
    };

    expect(await validateDocument(schema, bundle)).toEqual({ ok: true });
    expect(await validateDocument(schema, {
      ...bundle,
      receipts: {
        ...bundle.receipts,
        receiptsRoot: "/host-private/receipts"
      }
    })).toEqual({
      ok: false,
      errors: [{ path: "/receipts/receiptsRoot", message: "unexpected property" }]
    });
    expect(await validateDocument(schema, {
      ...bundle,
      createdAt: "",
      receipts: {
        receiptCount: -1,
        receipts: [
          { id: "", operation: 42, status: "", packageId: "", lane: "", createdAt: "", warnings: ["ok", 42] }
        ]
      },
      debug: {
        commandCount: -1,
        commands: ["motion.support.bundle", 42],
        actionCount: -1,
        actions: [
          { id: "", permission: "", mutates: "yes", calls: ["motion.support.bundle", 42], surfaces: "debug-api" }
        ]
      },
      runtime: { node: "", platform: 42, arch: "" },
      redactions: { envValues: "leaked", hostPaths: "omitted", diagnosticPaths: "redacted" }
    })).toEqual({
      ok: false,
      errors: [
        { path: "/createdAt", message: "must be a non-empty string" },
        { path: "/receipts/receiptCount", message: "must be a non-negative integer" },
        { path: "/receipts/receipts/0/id", message: "must be a non-empty string" },
        { path: "/receipts/receipts/0/operation", message: "must be a non-empty string" },
        { path: "/receipts/receipts/0/status", message: "must be a non-empty string" },
        { path: "/receipts/receipts/0/packageId", message: "must be a non-empty string" },
        { path: "/receipts/receipts/0/lane", message: "must be a non-empty string" },
        { path: "/receipts/receipts/0/createdAt", message: "must be a non-empty string" },
        { path: "/receipts/receipts/0/warnings/1", message: "must be a string" },
        { path: "/debug/commandCount", message: "must be a non-negative integer" },
        { path: "/debug/commands/1", message: "must be a string" },
        { path: "/debug/actionCount", message: "must be a non-negative integer" },
        { path: "/debug/actions/0/id", message: "must be a non-empty string" },
        { path: "/debug/actions/0/permission", message: "must be a non-empty string" },
        { path: "/debug/actions/0/mutates", message: "must be a boolean" },
        { path: "/debug/actions/0/calls/1", message: "must be a string" },
        { path: "/debug/actions/0/surfaces", message: "must be an array" },
        { path: "/runtime/node", message: "must be a non-empty string" },
        { path: "/runtime/platform", message: "must be a non-empty string" },
        { path: "/runtime/arch", message: "must be a non-empty string" },
        { path: "/redactions/envValues", message: "must equal omitted" }
      ]
    });
  });

});
