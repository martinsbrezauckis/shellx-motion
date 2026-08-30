import { createMotionSdk, createMotionSdkHttpTransport, MOTION_SDK_SCHEMA, motionSdkCacheKey } from "@shellx-motion/sdk";
import { cp, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
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

  it("refuses hostile property paths on an authenticated raw SDK route before package access", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "shellx-motion-procedural-http-hostile-"));
    const sourceRoot = join(outputRoot, "source");
    await cp(fileURLToPath(new URL("../../../fixtures/packages/procedural-relationships", import.meta.url)), sourceRoot, { recursive: true });
    const server = await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(outputRoot), async () =>
      await startMotionDebugServer({
        port: 0,
        grantedTier: "edit_motion",
        capabilityToken: TOKEN,
        useDefaultTemplateRoots: false,
        context: {
          scratchRoot: join(outputRoot, "scratch"),
          authoringInputRoots: [sourceRoot, outputRoot],
          authoringOutputRoots: [outputRoot],
          renderPackageRoots: [sourceRoot, outputRoot],
        },
      }),
    );
    try {
      const hostileInput = {
        packageRoot: sourceRoot,
        outDir: join(outputRoot, "hostile-output"),
        relationship: {
          id: "hostile",
          enabled: true,
          target: { layerId: "tile", property: "__proto__.sdk_placeholder_polluted" },
          nodes: [{ id: "value", type: "constant", value: 1 }],
          outputNodeId: "value",
        },
      };
      const cacheKey = await motionSdkCacheKey("proceduralSet", hostileInput);
      const raw = await fetch(new URL("/sdk", server.url), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({
          schema: MOTION_SDK_SCHEMA,
          operation: "proceduralSet",
          requestId: `sdk-proceduralSet-${cacheKey.slice(0, 20)}`,
          cacheKey,
          input: hostileInput,
        }),
      });
      expect(raw.status).toBe(400);
      await expect(raw.json()).resolves.toMatchObject({
        ok: false,
        error: {
          code: "invalid_sdk_request",
          message: expect.stringMatching(/target\/property.*allow-listed numeric property/i),
        },
      });
      await expect(stat(hostileInput.outDir)).rejects.toMatchObject({ code: "ENOENT" });
      expect((Object.prototype as { sdk_placeholder_polluted?: unknown }).sdk_placeholder_polluted).toBeUndefined();
    } finally {
      await server.close();
      await rm(outputRoot, { recursive: true, force: true });
    }
  });
});
