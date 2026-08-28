/**
 * Contract for the single receipt-status rule shared by every rendering surface.
 *
 * These tests are written against the RULE, not against any one surface, and then the last block
 * proves the three surfaces agree — because "three surfaces disagreed about what a status means" is
 * the defect, and a test that only checked the predicate could pass while a surface still bypassed it.
 */
import { describe, expect, it } from "vitest";
import {
  actionableReceiptWarnings,
  escalateReceiptStatusForWarnings,
  isEncoderChatterWarning,
  receiptStatusForWarnings
} from "./receipt-status";
import { createRenderReceipt, previewReceiptStatus } from "./receipts";

/** A routine progress entry which is harmless only when it does not carry a component diagnostic. */
const PROGRESS_CHATTER = "frame=  270 fps=54 q=28.0 size=    1024kB";
/** The same exact faststart notice after pointer normalization. */
const NORMALISED_FASTSTART_CHATTER = "[mp4 @ [address]] Starting second pass: moving the moov atom to the beginning of the file";
/** The same line before normalization, as FFmpeg 6.1.1 prints it on Linux. */
const RAW_FASTSTART_CHATTER = "[mp4 @ 0x641500efbe80] Starting second pass: moving the moov atom to the beginning of the file";
/** The Windows spelling: the instance pointer arrives without the `0x` prefix. */
const WINDOWS_FASTSTART_CHATTER = "[mp4 @ 641500efbe80] Starting second pass: moving the moov atom to the beginning of the file";
/** A real palettegen warning retained by `summarizeSuccessfulEncodeStderr`. */
const NORMALISED_PALETTEGEN_WARNING = "[Parsed_palettegen_1 @ [address]] Duped color: FFDCDDE0";
/** A real muxer warning retained by `summarizeSuccessfulEncodeStderr`. */
const NORMALISED_DTS_WARNING = "[mp4 @ [address]] Non-monotonous DTS in output stream 0:0; previous: 1024, current: 512;";
/** A real Motion advisory that must always escalate. */
const MOTION_DENSITY = "Rendered motion is static for 74.4% of its duration (2.233s of 3.000s).";
/** The colour observation this rule now has to carry. */
const COLOUR_MISMATCH =
  "Delivered mp4-hevc colour does not match the sdr-bt709 profile the preset declares: missing transfer, primaries.";

describe("isEncoderChatterWarning", () => {
  it("recognises FFmpeg's progress line", () => {
    expect(isEncoderChatterWarning(PROGRESS_CHATTER)).toBe(true);
  });

  it("recognises the exact faststart notice in every instance-pointer spelling", () => {
    // All three must match: normalization rewrites the pointer, and Windows prints it without `0x`.
    expect(isEncoderChatterWarning(NORMALISED_FASTSTART_CHATTER)).toBe(true);
    expect(isEncoderChatterWarning(RAW_FASTSTART_CHATTER)).toBe(true);
    expect(isEncoderChatterWarning(WINDOWS_FASTSTART_CHATTER)).toBe(true);
    expect(isEncoderChatterWarning("[mov @ [address]] Starting second pass: moving the moov atom to the beginning of the file")).toBe(true);
    expect(isEncoderChatterWarning("[ipod @ 0x1] Starting second pass: moving the moov atom to the beginning of the file")).toBe(true);
  });

  it("does not hide retained component diagnostics or diagnostics joined to routine chatter", () => {
    // These messages survive `summarizeSuccessfulEncodeStderr`, so a passed receipt must escalate.
    expect(isEncoderChatterWarning(NORMALISED_PALETTEGEN_WARNING)).toBe(false);
    expect(isEncoderChatterWarning(NORMALISED_DTS_WARNING)).toBe(false);
    expect(isEncoderChatterWarning("[libvpx-vp9 @ [address]] Neither bitrate nor constrained quality specified")).toBe(false);
    expect(isEncoderChatterWarning(`${NORMALISED_FASTSTART_CHATTER} ${NORMALISED_DTS_WARNING}`)).toBe(false);
    expect(isEncoderChatterWarning(`${PROGRESS_CHATTER} ${NORMALISED_DTS_WARNING}`)).toBe(false);
    expect(isEncoderChatterWarning(`${PROGRESS_CHATTER} output timestamps were rewritten`)).toBe(false);
    expect(isEncoderChatterWarning(`${PROGRESS_CHATTER}\nError writing trailer`)).toBe(false);
    expect(isEncoderChatterWarning(`${PROGRESS_CHATTER} [libx264 @ not-a-pointer] unexpected encoder diagnostic`)).toBe(false);
  });

  it("does not recognise anything Motion itself said", () => {
    expect(isEncoderChatterWarning(MOTION_DENSITY)).toBe(false);
    expect(isEncoderChatterWarning(COLOUR_MISMATCH)).toBe(false);
    expect(isEncoderChatterWarning("Browser renderer used a font fallback for text layer title.")).toBe(false);
    expect(isEncoderChatterWarning(
      "Native renderer case-folded lowercase text to uppercase block glyphs on layer title: abc."
    )).toBe(false);
  });

  it("does not treat a bracketed non-FFmpeg prefix as chatter", () => {
    // A bare bracketed tag is not FFmpeg logging, and only faststart is a routine component notice.
    expect(isEncoderChatterWarning("[warning] something a caller must act on")).toBe(false);
    expect(isEncoderChatterWarning("[libx264 @ not-a-pointer] something unusual")).toBe(false);
    expect(isEncoderChatterWarning("[matroska @ [address]] Starting second pass: moving the moov atom to the beginning of the file")).toBe(false);
  });
});

describe("actionableReceiptWarnings", () => {
  it("keeps the caller-facing warnings in receipt order and drops the chatter", () => {
    expect(actionableReceiptWarnings([NORMALISED_FASTSTART_CHATTER, NORMALISED_DTS_WARNING, MOTION_DENSITY, PROGRESS_CHATTER]))
      .toEqual([NORMALISED_DTS_WARNING, MOTION_DENSITY]);
  });
});

describe("receiptStatusForWarnings", () => {
  it("fails when the operation failed, whatever the warnings say", () => {
    expect(receiptStatusForWarnings({ failed: true, warnings: [] })).toBe("failed");
    expect(receiptStatusForWarnings({ failed: true, warnings: [NORMALISED_FASTSTART_CHATTER] })).toBe("failed");
  });

  it("passes with no warnings and with chatter only", () => {
    expect(receiptStatusForWarnings({ warnings: [] })).toBe("passed");
    expect(receiptStatusForWarnings({ warnings: [NORMALISED_FASTSTART_CHATTER, PROGRESS_CHATTER] })).toBe("passed");
  });

  it("warns on any actionable warning, even alongside chatter", () => {
    expect(receiptStatusForWarnings({ warnings: [MOTION_DENSITY] })).toBe("warning");
    expect(receiptStatusForWarnings({ warnings: [NORMALISED_FASTSTART_CHATTER, COLOUR_MISMATCH] })).toBe("warning");
    expect(receiptStatusForWarnings({ warnings: [NORMALISED_PALETTEGEN_WARNING] })).toBe("warning");
    expect(receiptStatusForWarnings({ warnings: [`${PROGRESS_CHATTER} ${NORMALISED_DTS_WARNING}`] })).toBe("warning");
    expect(receiptStatusForWarnings({ warnings: [`${PROGRESS_CHATTER}\nError writing trailer`] })).toBe("warning");
  });
});

describe("escalateReceiptStatusForWarnings", () => {
  it("escalates a passed claim that carries an actionable warning", () => {
    expect(escalateReceiptStatusForWarnings("passed", [COLOUR_MISMATCH])).toBe("warning");
  });

  it("leaves a passed claim alone when its warnings are chatter", () => {
    expect(escalateReceiptStatusForWarnings("passed", [NORMALISED_FASTSTART_CHATTER])).toBe("passed");
  });

  it("never softens or invents a verdict a caller already reached", () => {
    // De-escalation is the failure mode this guards: a `failed` render whose only recorded warning
    // is chatter must stay failed, and `not_run` must never become `passed` because nothing warned.
    expect(escalateReceiptStatusForWarnings("failed", [])).toBe("failed");
    expect(escalateReceiptStatusForWarnings("failed", [NORMALISED_FASTSTART_CHATTER])).toBe("failed");
    expect(escalateReceiptStatusForWarnings("warning", [])).toBe("warning");
    expect(escalateReceiptStatusForWarnings("not_run", [])).toBe("not_run");
    expect(escalateReceiptStatusForWarnings("not_run", [MOTION_DENSITY])).toBe("not_run");
  });
});

describe("the three receipt surfaces agree", () => {
  const renderStatusFor = (warnings: string[]): string => createRenderReceipt({
    id: "receipt_render_rule",
    packageId: "pkg_rule",
    lane: "ffmpeg",
    status: "passed",
    inputHashes: { "motion.json": "abc" },
    output: null,
    warnings
  }).status;

  it.each([
    ["no warnings", [], "passed"],
    ["encoder chatter only", [NORMALISED_FASTSTART_CHATTER], "passed"],
    ["a retained FFmpeg diagnostic", [NORMALISED_DTS_WARNING], "warning"],
    ["a motion-density advisory", [MOTION_DENSITY], "warning"],
    ["a delivered-colour mismatch", [COLOUR_MISMATCH], "warning"],
    ["chatter plus an advisory", [NORMALISED_FASTSTART_CHATTER, MOTION_DENSITY], "warning"]
  ])("preview, final render and connector all say %s -> %s", (_label, warnings, expected) => {
    // The connector rule is `receiptStatusForWarnings` itself (see
    // `packages/connectors/src/artifacts.ts`), so calling it here is calling that surface's rule.
    expect(previewReceiptStatus({ warnings: warnings as string[] })).toBe(expected);
    expect(renderStatusFor(warnings as string[])).toBe(expected);
    expect(receiptStatusForWarnings({ failed: false, warnings: warnings as string[] })).toBe(expected);
  });

  it("keeps preview quality evidence outranking the warnings text", () => {
    // Quality evidence is a verdict about the pixels, not a warning string; the shared rule sits
    // beneath it rather than replacing it.
    expect(previewReceiptStatus({ warnings: [], quality: { status: "failed" } })).toBe("failed");
    expect(previewReceiptStatus({ warnings: [NORMALISED_FASTSTART_CHATTER], quality: { status: "warning" } })).toBe("warning");
  });

  it("does not let the rule resurrect a failed render", () => {
    expect(createRenderReceipt({
      id: "receipt_render_failed",
      packageId: "pkg_rule",
      lane: "ffmpeg",
      status: "failed",
      inputHashes: { "motion.json": "abc" },
      output: null,
      warnings: [NORMALISED_FASTSTART_CHATTER]
    }).status).toBe("failed");
  });
});
