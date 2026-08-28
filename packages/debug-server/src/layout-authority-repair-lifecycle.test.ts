import { link, mkdir, mkdtemp, readdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, canonicalJsonSha256 } from "@shellx-motion/core";
import { describe, expect, it } from "vitest";
import {
  createTrustedWorkspaceAnchor,
  withTrustedWorkspaceAnchor,
} from "@shellx-motion/core/internal/trusted-host-workspace";
import { startMotionDebugServer } from "./index.js";

const CAPABILITY_TOKEN = "layout-authority-repair-host-token-0000000000000000";

describe("trusted layout authority repair lifecycle", () => {
  it("runs a real host-only repair before transport admission and never publishes a Debug command", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-layout-authority-repair-host-"));
    const serverRoot = join(root, "server-root");
    let repaired: readonly { key: string; action: string }[] | undefined;
    let server: Awaited<ReturnType<typeof startMotionDebugServer>> | undefined;
    try {
      await mkdir(join(serverRoot, ".shellx-motion-layout-authority"), { recursive: true, mode: 0o700 });
      for (let index = 0; index < 45; index += 1) {
        await seedAcceptedPair(serverRoot, `accepted-host-history-${index}`);
      }
      const input = await seedPreinstallPair(serverRoot, join(serverRoot, "never-installed-output"));
      const authority = await createTrustedWorkspaceAnchor(root);
      server = await withTrustedWorkspaceAnchor(authority, async () => await startMotionDebugServer({
          port: 0,
          capabilityToken: CAPABILITY_TOKEN,
          useDefaultTemplateRoots: false,
          context: { receiptsRoot: serverRoot, scratchRoot: serverRoot },
          async repairLayoutAuthorityPairsAtStartup(repair) {
          let complete = false;
          const actions: Array<{ key: string; action: string }> = [];
          while (!complete) {
            const page = await repair.repairNextPage();
            actions.push(...page.actions);
            complete = page.complete;
          }
          repaired = actions;
          },
      }));
      expect(repaired).toEqual([{ key: input.key, action: "reclaimed_preinstall_prefix" }]);
      const retained = await readdir(join(serverRoot, ".shellx-motion-layout-authority"));
      expect(retained).toHaveLength(135);
      expect(retained.some((name) => name.includes(input.key))).toBe(false);

      const response = await globalThis.fetch(new URL("/rpc", server.url), {
        method: "POST",
        headers: {
          authorization: `Bearer ${CAPABILITY_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "repair-lifecycle-contracts",
          method: "motion.debug.contracts",
          params: {},
        }),
      });
      await expect(response.json()).resolves.toMatchObject({
        result: {
          ok: true,
          contracts: expect.not.arrayContaining([
            expect.objectContaining({ command: "motion.layoutAuthority.repair" }),
          ]),
        },
      });
    } finally {
      await server?.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires the server host to configure the receipts root before it can request repair", async () => {
    let called = false;
    await expect(startMotionDebugServer({
      port: 0,
      capabilityToken: CAPABILITY_TOKEN,
      useDefaultTemplateRoots: false,
      repairLayoutAuthorityPairsAtStartup() {
        called = true;
      },
    })).rejects.toThrow("Layout authority repair startup requires a host-configured context.receiptsRoot.");
    expect(called).toBe(false);
  });

  it("ships the repair subpath only as an internal installed host dependency", async () => {
    const manifestPath = fileURLToPath(new URL("../../debug-api/package.json", import.meta.url));
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      exports?: Record<string, unknown>;
      publishConfig?: { exports?: Record<string, unknown> };
    };
    expect(manifest.exports?.["./internal/layout-authority-repair"])
      .toBe("./src/internal/layout-authority-repair.ts");
    expect(manifest.publishConfig?.exports?.["./internal/layout-authority-repair"])
      .toEqual({
        types: "./dist/internal/layout-authority-repair.d.ts",
        default: "./dist/internal/layout-authority-repair.js",
      });
  });
});

async function seedPreinstallPair(
  receiptsRoot: string,
  outputPath: string,
  key = "repair-fixture-pair",
): Promise<{ key: string }> {
  const authorityDirectory = join(receiptsRoot, ".shellx-motion-layout-authority");
  const rootStat = await stat(receiptsRoot);
  const root = { path: receiptsRoot, dev: rootStat.dev, ino: rootStat.ino };
  const outputLineage = {
    path: outputPath,
    dev: 123,
    ino: 456,
    manifestId: "repair-fixture-package",
    manifestSha256: "a".repeat(64),
    motionSha256: "b".repeat(64),
    motionCanonicalSha256: "c".repeat(64),
  };
  const receipt = { id: "repair-fixture-receipt" };
  const authority = { id: "repair-fixture-authority", receiptsRoot: root };
  const journal = {
    schema: "shellx-motion/timeline-layout-authority-pair@2",
    key,
    recordKind: "layout-application",
    receiptsRoot: root,
    outputLineage,
    outputLineageSha256: canonicalJsonSha256(outputLineage),
    receipt: { basename: `${key}.receipt.json`, sha256: canonicalJsonSha256(receipt) },
    authority: { basename: `${key}.authority.json`, sha256: canonicalJsonSha256(authority) },
  };
  const lock = {
    schema: "shellx-motion/timeline-layout-authority-pair-lock@1",
    key,
    receiptsRoot: root,
    nonce: "0".repeat(32),
  };
  const write = async (name: string, value: unknown): Promise<void> => {
    await writeFile(join(authorityDirectory, name), canonicalJson(value), { mode: 0o600 });
  };
  await write(`.${key}.pair.lock`, lock);
  await write(`.${key}.pair.pending`, { ...journal, schema: "shellx-motion/timeline-layout-authority-pair-pending@2" });
  await write(`.${key}.receipt.stage`, receipt);
  await write(`.${key}.authority.stage`, authority);
  await write(`.${key}.journal.stage`, journal);
  await link(join(authorityDirectory, `.${key}.receipt.stage`), join(authorityDirectory, `${key}.receipt.json`));
  await link(join(authorityDirectory, `.${key}.authority.stage`), join(authorityDirectory, `${key}.authority.json`));
  return { key };
}

async function seedAcceptedPair(receiptsRoot: string, key: string): Promise<void> {
  await seedPreinstallPair(receiptsRoot, join(receiptsRoot, `never-installed-${key}`), key);
  const authorityDirectory = join(receiptsRoot, ".shellx-motion-layout-authority");
  await link(join(authorityDirectory, `.${key}.journal.stage`), join(authorityDirectory, `${key}.pair.json`));
  await Promise.all([
    unlink(join(authorityDirectory, `.${key}.pair.pending`)),
    unlink(join(authorityDirectory, `.${key}.receipt.stage`)),
    unlink(join(authorityDirectory, `.${key}.authority.stage`)),
    unlink(join(authorityDirectory, `.${key}.journal.stage`)),
    unlink(join(authorityDirectory, `.${key}.pair.lock`)),
  ]);
}
