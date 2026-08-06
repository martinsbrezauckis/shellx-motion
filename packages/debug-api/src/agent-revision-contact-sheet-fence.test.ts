/**
 * `contactSheetPath` must not be a filesystem oracle.
 *
 * `motion.agent.revision.plan` (permission `write_local`) accepts a path to contact-sheet critique
 * JSON, and the evidence reader behind it does a plain readFile plus JSON.parse. Its answers are
 * distinguishable -- "not found at path" for a missing or unreadable file, a shape complaint for one
 * that parsed -- so an unfenced version tells a caller whether an arbitrary path exists and whether
 * it holds JSON of a given shape.
 *
 * Two containment layers are asserted here, deliberately, because they are not the same claim:
 *
 *   - the DOMAIN gate (`domains/agent-revision.ts`) refuses a path outside the host's trusted input
 *     roots -- scratch root, quality input roots, receipts root -- BEFORE any file is opened. Contact
 *     sheets are render artifacts, so that set is deliberately wider than `receiptsRoot` alone;
 *     fencing this argument to `receiptsRoot` the way `qualityReceiptPath` is fenced would refuse
 *     the ordinary place a contact sheet lives.
 *   - the READER (`readAgentRevisionContactSheet` in `index.ts`) re-checks the same roots, so the
 *     helper is not a hole waiting for a second caller that forgets the gate.
 *
 * The oracle assertion is the point: an out-of-root path that EXISTS and an out-of-root path that
 * does not must produce the same answer. Asserting only "it refuses" would pass on a fence that
 * refused with two different messages.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dispatchDebugCommand } from "./index";

let hostRoot: string;
let scratchRoot: string;
let foreignRoot: string;

beforeEach(async () => {
  hostRoot = await mkdtemp(join(tmpdir(), "motion-contact-host-"));
  scratchRoot = await mkdtemp(join(tmpdir(), "motion-contact-scratch-"));
  foreignRoot = await mkdtemp(join(tmpdir(), "motion-contact-foreign-"));
  await writeFile(join(foreignRoot, "sheet.json"), JSON.stringify({ status: "approved", path: "/tmp/sheet.png" }), "utf8");
});

afterEach(async () => {
  for (const root of [hostRoot, scratchRoot, foreignRoot]) await rm(root, { recursive: true, force: true });
});

async function planWithContactSheet(contactSheetPath: string) {
  return dispatchDebugCommand(
    "motion.agent.revision.plan",
    { packageId: "pkg_contact", receiptsRoot: hostRoot, contactSheetPath },
    { tier: "write_local", receiptsRoot: hostRoot, scratchRoot }
  );
}

describe("contactSheetPath containment", () => {
  it("refuses a path outside every trusted input root", async () => {
    const result = await planWithContactSheet(join(foreignRoot, "sheet.json"));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_args");
  });

  it("answers identically whether the out-of-root file exists or not", async () => {
    // This is what closes the oracle. Two paths, one real and one not, both outside the roots.
    const present = await planWithContactSheet(join(foreignRoot, "sheet.json"));
    const absent = await planWithContactSheet(join(foreignRoot, "no-such-sheet.json"));

    expect(present.ok).toBe(false);
    expect(absent.ok).toBe(false);
    if (!present.ok && !absent.ok) {
      expect(present.error.code).toBe(absent.error.code);
      expect(present.error.message).toBe(absent.error.message);
      // And neither answer may quote the path back, which would confirm what was probed.
      expect(present.error.message).not.toContain(foreignRoot);
    }
  });

  it("discloses nothing about a readable system file", async () => {
    const result = await planWithContactSheet("/etc/passwd");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(JSON.stringify(result.error)).not.toContain("root:");
  });

  it("still accepts a contact sheet in the host's scratch root, where they actually live", async () => {
    // The fence has to leave the feature working. A contact sheet is a render artifact, so the
    // trusted set is the input roots, not `receiptsRoot` alone.
    await writeFile(join(scratchRoot, "sheet.json"), JSON.stringify({
      status: "needs_revision",
      path: join(scratchRoot, "sheet.png"),
      notes: ["frame 12 is muddy"]
    }), "utf8");

    const result = await planWithContactSheet(join(scratchRoot, "sheet.json"));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(JSON.stringify(result.result)).toContain("frame 12 is muddy");
    }
  });

  it("still accepts a contact sheet inside the receipts root", async () => {
    await writeFile(join(hostRoot, "sheet.json"), JSON.stringify({
      status: "approved",
      path: join(hostRoot, "sheet.png")
    }), "utf8");

    const result = await planWithContactSheet(join(hostRoot, "sheet.json"));

    expect(result.ok).toBe(true);
  });
});
