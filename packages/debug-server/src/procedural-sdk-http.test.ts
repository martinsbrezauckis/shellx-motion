import { createMotionSdk, createMotionSdkHttpTransport } from "@shellx-motion/sdk";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { startMotionDebugServer } from "./index.js";

const TOKEN = "procedural-sdk-http-test-token-000000000000000000";

describe("procedural SDK over authenticated loopback HTTP", () => {
  it("preserves readable evaluation, exact errors, package identity, and receipt evidence", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "shellx-motion-procedural-http-"));
    const sourceRoot = fileURLToPath(new URL("../../../fixtures/packages/procedural-relationships", import.meta.url));
    const disabledRoot = join(outputRoot, "disabled");
    const rejectedBakeRoot = join(outputRoot, "rejected-bake");
    const server = await startMotionDebugServer({
      port: 0,
      grantedTier: "edit_motion",
      capabilityToken: TOKEN,
      context: {
        authoringInputRoots: [sourceRoot, outputRoot],
        authoringOutputRoots: [outputRoot],
        renderPackageRoots: [sourceRoot, outputRoot],
      },
    });
    const sdk = createMotionSdk(createMotionSdkHttpTransport({
      baseUrl: server.url,
      capabilityToken: TOKEN,
    }));
    try {
      const inspect = await sdk.proceduralInspect({ packageRoot: sourceRoot, atMs: 500 });
      expect(inspect).toMatchObject({
        ok: true,
        output: {
          packageRoot: sourceRoot,
          state: {
            relationships: [
              { id: "time-to-x", target: { layerId: "tile", property: "transform.x" } },
              {
                id: "x-to-rotation",
                sources: [{ layerId: "tile", property: "transform.x" }],
                target: { layerId: "tile", property: "transform.rotation" },
              },
            ],
            evaluation: { atMs: 500, values: { "time-to-x": 70, "x-to-rotation": 17.5 } },
          },
        },
      });

      const disabled = await sdk.proceduralSetEnabled({
        packageRoot: sourceRoot,
        outDir: disabledRoot,
        relationshipId: "time-to-x",
        enabled: false,
      });
      expect(disabled).toMatchObject({
        ok: true,
        output: {
          packageRoot: disabledRoot,
          operation: "procedural.relationship.enabled.set",
          receipt: {
            operation: "procedural.relationship.enabled.set",
            status: "passed",
            sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          },
        },
      });
      const disabledRelationship = disabled.ok
        ? disabled.output.state.relationships.find(({ id }) => id === "time-to-x")
        : undefined;
      expect(disabledRelationship).toMatchObject({ id: "time-to-x", enabled: false });

      const rejected = await sdk.proceduralBake({
        packageRoot: disabledRoot,
        outDir: rejectedBakeRoot,
        relationshipIds: ["time-to-x"],
      });
      expect(rejected).toMatchObject({
        ok: false,
        error: {
          code: "procedural_relationship_bake_failed",
          message: expect.stringMatching(/must be enabled/i),
        },
      });
    } finally {
      await server.close();
      await rm(outputRoot, { recursive: true, force: true });
    }
  });
});
