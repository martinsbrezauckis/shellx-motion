/**
 * The caller-supplied `receiptsRoot` fence.
 *
 * Guards a sealed security review finding: `motion.agent.transcript` accepted a caller-named receipt
 * root and used it to discover and return prompt transcripts. That command carries `read_motion`,
 * the LOWEST permission tier, so a bearer client with only read access could name any directory the
 * Motion process can read, and receive back whatever receipt-shaped JSON lived there.
 *
 * The refusal cases exercise `refuseUntrustedCallerReceiptsRoot` -- the check the loopback server
 * applies to every external request. It deliberately does not live inside `dispatchDebugCommand`,
 * because Motion re-enters that dispatcher itself (a batch render dispatches a final render per row,
 * carrying paths Motion derived), as do the CLI and in-process embedders, none of which cross a
 * privilege line. The admission cases still drive `dispatchDebugCommand` end to end, because "this
 * request is NOT refused" is only worth asserting against the real command.
 *
 * The disclosure assertions deliberately check the transcript BODY, not just the error code. A fence
 * that refused with the right code while still leaking content in some other field would satisfy a
 * code-only assertion and fail the actual requirement.
 *
 * WHAT THIS SUITE CANNOT PROVE, and where that is proven instead. Every case here calls the guard
 * FUNCTION. That is the right shape for "does the policy decide correctly", and it is the wrong
 * shape for "is the policy actually wired to the door" -- this file was green for the whole time
 * `POST /sdk` reached the engine without consulting it. Wiring is pinned over a live server in
 * `packages/debug-server/src/sdk-transport-fence.test.ts`.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dispatchDebugCommand, refuseUntrustedCallerReceiptsRoot } from "./index";

const SECRET_PROMPT = "clandestine-prompt-body-that-must-never-cross-the-fence";

let hostReceiptsRoot: string;
let foreignReceiptsRoot: string;

/** A receipt-shaped file the transcript reader would happily parse if it were allowed to look. */
async function writeTranscriptReceipt(root: string, id: string): Promise<void> {
  await writeFile(join(root, `${id}.receipt.json`), JSON.stringify({
    schema: "shellx-motion/receipt@1",
    id,
    operation: "prompt.run",
    status: "passed",
    packageId: "pkg_fence_probe",
    inputHashes: {},
    createdAt: new Date(0).toISOString(),
    lane: "prompt",
    warnings: [],
    artifacts: [],
    prompt: { request: SECRET_PROMPT, messages: [{ role: "user", text: SECRET_PROMPT }] }
  }), "utf8");
}

beforeEach(async () => {
  hostReceiptsRoot = await mkdtemp(join(tmpdir(), "motion-fence-host-"));
  foreignReceiptsRoot = await mkdtemp(join(tmpdir(), "motion-fence-foreign-"));
  await writeTranscriptReceipt(foreignReceiptsRoot, "foreign-prompt-1");
});

afterEach(async () => {
  await rm(hostReceiptsRoot, { recursive: true, force: true });
  await rm(foreignReceiptsRoot, { recursive: true, force: true });
});

describe("caller-supplied receiptsRoot fence", () => {
  it("refuses a read-tier transcript request for a receipt root outside the host's own", async () => {
    const result = await refuseUntrustedCallerReceiptsRoot(
      "motion.agent.transcript",
      foreignReceiptsRoot,
      { tier: "read_motion", receiptsRoot: hostReceiptsRoot }
    );

    expect(result?.ok).toBe(false);
    expect(result).toMatchObject({ error: { code: "invalid_args" } });
    // The whole point: no part of the response may carry what lived in the foreign root.
    expect(JSON.stringify(result)).not.toContain(SECRET_PROMPT);
  });

  it("names the trusted roots and the person who can change them, instead of only refusing", async () => {
    const result = await refuseUntrustedCallerReceiptsRoot(
      "motion.agent.transcript",
      foreignReceiptsRoot,
      { tier: "read_motion", receiptsRoot: hostReceiptsRoot }
    );

    // A caller cannot widen this set, so the refusal has to route to whoever can.
    expect(result?.ok).toBe(false);
    if (!result || result.ok) return;
    expect(result.error.detail).toMatchObject({ argument: "receiptsRoot", resolvedBy: "host_operator" });
    expect(JSON.stringify(result.error.detail)).toContain(hostReceiptsRoot);
  });

  it("refuses at the boundary when the host declared no receipt root at all", async () => {
    // This case used to assert the opposite -- null, admit it -- and the reasoning was sound about
    // the wrong function. The CLI and in-process embedders ARE the host, so refusing the root they
    // named protects nobody; that is why `dispatchDebugCommand` carries no fence, and the case below
    // ("leaves an in-process caller alone") is where that property now lives.
    //
    // But those callers never reach THIS function. Only transports do, and a transport is a
    // privilege line by definition. `startMotionDebugServer` defaults its context to `{}`, so the
    // loose form meant every library embedder's server handed a `read_motion` bearer client any
    // receipt-shaped JSON it could name. A boundary with nothing to compare against refuses.
    const result = await refuseUntrustedCallerReceiptsRoot(
      "motion.agent.transcript",
      foreignReceiptsRoot,
      { tier: "read_motion" }
    );

    expect(result?.ok).toBe(false);
    expect(result).toMatchObject({ error: { code: "capability_unavailable" } });
    expect(JSON.stringify(result)).not.toContain(SECRET_PROMPT);
  });

  it("leaves an in-process caller alone when the host declared no receipt root", async () => {
    // The counterpart to the case above, and the reason the fence is not in the dispatcher: an
    // operator typing --receipts-root at a shell is the host and could create the file directly.
    const result = await dispatchDebugCommand(
      "motion.agent.transcript",
      { receiptsRoot: foreignReceiptsRoot },
      { tier: "read_motion" }
    );

    expect(result.ok).toBe(true);
  });

  it("still refuses outright, even unconfigured, for the commands that WRITE host receipts", async () => {
    // The strict form of the policy survives where it always applied: a command that makes Motion
    // write a receipt somewhere will not be handed an unvalidatable destination.
    const result = await dispatchDebugCommand(
      "motion.timeline.playhead.set",
      { packageRoot: hostReceiptsRoot, atMs: 0, receiptsRoot: foreignReceiptsRoot },
      { tier: "draft_motion" }
    );

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ error: { code: "capability_unavailable" } });
  });

  it("admits a caller root that is inside the host's own root", async () => {
    const result = await dispatchDebugCommand(
      "motion.agent.transcript",
      { receiptsRoot: hostReceiptsRoot },
      { tier: "read_motion", receiptsRoot: hostReceiptsRoot }
    );

    // Reaches the command rather than the fence; an empty host store is a legitimate empty read.
    expect(result.ok).toBe(true);
  });

  it("admits a folder a human granted through the native chooser this session", async () => {
    // operatorReceiptRoots is how the Workbench's Browse button stays usable without reopening the
    // hole: the host adds what a person physically selected, and a caller still cannot add anything.
    const result = await dispatchDebugCommand(
      "motion.agent.transcript",
      { receiptsRoot: foreignReceiptsRoot },
      { tier: "read_motion", receiptsRoot: hostReceiptsRoot, operatorReceiptRoots: [foreignReceiptsRoot] }
    );

    expect(result.ok).toBe(true);
  });

  it("leaves a request that names no receipt root alone", async () => {
    const result = await dispatchDebugCommand(
      "motion.agent.transcript",
      {},
      { tier: "read_motion", receiptsRoot: hostReceiptsRoot }
    );

    // Nothing was nominated, so there is nothing to fence; the host's own root is used.
    expect(result.ok).toBe(true);
  });

  it("applies to every command that takes the argument, not just the one that was reported", async () => {
    // The finding named motion.agent.transcript, but ~30 commands accept receiptsRoot. Fixing only
    // the reported one would leave the class open, so the fence sits above dispatch and this test
    // pins that placement using a different domain's read command.
    const result = await refuseUntrustedCallerReceiptsRoot(
      "motion.receipts.list",
      foreignReceiptsRoot,
      { tier: "read_motion", receiptsRoot: hostReceiptsRoot }
    );

    expect(result?.ok).toBe(false);
    expect(result).toMatchObject({ error: { code: "invalid_args" } });
  });
});
