/**
 * `POST /sdk` is a transport, so it is a privilege boundary, so it is fenced.
 *
 * WHY THIS FILE EXISTS AS A SERVER TEST RATHER THAN A UNIT TEST. The receipts-root fence already had
 * a suite -- `packages/debug-api/src/receipts-root-fence.test.ts` -- and it passed while `POST /sdk`
 * served a foreign receipts root to a `read_motion` bearer client. It passed because it called the
 * guard function directly. A guard that is never wired is indistinguishable from a guard that is
 * wired, when the test calls the guard itself. So every case here drives a LIVE server over HTTP and
 * asserts on the wire answer: the only shape of test that can tell "the check exists" from "the
 * check runs".
 *
 * Three properties are pinned:
 *   1. a foreign `receiptsRoot` in the SDK body is refused, and the victim's bytes do not appear
 *      anywhere in the response (a fence that refuses with the right code while leaking through some
 *      other field would satisfy a code-only assertion and fail the actual requirement);
 *   2. the fence covers EVERY SDK operation, not the one that was reported -- `/sdk` does not
 *      restrict input fields per operation, so `input.receiptsRoot` is reachable on all of them;
 *   3. a server that declared no receipts root at all still refuses. `startMotionDebugServer`
 *      defaults its context to `{}`, so a library embedder had no declaration and the shared policy's
 *      "a host that declares nothing is one where caller and host are the same party" reasoning --
 *      true for the CLI and in-process embedders -- was false here.
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MOTION_SDK_SCHEMA, type MotionSdkOperation } from "@shellx-motion/sdk";
import { motionSdkCacheKey } from "@shellx-motion/sdk";
import { startMotionDebugServer } from "./index.js";
import { SDK_OPERATION_TIER } from "./sdk-operation-policy.js";

const TOKEN = "sdk-transport-fence-test-token-0000000000000000";
/** Marker that only ever exists inside the victim's receipt store. */
const VICTIM_MARKER = "victim-only-package-id-that-must-not-cross-the-fence";

let hostRoot: string;
let victimRoot: string;
const servers: Array<{ close: () => Promise<void> }> = [];

interface SdkAnswer { status: number; body: Record<string, unknown>; text: string }

/**
 * Send one canonical SDK request over the wire.
 *
 * Builds `cacheKey`/`requestId` the way the SDK client does, because `/sdk` refuses a body whose
 * cache key does not match its input -- a hand-written body would be rejected before ever reaching
 * the fence, which would make this suite pass for the wrong reason.
 */
async function postSdk(url: URL, operation: MotionSdkOperation, input: unknown): Promise<SdkAnswer> {
  const cacheKey = await motionSdkCacheKey(operation, input);
  const response = await fetch(new URL("/sdk", url), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      schema: MOTION_SDK_SCHEMA,
      operation,
      requestId: `sdk-${operation}-${cacheKey.slice(0, 20)}`,
      cacheKey,
      input
    })
  });
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) as Record<string, unknown>, text };
}

/** A render.final receipt the render-status reader will happily report if it is allowed to look. */
async function writeVictimJobReceipt(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "victim.receipt.json"), `${JSON.stringify({
    schema: "shellx-motion/receipt@1",
    id: "render-final-victim",
    operation: "render.final",
    status: "passed",
    packageId: VICTIM_MARKER,
    inputHashes: { motion: "a".repeat(64) },
    createdAt: "2026-07-01T00:00:00.000Z",
    lane: "ffmpeg",
    output: { path: join(root, "victim.mp4"), preset: "mp4-h264" },
    warnings: []
  }, null, 2)}\n`, "utf8");
}

beforeEach(async () => {
  hostRoot = await mkdtemp(join(tmpdir(), "motion-sdk-fence-host-"));
  victimRoot = await mkdtemp(join(tmpdir(), "motion-sdk-fence-victim-"));
  await writeVictimJobReceipt(victimRoot);
});

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  await rm(hostRoot, { recursive: true, force: true });
  await rm(victimRoot, { recursive: true, force: true });
});

async function startFencedServer(context?: Record<string, unknown>, grantedTier: "read_motion" | "push_remote" = "push_remote"): Promise<URL> {
  const server = await startMotionDebugServer({
    port: 0,
    grantedTier,
    capabilityToken: TOKEN,
    ...(context ? { context } : {})
  });
  servers.push(server);
  return server.url;
}

describe("POST /sdk is a fenced transport", () => {
  it("closes the reported case exactly: read_motion, declared host root, foreign root in the body", async () => {
    // The demonstrated exploit, reproduced at its original tier. `/debug` already refused this
    // request; `/sdk` answered 200 with the victim's job records.
    const url = await startFencedServer({ receiptsRoot: hostRoot }, "read_motion");

    const answer = await postSdk(url, "status", { receiptsRoot: victimRoot });

    expect(answer.body).toMatchObject({ ok: false });
    expect(answer.text).not.toContain(VICTIM_MARKER);
  });

  it("refuses a foreign receiptsRoot and discloses none of it", async () => {
    const url = await startFencedServer({ receiptsRoot: hostRoot });

    const answer = await postSdk(url, "status", { receiptsRoot: victimRoot });

    expect(answer.body).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    expect(answer.text).not.toContain(VICTIM_MARKER);
  });

  it("still serves the host's own receipts root, so the fence is a fence and not a wall", async () => {
    await writeVictimJobReceipt(hostRoot);
    const url = await startFencedServer({ receiptsRoot: hostRoot });

    const answer = await postSdk(url, "status", { receiptsRoot: hostRoot });

    expect(answer.body).toMatchObject({ ok: true });
    expect(answer.text).toContain(VICTIM_MARKER);
  });

  it("names the trusted roots and the operator who can widen them", async () => {
    const url = await startFencedServer({ receiptsRoot: hostRoot });

    const answer = await postSdk(url, "status", { receiptsRoot: victimRoot });

    const error = (answer.body as { error: { detail?: unknown } }).error;
    expect(error.detail).toMatchObject({ argument: "receiptsRoot", resolvedBy: "host_operator" });
    expect(JSON.stringify(error.detail)).toContain(hostRoot);
  });

  it("covers every SDK operation, because /sdk does not restrict input fields per operation", async () => {
    // The reported case was `status`. `cancel` and `timelineEdit` take the same argument, and
    // `readSdkRequest` validates only the cache key -- not the field set -- so `input.receiptsRoot`
    // rides on any operation. Enumerating the operation table is what keeps an operation added
    // tomorrow inside the fence without its author knowing this file exists.
    const url = await startFencedServer({ receiptsRoot: hostRoot });

    const admitted: string[] = [];
    for (const operation of Object.keys(SDK_OPERATION_TIER) as MotionSdkOperation[]) {
      const answer = await postSdk(url, operation, { receiptsRoot: victimRoot });
      const body = answer.body as { ok?: boolean; error?: { code?: string } };
      if (body.ok !== false || body.error?.code !== "invalid_args") admitted.push(operation);
      expect(answer.text).not.toContain(VICTIM_MARKER);
    }

    expect(admitted).toEqual([]);
  });

  it("refuses a foreign receiptsRoot on a server that declared no root at all", async () => {
    // `startMotionDebugServer` defaults `context` to `{}`. The shipped CLI passes a root, so the
    // shipped product was safe and every library embedder was not. A boundary with nothing to
    // compare against must refuse, not admit: "caller and host are the same party" is exactly the
    // thing that is not true on a loopback server behind a bearer token.
    const url = await startFencedServer();

    const answer = await postSdk(url, "status", { receiptsRoot: victimRoot });

    expect(answer.body).toMatchObject({ ok: false, error: { code: "capability_unavailable" } });
    expect(answer.text).not.toContain(VICTIM_MARKER);
  });

  it("refuses a foreign receiptsRoot on POST /debug for a server that declared no root", async () => {
    // Same defect, other transport: the fail-open was in the shared boundary guard, so proving it
    // closed on one route only would leave the other three to be re-discovered.
    const url = await startFencedServer();

    const response = await fetch(new URL("/debug", url), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ command: "motion.render.status", args: { receiptsRoot: victimRoot } })
    });
    const text = await response.text();

    expect(JSON.parse(text)).toMatchObject({ ok: false, error: { code: "capability_unavailable" } });
    expect(text).not.toContain(VICTIM_MARKER);
  });

  it("does not let motion.render.batch turn a caller-named outDir into a readable receipt store", async () => {
    // `motion.render.batch` derives `receiptsRoot = join(outDir, "receipts")` from an outDir the
    // caller names, which is the command's declared purpose (put the renders here). What would make
    // it a disclosure primitive is reading that store back, and the fence is what stops that: the
    // batch store is outside every host root, so naming it is refused on the way back in.
    const url = await startFencedServer({ receiptsRoot: hostRoot });
    const batchOut = join(victimRoot, "batch-out");

    const answer = await postSdk(url, "status", { receiptsRoot: join(batchOut, "receipts") });

    expect(answer.body).toMatchObject({ ok: false, error: { code: "invalid_args" } });
  });
});
