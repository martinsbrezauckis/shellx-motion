import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { lottieDebugArgs } from "./lottie-cli.js";

describe("modular Lottie import CLI", () => {
  it("resolves Lottie and dotLottie source-checkout paths from INIT_CWD", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-lottie-init-cwd-"));
    const previousInitCwd = process.env.INIT_CWD;
    try {
      await mkdir(join(root, "fixtures", "imports"), { recursive: true });
      await writeFile(join(root, "fixtures", "imports", "input.json"), "{}");
      await writeFile(join(root, "fixtures", "imports", "input.lottie"), "container");
      process.env.INIT_CWD = root;

      expect(lottieDebugArgs("motion.lottie.import", [
        "--source", "fixtures/imports/input.json",
        "--out", ".scratch/lottie-package",
      ])).toMatchObject({
        sourcePath: join(root, "fixtures", "imports", "input.json"),
        outDir: join(root, ".scratch", "lottie-package"),
      });
      expect(lottieDebugArgs("motion.dotlottie.import", [
        "--source", "fixtures/imports/input.lottie",
        "--out", ".scratch/dotlottie-package",
      ])).toMatchObject({
        sourcePath: join(root, "fixtures", "imports", "input.lottie"),
        outDir: join(root, ".scratch", "dotlottie-package"),
      });
    } finally {
      if (previousInitCwd === undefined) delete process.env.INIT_CWD;
      else process.env.INIT_CWD = previousInitCwd;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses process cwd for Lottie and dotLottie installed forms without INIT_CWD", () => {
    const previousInitCwd = process.env.INIT_CWD;
    try {
      delete process.env.INIT_CWD;
      for (const command of ["motion.lottie.import", "motion.dotlottie.import"] as const) {
        expect(lottieDebugArgs(command, [
          "--source", "installed/input.lottie",
          "--out", ".scratch/package",
        ])).toMatchObject({
          sourcePath: resolve("installed/input.lottie"),
          outDir: resolve(".scratch/package"),
        });
      }
    } finally {
      if (previousInitCwd === undefined) delete process.env.INIT_CWD;
      else process.env.INIT_CWD = previousInitCwd;
    }
  });

  it("shares extended Windows and UNC normalization across Lottie import forms", () => {
    expect(lottieDebugArgs("motion.lottie.import", [
      "--source", String.raw`\\?\C:\Motion\fixtures\input.json`,
      "--out", String.raw`\\?\UNC\server\share\Motion\lottie-package`,
    ])).toMatchObject({
      sourcePath: String.raw`C:\Motion\fixtures\input.json`,
      outDir: String.raw`\\server\share\Motion\lottie-package`,
    });
    expect(lottieDebugArgs("motion.dotlottie.import", [
      "--source", String.raw`\\?\UNC\server\share\Motion\input.lottie`,
      "--out", String.raw`\\?\D:\Motion\dotlottie-package`,
    ])).toMatchObject({
      sourcePath: String.raw`\\server\share\Motion\input.lottie`,
      outDir: String.raw`D:\Motion\dotlottie-package`,
    });
  });
});
