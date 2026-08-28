import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createTrustedWorkspaceAnchor,
  withTrustedWorkspaceAnchor,
} from "@shellx-motion/core/internal/trusted-host-workspace";
import { startMotionDebugServer } from "./index";

const CAPABILITY_TOKEN = "test-capability-token-000000000000000000000000";
const EDITABLE_LOWER_THIRD = resolve(
  fileURLToPath(import.meta.url),
  "../../../../fixtures/packages/editable-lower-third",
);
const REFUSAL = "motion.package.patch reserves /layoutGapAnimation for the typed layout gap animation lifecycle.";

describe("layout-gap package patch transport reservation", () => {
  it("refuses root insertion over Debug HTTP and nested paths over MCP before COW output or host receipt publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-layout-gap-patch-transports-"));
    const serverRoot = join(root, "server-root");
    const httpOut = join(serverRoot, "http-output");
    const mcpOut = join(serverRoot, "mcp-output");
    await mkdir(serverRoot, { mode: 0o700 });
    const authority = await createTrustedWorkspaceAnchor(root);
    const server = await withTrustedWorkspaceAnchor(authority, async () => await startMotionDebugServer({
      port: 0,
      capabilityToken: CAPABILITY_TOKEN,
      grantedTier: "edit_motion",
      useDefaultTemplateRoots: false,
      context: {
        scratchRoot: serverRoot,
        authoringInputRoots: [EDITABLE_LOWER_THIRD],
        authoringOutputRoots: [serverRoot],
      },
    }));
    try {
      const http = await globalThis.fetch(new URL("/debug", server.url), {
        method: "POST",
        headers: {
          authorization: `Bearer ${CAPABILITY_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          command: "motion.package.patch",
          requestedTier: "edit_motion",
          args: {
            packageRoot: EDITABLE_LOWER_THIRD,
            outDir: httpOut,
            patch: [{ op: "add", path: "/layoutGapAnimation", value: { schema: "shellx-motion/layout-gap-animation@1", tracks: [] } }],
          },
        }),
      });
      expect(http.status).toBe(400);
      await expect(http.json()).resolves.toMatchObject({
        ok: false,
        error: { code: "invalid_args", message: REFUSAL },
      });

      const mcp = await globalThis.fetch(new URL("/rpc", server.url), {
        method: "POST",
        headers: {
          authorization: `Bearer ${CAPABILITY_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "layout-gap-patch",
          method: "tools/call",
          params: {
            name: "motion_package_patch",
            arguments: {
              requestedTier: "edit_motion",
              args: {
                packageRoot: EDITABLE_LOWER_THIRD,
                outDir: mcpOut,
                patch: [{ op: "replace", path: "/layoutGapAnimation/tracks/0", value: {} }],
              },
            },
          },
        }),
      });
      expect(mcp.status).toBe(200);
      await expect(mcp.json()).resolves.toMatchObject({
        result: {
          isError: true,
          structuredContent: {
            ok: false,
            command: "motion.package.patch",
            error: { code: "invalid_args", message: REFUSAL },
          },
        },
      });
      await expect(readdir(httpOut)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readdir(mcpOut)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
