/**
 * The shipped server declares where receipts live, and the fence holds even if it stops.
 *
 * WHAT THIS FILE USED TO ASSERT, AND WHY THAT WAS NOT ENOUGH. The Debug API fences a caller-supplied
 * `receiptsRoot` against the roots the HOST declared. The looser form of that policy admitted the
 * caller's root whenever the host had declared none, on the reasoning that an undeclared host is one
 * where caller and host are the same party -- true of the CLI and in-process embedders. So the
 * fence's correctness on the network surface rested entirely on the shipped server declaring a root,
 * and this file guarded that by reading `cli.ts` as TEXT: asserting the source contained
 * `ensureMotionReceiptsRoot` and matched a regex for the context literal.
 *
 * A source-text assertion proves a string, not a property. It would have passed with the call
 * present and the server never started; it said nothing about what a root-less server actually does;
 * and it was the only thing standing between a library embedder -- `startMotionDebugServer` defaults
 * `context` to `{}` -- and a `read_motion` bearer client reading any receipt-shaped JSON on the
 * machine. That embedder case was real and demonstrated.
 *
 * Fixed at the boundary rather than by leaning harder on the declaration: the transport now applies
 * the STRICT form, which refuses when the host declared nothing. The declaration is still worth
 * pinning -- it is where the shipped product's receipts go -- but it is no longer load-bearing for
 * containment, and this file now asserts the containment property against a running server instead
 * of asserting a string about a file.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startMotionDebugServer } from "./index.js";
import { ensureMotionReceiptsRoot, motionUserAccessPaths } from "./user-access";

const TOKEN = "receipts-root-declaration-test-token-00000000000";
const VICTIM_MARKER = "victim-marker-that-a-rootless-server-must-never-serve";

const accessRoots: string[] = [];
const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const root of accessRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** A receipt-shaped file a transcript or status read would return if it were allowed to look. */
async function seedVictimReceipt(root: string): Promise<void> {
  await writeFile(join(root, "victim.receipt.json"), `${JSON.stringify({
    schema: "shellx-motion/receipt@1",
    id: "victim-1",
    operation: "prompt.run",
    status: "passed",
    packageId: VICTIM_MARKER,
    inputHashes: {},
    createdAt: "2026-07-01T00:00:00.000Z",
    lane: "prompt",
    warnings: []
  }, null, 2)}\n`, "utf8");
}

describe("shipped server receipt-root declaration", () => {
  it("derives a receipts root under the Motion user access root", () => {
    // Same private directory that already holds the access token and the published port, so the
    // receipt store inherits its 0700 ownership rather than landing somewhere world-readable.
    const paths = motionUserAccessPaths("/example/.shellx-motion");

    expect(paths.receiptsRoot).toBe(join("/example/.shellx-motion", "receipts"));
  });

  it("creates that root so a first run has somewhere to put receipts", async () => {
    const accessRoot = await mkdtemp(join(tmpdir(), "motion-access-"));
    accessRoots.push(accessRoot);
    const paths = motionUserAccessPaths(accessRoot);

    const created = await ensureMotionReceiptsRoot(paths);

    expect(created).toBe(paths.receiptsRoot);
    const { stat } = await import("node:fs/promises");
    expect((await stat(created)).isDirectory()).toBe(true);
  });

  it("is idempotent, because every start calls it", async () => {
    const accessRoot = await mkdtemp(join(tmpdir(), "motion-access-"));
    accessRoots.push(accessRoot);
    const paths = motionUserAccessPaths(accessRoot);

    await ensureMotionReceiptsRoot(paths);
    await expect(ensureMotionReceiptsRoot(paths)).resolves.toBe(paths.receiptsRoot);
  });

  it("refuses a foreign receipts root even when the host declared none", async () => {
    // The replacement for the source-text assertion. This is the property the old test was standing
    // in for, and unlike the string it holds no matter what `cli.ts` says: a bearer client on a
    // server with nothing declared cannot name a directory and read it.
    const foreignRoot = await mkdtemp(join(tmpdir(), "motion-rootless-foreign-"));
    accessRoots.push(foreignRoot);
    await seedVictimReceipt(foreignRoot);
    const server = await startMotionDebugServer({ port: 0, grantedTier: "read_motion", capabilityToken: TOKEN });
    servers.push(server);

    const response = await fetch(new URL("/debug", server.url), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ command: "motion.agent.transcript", args: { receiptsRoot: foreignRoot } })
    });
    const text = await response.text();

    expect(JSON.parse(text)).toMatchObject({ ok: false, error: { code: "capability_unavailable" } });
    expect(text).not.toContain(VICTIM_MARKER);
  });

  it("serves the root it declared, so declaring one is what makes reads possible", async () => {
    // The other half: a declared root is not merely tolerated, it is the thing the fence measures
    // against. Without this case, "refuse everything" would pass the case above.
    const declaredRoot = await mkdtemp(join(tmpdir(), "motion-declared-"));
    accessRoots.push(declaredRoot);
    await seedVictimReceipt(declaredRoot);
    const server = await startMotionDebugServer({
      port: 0,
      grantedTier: "read_motion",
      capabilityToken: TOKEN,
      context: { receiptsRoot: declaredRoot }
    });
    servers.push(server);

    const response = await fetch(new URL("/debug", server.url), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ command: "motion.agent.transcript", args: { receiptsRoot: declaredRoot } })
    });

    expect(await response.json()).toMatchObject({ ok: true });
  });
});
