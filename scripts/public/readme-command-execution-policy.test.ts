import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readOnlyReadmeExecution } from "./readme-command-execution-policy.mjs";
import { tokenizeCommand } from "./readme-command-tokenize.mjs";

const ownedRoots: string[] = [];
const cli = ["pnpm", "--filter", "@shellx-motion/cli", "run", "cli", "--"];
afterEach(async () => {
  await Promise.all(ownedRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("documentation command execution", () => {
  it.each([
    [...cli, "doctor"],
    [...cli, "validate", "fixtures/packages/lower-third"]
  ])("keeps the documented read-only example %j", (...argv: string[]) => {
    expect(readOnlyReadmeExecution(argv)).toEqual({ file: "pnpm", args: argv.slice(1) });
  });

  it.each([
    "pnpm workbench:ui-smoke -- --out /tmp/outside",
    "pnpm run workbench:ui-smoke -- --out /tmp/outside",
    "pnpm sbom:generate -- --out /tmp/outside.json",
    "pnpm --filter @shellx-motion/cli run build",
    "pnpm --filter @shellx-motion/cli run cli -- package-create /tmp/outside",
    "pnpm --filter @shellx-motion/cli run cli -- doctor --out /tmp/outside",
    "pnpm --filter @shellx-motion/cli run cli -- validate /tmp/outside",
    "pnpm build -- --out /tmp/outside",
    "pnpm test",
    "pnpm install"
  ])("refuses execution of inert but unapproved argv: %s", (command) => {
    const tokens = tokenizeCommand(command);
    expect(tokens.ok).toBe(true);
    if (tokens.ok) expect(readOnlyReadmeExecution(tokens.argv)).toBeNull();
  });

  it("does not expose mutable policy argv to the caller", () => {
    const first = readOnlyReadmeExecution([...cli, "doctor"])!;
    first.args.push("--out", "/tmp/outside");
    expect(readOnlyReadmeExecution([...cli, "doctor"])!.args).toEqual([...cli.slice(1), "doctor"]);
  });

  it.each([
    ["pnpm workbench:ui-smoke -- --out /tmp/outside", false, false],
    ["pnpm run sbom:generate -- --out /tmp/outside.json", false, false],
    ["pnpm build -- --out /tmp/outside", false, false],
    ["pnpm build", true, false],
    ["pnpm install", true, false],
    ["pnpm test", true, false],
    ["pnpm --filter @shellx-motion/cli run cli -- doctor", true, true],
    ["pnpm --filter @shellx-motion/cli run cli -- validate fixtures/packages/lower-third", true, true]
  ])("enforces the policy through a README fence: %s", async (command, accepted, executed) => {
    const root = await mkdtemp(join(tmpdir(), "motion-readme-policy-"));
    ownedRoots.push(root);
    const scripts = join(root, "scripts", "public");
    const bin = join(root, "test-bin");
    await mkdir(scripts, { recursive: true });
    await mkdir(bin);
    for (const file of ["readme-commands-smoke.mjs", "readme-command-tokenize.mjs", "readme-command-platform.mjs", "readme-command-execution-policy.mjs"]) {
      await copyFile(new URL(file, import.meta.url), join(scripts, file));
    }
    await writeFile(join(root, "README.md"), `\`\`\`bash\n${command}\n\`\`\`\n`);
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: {
      "workbench:ui-smoke": "declared-side-effectful-command", "sbom:generate": "declared-side-effectful-command",
      build: "declared-build", test: "declared-test"
    } }));
    const packageRoot = join(root, "packages", "cli");
    await mkdir(packageRoot, { recursive: true });
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "@shellx-motion/cli", scripts: { cli: "declared-cli" } }));
    const marker = join(root, "executed.json");
    const stub = join(bin, "pnpm-stub.cjs");
    await writeFile(stub, "require('node:fs').writeFileSync(process.env.README_POLICY_TEST_MARKER, JSON.stringify(process.argv.slice(2)));\n");
    if (process.platform === "win32") {
      await writeFile(join(bin, "pnpm.cmd"), `@echo off\r\n"${process.execPath}" "${stub}" %*\r\n`);
    } else {
      await writeFile(join(bin, "pnpm"), `#!${process.execPath}\n${await readFile(stub, "utf8")}`, { mode: 0o700 });
    }
    const result = spawnSync(process.execPath, [join(scripts, "readme-commands-smoke.mjs")], {
      cwd: root, encoding: "utf8", timeout: 10_000,
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, README_POLICY_TEST_MARKER: marker }
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr || result.stdout).toBe(accepted ? 0 : 1);
    if (executed) {
      const parsed = tokenizeCommand(command);
      if (!parsed.ok) throw new Error("test command failed tokenization");
      expect(JSON.parse(await readFile(marker, "utf8"))).toEqual(parsed.argv.slice(1));
    } else await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
