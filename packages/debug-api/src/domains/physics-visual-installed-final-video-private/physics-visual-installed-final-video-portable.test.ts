import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { reopenPhysicsVisualPackageFinalVideoInput } from "@shellx-motion/debug-api/internal/physics-visual-installed-final-video";
import { readPhysicsVisualPresentationStaticUpload } from "../physics-visual-presentation-private/physics-visual-presentation-private.js";

const portableRoot = process.env.MOTION_GPU_C7B5_PORTABLE_REOPEN_ROOT?.trim();
const describePortable = process.env.MOTION_GPU_C7B5_PORTABLE_REOPEN === "1" ? describe : describe.skip;

describePortable("portable C7B5 installed-output reopen only (no GPU/video qualification)", () => {
  it("reopens the Linux-produced Bingo and wall installed identities without rendering or mutation", async () => {
    if (!portableRoot) throw new Error("MOTION_GPU_C7B5_PORTABLE_REOPEN_ROOT is required when MOTION_GPU_C7B5_PORTABLE_REOPEN=1.");
    const root = await realpath(resolve(portableRoot));
    const observations = [];
    for (const kind of ["bingo", "wall"] as const) {
      const workspace = join(root, kind);
      const input = await reopenPhysicsVisualPackageFinalVideoInput({
        outputPackageRoot: join(workspace, "installed"),
        packageWorkspaceRoot: workspace,
        packageWorkspaceAuthority: await createTrustedWorkspaceAnchor(workspace),
      });
      const staticUpload = readPhysicsVisualPresentationStaticUpload(input.preview.presentationStaticPlan);
      expect(input.preview.installed).toEqual(input.installed);
      expect(input.preview.receiptFingerprint).toBe(input.installed.receiptFingerprint);
      expect(input.scheduleSha256).toBe(input.installed.plans.scheduleSha256);
      expect(input.installed.presentationStaticFingerprint).toBe(staticUpload.staticFingerprint);
      expect(input.schedule).toEqual({ startUs: 0, endUs: 5_000_000, stepsPerSecond: 120, stepCount: 600, sampleEverySteps: 2, frameRate: 60, renderFrameCount: 300, terminalFrameIndex: 300, displayedFrameCount: 301, durationMs: 301_000 / 60 });
      expect(staticUpload).toMatchObject({ schema: "shellx-motion/private-gltf-object-retained-render-static-upload@1", width: 640, height: 360, staticFingerprint: input.installed.presentationStaticFingerprint });
      observations.push({ kind, receiptFingerprint: input.installed.receiptFingerprint, scheduleSha256: input.scheduleSha256, staticFingerprint: staticUpload.staticFingerprint });
    }
    expect(observations).toHaveLength(2);
    expect(new Set(observations.map((value) => value.receiptFingerprint)).size).toBe(2);
  });
});
