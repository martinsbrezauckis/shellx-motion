/**
 * Lane errors that tell the caller what to do instead.
 *
 * Role: `--lane` selects the DELIVERY lane, `--frame-lane` selects the rasterizer. Those are
 * different axes with overlapping vocabulary, so `--lane browser` is the single most natural
 * wrong guess an agent makes. The previous messages named the problem ("Unsupported render lane:
 * browser.") and stopped there, leaving the caller to discover the two-flag answer by reading
 * source or guessing again.
 *
 * Every message here states the accepted values AND the working invocation, because an error an
 * agent can act on without a second round trip is worth more than a shorter one.
 *
 * Primary caller: `renderCommand` and `previewCommand` in `packages/cli/src/main.ts`.
 */

import { nativeTextDeliveryIssues, nativeTextDeliveryMessage } from "@shellx-motion/renderer-native";
import type { MotionDocument } from "@shellx-motion/core";

/** The two-flag form that answers the most common mistake, quoted verbatim in several messages. */
const BROWSER_FRAME_RECIPE = "To rasterize frames in the browser use: --lane ffmpeg --frame-lane browser.";

export function unsupportedRenderLaneMessage(lane: string): string {
  if (lane === "browser") {
    return "render --lane selects the delivery lane (native or ffmpeg), not the frame rasterizer. "
      + BROWSER_FRAME_RECIPE;
  }
  return `render --lane must be native or ffmpeg; received ${lane}. ${BROWSER_FRAME_RECIPE}`;
}

export function unsupportedPreviewLaneMessage(lane: string): string {
  return `preview --lane must be native, browser, or gpu; received ${lane}. `
    + "gpu is the strict general hardware WebGPU PNG preview lane with no fallback; ffmpeg is a delivery lane and has no preview form; use `render --lane ffmpeg` instead.";
}

export function unsupportedFrameLaneMessage(frameLane: string): string {
  return `--frame-lane must be native, browser, or gpu; received ${frameLane}. `
    + "gpu is strict streamed FFmpeg final-video delivery with raw RGBA frames; unsupported content, unavailable hardware, and materialized paths refuse without fallback.";
}

/**
 * The refusal a native-frame-lane delivery would produce, or null when it would proceed.
 *
 * Used to gate `--dry-run` with the same rule execution applies. A dry run that reports a plan the
 * real render then rejects is worse than no dry run at all: it is exactly the case a caller reaches
 * for `--dry-run` to avoid.
 */
export function nativeDeliveryRefusal(
  pkg: { motion: MotionDocument },
  frameLane: string
): { ok: false; command: "render"; frameLane: string; error: { code: string; message: string; unsupported: unknown } } | null {
  if (frameLane !== "native") return null;
  const issues = nativeTextDeliveryIssues(pkg.motion);
  if (issues.length === 0) return null;
  return {
    ok: false,
    command: "render",
    frameLane,
    error: {
      code: "native_text_not_deliverable",
      message: nativeTextDeliveryMessage(issues),
      unsupported: issues
    }
  };
}
