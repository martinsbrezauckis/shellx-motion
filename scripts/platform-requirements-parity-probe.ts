/**
 * CLI-vs-MCP readiness parity probe (the readiness-parity invariant).
 *
 * Role: prove that `shellx-motion doctor --json` and the `motion.platform.requirements` debug/MCP command
 * return the SAME readiness answer on the same machine — including when a tool is deliberately
 * absent. Before the shared requirements result these two disagreed on `ok`, on whether a
 * `satisfied` field existed at all, and on whether FFprobe was modelled.
 *
 * FFprobe is made absent by pointing `SHELLX_MOTION_FFPROBE` at a path that does not exist, which
 * is the same override a user with a non-standard install would set. Nothing is uninstalled.
 *
 * Usage: tsx scripts/platform-requirements-parity-probe.ts [--absent ffprobe|ffmpeg|none]
 *
 * Dependencies: `@shellx-motion/cli` (doctor) and `@shellx-motion/debug-api` (dispatch). Not part
 * of the shipped packages.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { doctorCommand } from "../packages/cli/src/doctor-command";
import { dispatchDebugCommand } from "../packages/debug-api/src/index";

const absent = optionValue("--absent") ?? "none";
const MISSING_PATH = join(tmpdir(), "shellx-motion-absent-tool-probe", "definitely-not-here");

function optionValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (absent === "ffprobe") process.env.SHELLX_MOTION_FFPROBE = MISSING_PATH;
if (absent === "ffmpeg") process.env.SHELLX_MOTION_FFMPEG = MISSING_PATH;

async function main(): Promise<void> {
  const cli = await doctorCommand(["--json"]) as Record<string, any>;
  const mcp = await dispatchDebugCommand("motion.platform.requirements", {}, { tier: "read_motion" }) as Record<string, any>;

  const cliPlatform = cli.requirements;
  const mcpPlatform = mcp.result.platform;

  // The parity assertion: identical shared results, byte for byte.
  assert.deepEqual(cliPlatform, mcpPlatform, "CLI and MCP returned different readiness results");
  assert.equal(cli.satisfied, mcp.result.satisfied, "CLI and MCP disagree on satisfied");
  assert.equal(cli.ok, true, "doctor `ok` must report that the probe ran, not that the machine is ready");
  assert.equal(mcp.ok, true, "MCP `ok` must report that the probe ran");

  const scopedCli = await doctorCommand(["--json", "--operation", "render.final"]) as Record<string, any>;
  const scopedMcp = await dispatchDebugCommand("motion.platform.requirements", { operation: "render.final" }, { tier: "read_motion" }) as Record<string, any>;
  assert.deepEqual(scopedCli.operation, scopedMcp.result.operation, "CLI and MCP disagree on scoped operation readiness");

  console.log(JSON.stringify({
    absentTool: absent,
    agree: true,
    satisfied: cli.satisfied,
    missingCount: cli.missingCount,
    tools: cliPlatform.tools.map((tool: any) => ({ tool: tool.tool, status: tool.status, source: tool.source })),
    operations: cliPlatform.operations,
    scopedRenderFinal: scopedCli.operation,
    cliOk: cli.ok,
    mcpOk: mcp.ok
  }, null, 2));
}

await main();
