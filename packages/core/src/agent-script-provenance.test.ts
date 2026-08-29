import { mkdtemp, mkdir, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentScriptProvenanceRefusal,
  AGENT_SCRIPT_PROVENANCE_MAX_BYTES,
  AGENT_SCRIPT_PROVENANCE_MAX_FILES,
  describeActiveScriptSources,
  fingerprintAgentScriptPackage,
  requestedAgentScriptMode,
} from "./agent-script-provenance";
import { loadMotionPackage } from "./package";

const roots: string[] = [];

async function writePackage(): Promise<string> {
  // macOS exposes its temporary root through `/var -> /private/var`; provenance deliberately
  // rejects symlinked roots, so build the valid fixture below the canonical host path.
  const root = await mkdtemp(join(await realpath(tmpdir()), "shellx-motion-agent-script-"));
  roots.push(root);
  await mkdir(join(root, "scripts", "agent"), { recursive: true });
  await writeFile(join(root, "scripts", "agent", "entry.html"), "<main>local</main><script>window.draw = true;</script>", "utf8");
  // Newlines and separators in unrelated file names must never make a fingerprint record
  // ambiguous. Windows rejects control characters at the filesystem boundary; its valid-name
  // variant still proves that unrelated package data participates in the bounded fingerprint.
  const unrelatedName = process.platform === "win32" ? "notes-with-separator.txt" : "notes\nwith-separator.txt";
  await writeFile(join(root, unrelatedName), "ordinary data", "utf8");
  await writeFile(join(root, "manifest.json"), `${JSON.stringify({
    schema: "shellx-motion/package-manifest@1",
    id: "pkg_agent_entry",
    name: "Agent entry",
    motion: "motion.json",
    assets: ["scripts/agent/entry.html"],
    sourceApp: "shellx-motion",
    compatibility: { lanes: ["browser"], hosts: ["motion"] }
  }, null, 2)}\n`, "utf8");
  await writeFile(join(root, "motion.json"), `${JSON.stringify({
    schema: "shellx-motion/motion@1",
    id: "motion_agent_entry",
    name: "Agent entry",
    durationMs: 1000,
    fps: 30,
    width: 640,
    height: 360,
    layers: [{ id: "entry", type: "web", source: "scripts/agent/entry.html", startMs: 0, durationMs: 1000 }],
    assets: [],
    provenance: { sourceApp: "test", createdBy: "test" },
    "x-shellx-motion-script-execution": {
      schema: "shellx-motion/script-execution-request@1",
      requestedMode: "trusted-local-agent-authored"
    }
  }, null, 2)}\n`, "utf8");
  return root;
}

describe("approved-agent-entry provenance primitives", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
  });

  it("describes only package-relative regular active sources and fingerprints the bounded full tree", async () => {
    const root = await writePackage();
    const pkg = await loadMotionPackage(root);

    await expect(describeActiveScriptSources(pkg)).resolves.toEqual([{
      layerId: "entry",
      layerType: "web",
      path: "scripts/agent/entry.html",
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      bytes: 54
    }]);
    await expect(fingerprintAgentScriptPackage(root)).resolves.toMatch(/^[a-f0-9]{64}$/);
    expect(requestedAgentScriptMode(pkg.motion)).toBe("trusted-local-agent-authored");
  });

  it("refuses symlinked active source acquisition rather than following it", async ({ skip }) => {
    const root = await writePackage();
    const target = join(root, "scripts", "agent", "entry.html");
    const link = join(root, "scripts", "agent", "linked.html");
    try {
      await symlink(target, link, "file");
    } catch (error) {
      if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
        skip("The standard Windows test account cannot create symbolic links.");
        return;
      }
      throw error;
    }
    const pkg = await loadMotionPackage(root);
    pkg.motion.layers[0].source = "scripts/agent/linked.html";

    await expect(describeActiveScriptSources(pkg)).rejects.toBeInstanceOf(AgentScriptProvenanceRefusal);
    await expect(fingerprintAgentScriptPackage(root)).rejects.toThrow("symbolic link");
  });

  it("refuses oversized sparse files before provenance hashing", async () => {
    const activeRoot = await writePackage();
    const activePackage = {
      root: activeRoot,
      motion: { layers: [{ id: "entry", type: "web", source: "scripts/agent/entry.html" }] }
    } as unknown as Awaited<ReturnType<typeof loadMotionPackage>>;
    await truncate(join(activeRoot, "scripts", "agent", "entry.html"), AGENT_SCRIPT_PROVENANCE_MAX_BYTES + 1);
    await expect(describeActiveScriptSources(activePackage)).rejects.toThrow("provenance snapshot budget");

    const treeRoot = await writePackage();
    const oversized = join(treeRoot, "oversized.bin");
    await writeFile(oversized, Buffer.alloc(0));
    await truncate(oversized, AGENT_SCRIPT_PROVENANCE_MAX_BYTES + 1);
    await expect(fingerprintAgentScriptPackage(treeRoot)).rejects.toThrow("provenance snapshot budget");
  });

  it("refuses the first file beyond the provenance file-count budget", async () => {
    const root = await writePackage();
    const directory = join(root, "many");
    await mkdir(directory);
    for (let offset = 0; offset < AGENT_SCRIPT_PROVENANCE_MAX_FILES; offset += 128) {
      await Promise.all(Array.from(
        { length: Math.min(128, AGENT_SCRIPT_PROVENANCE_MAX_FILES - offset) },
        (_entry, index) => writeFile(join(directory, `empty-${String(offset + index).padStart(4, "0")}`), Buffer.alloc(0))
      ));
    }

    await expect(fingerprintAgentScriptPackage(root)).rejects.toThrow("provenance snapshot budget");
  }, 45_000);
});
