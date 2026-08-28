/**
 * The Workbench reads the receipt folder the HOST declared, and never one the browser invented.
 *
 * THE DEFECT THIS PINS. The Inspector and History markup shipped a literal `.scratch/receipts` as the
 * starting value of the receipt-location display, and the pages sent that string as `receiptsRoot` on
 * every `motion.render.queue`, `motion.receipts.panel` and `motion.receipts.list` call they made
 * before a person clicked Browse. Once the receipts fence moved to the transport boundary
 * (`caller-boundary.ts`, applying `receipts-root-policy.ts` to every caller-named root, not only the
 * four `draft_motion` writers), that literal became exactly what the fence exists to refuse: a root
 * the CALLER named, outside every root the host named. Three page loads produced five refusals, the
 * browser console logged five `400 Bad Request` entries, and the human pages showed no receipts at
 * all on any server whose receipts live somewhere other than `./.scratch/receipts` — which is every
 * shipped server, because the CLI derives its root under the Motion user access directory.
 *
 * The fence was right; the page was wrong. A browser cannot nominate a receipts root, so it must be
 * TOLD one: `GET /debug/contracts` now publishes the host's own root, and the pages adopt it.
 *
 * WHY THESE ASSERTIONS AND NOT A SCREENSHOT. The failure was invisible to every existing test because
 * each half was individually correct — the fence refused what it should refuse, and the markup was
 * well-formed. Only the pairing was wrong. So this file asserts the pairing: that the value the
 * server publishes is a value the fence accepts, and that the markup carries no value of its own.
 * The last test keeps the fence honest in the same breath, so a future "helpful default" in the HTML
 * cannot be made to pass by loosening the policy instead.
 *
 * Dependencies: `./index` (a real loopback server) and the shipped `workbench/*.html`.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { startMotionDebugServer, type MotionDebugServerHandle } from "./index";

const TEST_CAPABILITY_TOKEN = "workbench-receipts-root-token-000000000000000000";
/** Stable host identity for receipts owned by this Workbench fixture. */
const TEST_CALLER_ID = "debug-server:workbench-receipts-root";

const servers: MotionDebugServerHandle[] = [];
const roots: string[] = [];
/** Receipt-backed reads use the Linux-only descriptor-relative stable reader. */
const itLinux = process.platform === "linux" ? it : it.skip;

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** A real, minimal `shellx-motion/receipt@1` file, so the readers have something to answer with. */
async function seedReceipt(root: string): Promise<void> {
  await writeFile(join(root, "render.receipt.json"), `${JSON.stringify({
    schema: "shellx-motion/receipt@1",
    id: "render-receipts-root-seed",
    operation: "render.final",
    status: "passed",
    packageId: "pkg_receipts_root",
    lane: "ffmpeg",
    createdAt: "2026-08-06T00:00:00.000Z",
    inputHashes: { motion: "a".repeat(64) },
    output: { path: join(root, "render.mp4"), callerId: TEST_CALLER_ID },
    artifacts: [{ role: "rendered_media", path: join(root, "render.mp4"), status: "available", mediaType: "video/mp4", primary: true }],
    warnings: []
  }, null, 2)}\n`, "utf8");
}

/** Start a real loopback server whose host receipts root is a directory only this test knows about. */
async function hostedServer(options: { declareReceiptsRoot: boolean }) {
  const tempRoot = await mkdtemp(join(tmpdir(), "motion-receipts-root-"));
  roots.push(tempRoot);
  const receiptsRoot = join(tempRoot, "receipts");
  // This is the host-declared trusted receipts root. Pin a private fixture mode so the authority
  // assertion is independent of the operator's umask.
  await mkdir(receiptsRoot, { recursive: true, mode: 0o700 });
  await seedReceipt(receiptsRoot);
  const handle = await startMotionDebugServer({
    host: "127.0.0.1",
    port: 0,
    capabilityToken: TEST_CAPABILITY_TOKEN,
    grantedTier: "write_local",
    context: options.declareReceiptsRoot ? { receiptsRoot, callerId: TEST_CALLER_ID } : { callerId: TEST_CALLER_ID }
  });
  servers.push(handle);

  const contracts = async (): Promise<Record<string, unknown>> => {
    const response = await fetch(new URL("/debug/contracts", handle.url), {
      headers: { authorization: `Bearer ${TEST_CAPABILITY_TOKEN}` }
    });
    return await response.json() as Record<string, unknown>;
  };
  const dispatch = async (command: string, args: unknown) => {
    const response = await fetch(new URL("/debug", handle.url), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TEST_CAPABILITY_TOKEN}` },
      body: JSON.stringify({ command, args, requestedTier: "read_motion" })
    });
    return {
      status: response.status,
      body: await response.json() as { ok: boolean; error?: { code: string; message: string } }
    };
  };
  return { receiptsRoot, contracts, dispatch };
}

/** The receipt-location display as the browser first sees it, read from the shipped markup. */
async function receiptsRootDisplay(file: string): Promise<string> {
  const html = await readFile(fileURLToPath(new URL(`../workbench/${file}`, import.meta.url)), "utf8");
  const match = html.match(/<output id="receiptsRoot"[^>]*>/);
  expect(match, `${file} must still carry a #receiptsRoot display.`).not.toBeNull();
  return match![0];
}

describe("Workbench receipt location", () => {
  it("publishes the host's own receipts root on /debug/contracts", async () => {
    const server = await hostedServer({ declareReceiptsRoot: true });
    const body = await server.contracts();
    // Absolute: a relative string means nothing to a browser that does not share the server's cwd.
    expect(body.receiptsRoot).toBe(resolve(server.receiptsRoot));
  });

  it("omits the receipts root when the host declared none", async () => {
    // The honest state, and the one the fence forces: an undeclared host has no root to offer, so the
    // page must show "no receipt location selected" rather than adopt a value.
    const server = await hostedServer({ declareReceiptsRoot: false });
    expect(await server.contracts()).not.toHaveProperty("receiptsRoot");
  });

  itLinux("accepts the published root on every read the human pages make", async () => {
    const server = await hostedServer({ declareReceiptsRoot: true });
    const published = (await server.contracts()).receiptsRoot as string;
    // The three commands the Inspector and History pages issue with a receipts root. Each one 400'd
    // with the markup's invented default; each must succeed with the value the server published.
    for (const [command, args] of [
      ["motion.render.queue", { receiptsRoot: published }],
      ["motion.receipts.panel", { receiptsRoot: published, limit: 20 }],
      ["motion.receipts.list", { receiptsRoot: published }]
    ] as const) {
      const answer = await server.dispatch(command, args);
      expect(answer.status, `${command} must accept the published host receipts root.`).toBe(200);
      expect(answer.body.ok, `${command} refused the published host receipts root: ${answer.body.error?.message}`).toBe(true);
    }
  });

  it("ships no invented receipts path in the human markup", async () => {
    // Both pages, because the literal lived in both and fixing one would leave the defect shipping.
    for (const file of ["index.html", "history.html"]) {
      const display = await receiptsRootDisplay(file);
      expect(display, `${file} must not bake a receipts path into the page.`).toContain('data-path=""');
      expect(display).not.toContain(".scratch/receipts");
    }
  });

  it("still refuses a root the browser names for itself", async () => {
    // The other half of the pairing. If a future change re-adds a default to the markup, this test
    // says what will happen to it — and it must not be made to pass by widening the fence.
    const server = await hostedServer({ declareReceiptsRoot: true });
    const answer = await server.dispatch("motion.receipts.list", { receiptsRoot: ".scratch/receipts" });
    expect(answer.status).toBe(400);
    expect(answer.body.error?.code).toBe("invalid_args");
    expect(answer.body.error?.message).toContain("trusted host receipts root");
  });
});
