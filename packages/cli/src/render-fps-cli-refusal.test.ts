import { mkdtemp, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const hostJob = vi.hoisted(() => ({ withHostJob: vi.fn() }));
const core = vi.hoisted(() => ({ createMotionPackage: vi.fn() }));

vi.mock("./render-host-job.js", () => ({ withHostJob: hostJob.withHostJob }));
vi.mock("@shellx-motion/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@shellx-motion/core")>(),
  createMotionPackage: core.createMotionPackage
}));

import { runCli } from "./main";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(process.cwd(), ".render-fps-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  hostJob.withHostJob.mockReset();
  core.createMotionPackage.mockReset();
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe("CLI render fps argument", () => {
  it.each([["--fps", "60"], ["--fps=60"]])("refuses %s before submitting a host job or creating an output path", async (...fpsArgs) => {
    hostJob.withHostJob.mockRejectedValue(new Error("render host job must not be submitted"));
    const root = await temporaryRoot();
    const outputPath = join(root, "out", "final.mp4");

    const result = await runCli([
      "render", "/not-a-motion-package", ...fpsArgs, "--out", outputPath, "--job-id", "render-fps-rejected"
    ]);

    expect(result).toMatchObject({
      ok: false,
      command: "render",
      error: { code: "invalid_args", message: "render does not accept --fps; it always uses the package's declared fps." }
    });
    expect(result).not.toHaveProperty("jobId");
    expect(hostJob.withHostJob).not.toHaveBeenCalled();
    await expect(stat(dirname(outputPath))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps --fps available to package-create", async () => {
    const packageRoot = "/trusted-output/authored-package";
    core.createMotionPackage.mockResolvedValue({
      packageRoot,
      packageId: "pkg_authored_package",
      motionId: "motion_authored_package",
      name: "Untitled Motion",
      width: 1920,
      height: 1080,
      fps: 24,
      durationMs: 5000,
      layerCount: 1,
      files: ["motion.json", "manifest.json", "assets/"],
      nextSteps: []
    });

    const result = await runCli(["package-create", packageRoot, "--fps", "24"]);
    expect(result).toMatchObject({ ok: true, command: "package-create", fps: 24 });
    expect(core.createMotionPackage).toHaveBeenCalledWith(expect.objectContaining({ packageRoot, fps: 24 }));
  });
});
