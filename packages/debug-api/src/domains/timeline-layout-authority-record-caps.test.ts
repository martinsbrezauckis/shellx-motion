import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson } from "@shellx-motion/core";
import { describe, expect, it } from "vitest";
import { createHostLayoutAuthorityPairRepair } from "../internal/layout-authority-repair.js";
import {
  prepareImmutableJsonPair,
  readImmutableJsonPair,
  trustedAuthorityDirectory,
  writeImmutableJsonPair,
} from "./timeline-layout-application-authority-store.js";
import { MAX_C2_LAYOUT_AUTHORITY_RECORD_BYTES } from "./timeline-layout-authority-record-caps.js";

describe("C2 layout authority record cap", () => {
  it("uses one cap for restored-record writing, reading, discovery, and recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "layout-authority-pair-c2-cap-"));
    try {
      const directory = await trustedAuthorityDirectory(root, true);
      const atCap = c2AuthorityPayload(MAX_C2_LAYOUT_AUTHORITY_RECORD_BYTES);
      expect(Buffer.byteLength(canonicalJson(atCap), "utf8")).toBe(MAX_C2_LAYOUT_AUTHORITY_RECORD_BYTES);

      const complete = c2RestoredDescriptor(directory, atCap, "c2-restored-at-cap");
      await expect(writeImmutableJsonPair(directory, complete)).resolves.toContain(`${complete.key}.pair.json`);
      const roundTrip = await readImmutableJsonPair(directory, readDescriptor(complete));
      expect(roundTrip.recordKind).toBe("layout-gap-restored");
      expect(Buffer.byteLength(canonicalJson(roundTrip.authority), "utf8"))
        .toBe(MAX_C2_LAYOUT_AUTHORITY_RECORD_BYTES);

      const overCap = c2RestoredDescriptor(
        directory,
        c2AuthorityPayload(MAX_C2_LAYOUT_AUTHORITY_RECORD_BYTES + 1),
        "c2-restored-over-cap",
      );
      await expect(writeImmutableJsonPair(directory, overCap)).rejects.toThrow(/byte cap/i);
      await expect(readdir(directory.path)).resolves.toEqual([
        `${complete.key}.authority.json`,
        `${complete.key}.pair.json`,
        `${complete.key}.receipt.json`,
      ]);

      const interrupted = c2RestoredDescriptor(directory, atCap, "c2-restored-recovery-cap");
      await prepareImmutableJsonPair(directory, interrupted);
      const repair = createHostLayoutAuthorityPairRepair(root);
      await expect(repair.repairNextPage()).resolves.toEqual({
        actions: [{ key: interrupted.key, action: "reclaimed_preinstall_prefix" }],
        complete: true,
      });
      await expect(readImmutableJsonPair(directory, readDescriptor(interrupted)))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function c2RestoredDescriptor(
  directory: Awaited<ReturnType<typeof trustedAuthorityDirectory>>,
  authority: unknown,
  key: string,
) {
  return {
    key,
    recordKind: "layout-gap-restored",
    outputLineage: {
      path: join(directory.path, `never-installed-${key}`),
      dev: 7,
      ino: 9,
      manifestId: "never-installed-c2-package",
      manifestSha256: "a".repeat(64),
      motionSha256: "b".repeat(64),
      motionCanonicalSha256: "c".repeat(64),
    },
    receipt: { id: "c2-receipt", output: "one" },
    receiptMaximumBytes: 1024,
    authority,
    authorityMaximumBytes: MAX_C2_LAYOUT_AUTHORITY_RECORD_BYTES,
  };
}

function readDescriptor(input: {
  key: string;
  recordKind: string;
  outputLineage: unknown;
  receiptMaximumBytes: number;
  authorityMaximumBytes: number;
}) {
  return {
    key: input.key,
    recordKinds: [input.recordKind],
    outputLineage: input.outputLineage,
    receiptMaximumBytes: input.receiptMaximumBytes,
    authorityMaximumBytes: input.authorityMaximumBytes,
  };
}

function c2AuthorityPayload(maximumBytes: number): { payload: string } {
  const emptyPayloadBytes = Buffer.byteLength(canonicalJson({ payload: "" }), "utf8");
  return { payload: "x".repeat(maximumBytes - emptyPayloadBytes) };
}
