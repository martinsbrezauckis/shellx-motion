import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_SCRIPT_EXECUTION_EXTENSION,
  AGENT_SCRIPT_EXECUTION_REQUEST_SCHEMA,
  APPROVED_AGENT_SCRIPT_MODE,
  loadMotionPackage,
} from "@shellx-motion/core";
import { createApprovedAgentScriptProvenanceAuthority } from "./approved-agent-script-authority";

const roots: string[] = [];

async function fixture(): Promise<{ packageRoot: string; stateRoot: string }> {
  const root = await mkdtemp(join(await realpath(tmpdir()), "shellx-motion-agent-script-authority-reuse-"));
  roots.push(root);
  const packageRoot = join(root, "package");
  const stateRoot = join(root, "private-state");
  await mkdir(packageRoot, { recursive: true, mode: 0o700 });
  await mkdir(stateRoot, { mode: 0o700 });
  await writeJson(join(packageRoot, "manifest.json"), {
    schema: "shellx-motion/package-manifest@1",
    id: "agent-script-reuse",
    name: "Agent script reuse",
    motion: "motion.json",
    assets: ["entry.html"],
    sourceApp: "shellx-motion-test",
    compatibility: { lanes: ["browser"], hosts: ["motion"] }
  });
  await writeJson(join(packageRoot, "motion.json"), {
    schema: "shellx-motion/motion@1",
    id: "agent-script-reuse-motion",
    name: "Agent script reuse",
    durationMs: 1000,
    fps: 30,
    width: 320,
    height: 180,
    layers: [{
      id: "entry",
      type: "html",
      source: "entry.html",
      allowedOrigins: [],
      startMs: 0,
      durationMs: 1000
    }],
    assets: ["entry.html"],
    provenance: { sourceApp: "shellx-motion-test", createdBy: "test" },
    [AGENT_SCRIPT_EXECUTION_EXTENSION]: {
      schema: AGENT_SCRIPT_EXECUTION_REQUEST_SCHEMA,
      requestedMode: APPROVED_AGENT_SCRIPT_MODE
    }
  });
  await writeFile(join(packageRoot, "entry.html"), "<main>entry</main><script>window.entry = true;</script>", "utf8");
  return { packageRoot, stateRoot };
}

describe("approved-agent-entry authority private child reuse", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
  });

  it("reuses verified existing snapshot and receipt directories across sequential calls", async () => {
    const paths = await fixture();
    const authority = createApprovedAgentScriptProvenanceAuthority({ stateRoot: paths.stateRoot });
    const pkg = await loadMotionPackage(paths.packageRoot);
    await authority.mint({ package: pkg });

    const first = await authority.resolve(pkg);
    await first.release();
    const second = await authority.resolve(pkg);
    await second.release();

    await authority.writeReceipt({ id: "agent-script-reuse-receipt-one", operation: "test" });
    await authority.writeReceipt({ id: "agent-script-reuse-receipt-two", operation: "test" });
  });
});

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
