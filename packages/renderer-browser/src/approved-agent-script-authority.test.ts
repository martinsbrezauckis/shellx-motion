import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentScriptProvenanceRefusal, loadMotionPackage } from "@shellx-motion/core";
import { createMotionBrowserRenderSession } from "./index";
import { createApprovedAgentScriptProvenanceAuthority } from "./approved-agent-script-authority";

const roots: string[] = [];

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(await realpath(tmpdir()), prefix));
  roots.push(root);
  return root;
}

async function writeActivePackage(): Promise<string> {
  const root = await temporaryRoot("shellx-motion-approved-agent-entry-");
  await mkdir(join(root, "scripts", "agent"), { recursive: true, mode: 0o700 });
  await writeFile(join(root, "scripts", "agent", "entry.html"), "<main>local</main><script>window.draw = true;</script>", "utf8");
  await writeFile(join(root, "manifest.json"), `${JSON.stringify({
    schema: "shellx-motion/package-manifest@1",
    id: "pkg_approved_agent_entry",
    name: "Approved agent entry",
    motion: "motion.json",
    assets: ["scripts/agent/entry.html"],
    sourceApp: "shellx-motion",
    compatibility: { lanes: ["browser"], hosts: ["motion"] }
  }, null, 2)}\n`, "utf8");
  await writeFile(join(root, "motion.json"), `${JSON.stringify({
    schema: "shellx-motion/motion@1",
    id: "motion_approved_agent_entry",
    name: "Approved agent entry",
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

describe("approved-agent-entry host authority", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
  });

  it("fails closed before browser launch, then resolves only exact attested bytes through a private snapshot", async () => {
    const packageRoot = await writeActivePackage();
    const stateRoot = await temporaryRoot("shellx-motion-approved-agent-state-");
    const source = await loadMotionPackage(packageRoot);
    let launchAttempted = false;

    await expect(createMotionBrowserRenderSession(source, {
      launchBrowser: async () => {
        launchAttempted = true;
        throw new Error("browser launch must not be reached for unapproved active content");
      }
    })).rejects.toBeInstanceOf(AgentScriptProvenanceRefusal);
    expect(launchAttempted).toBe(false);

    const authority = createApprovedAgentScriptProvenanceAuthority({
      stateRoot,
      now: () => new Date("2026-08-09T00:00:00.000Z")
    });
    const attestation = await authority.mint({ package: source });
    expect(attestation.attestationId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/);
    expect(attestation.createdAt).toBe("2026-08-09T00:00:00.000Z");
    expect(attestation.packageRootIdentity).toEqual({
      dev: expect.stringMatching(/^(?:0|[1-9][0-9]*)$/),
      ino: expect.stringMatching(/^(?:0|[1-9][0-9]*)$/)
    });
    const durableStore = JSON.parse(await readFile(join(stateRoot, "attestations.json"), "utf8"));
    expect(durableStore.attestations[0].packageRootIdentity).toEqual(attestation.packageRootIdentity);

    const resolved = await authority.resolve(source);
    try {
      expect(resolved.package.root).not.toBe(source.root);
      expect(resolved.evidence).toMatchObject({
        detectedClass: "active-content",
        requestedMode: "trusted-local-agent-authored",
        activeMode: "trusted-local-agent-authored",
        resolverVersion: 1,
        attestationId: attestation.attestationId,
        packageSnapshotSha256: attestation.packageSnapshotSha256
      });
      expect(resolved.evidence.sources).toEqual(attestation.sources);
    } finally {
      await resolved.release();
    }

    await writeFile(join(packageRoot, "scripts", "agent", "entry.html"), "<script>window.tampered = true;</script>", "utf8");
    await expect(authority.resolve(await loadMotionPackage(packageRoot))).rejects.toBeInstanceOf(AgentScriptProvenanceRefusal);
  });

  it("keeps an attestation across a same-file move but refuses a copied package", async () => {
    const packageRoot = await writeActivePackage();
    const stateRoot = await temporaryRoot("shellx-motion-approved-agent-state-");
    const authority = createApprovedAgentScriptProvenanceAuthority({ stateRoot });
    await authority.mint({ package: await loadMotionPackage(packageRoot) });

    const movedRoot = `${packageRoot}-moved`;
    await rename(packageRoot, movedRoot);
    roots.splice(roots.indexOf(packageRoot), 1, movedRoot);
    const moved = await authority.resolve(await loadMotionPackage(movedRoot));
    await moved.release();

    const copiedRoot = `${packageRoot}-copied`;
    roots.push(copiedRoot);
    await cp(movedRoot, copiedRoot, { recursive: true });
    await expect(authority.resolve(await loadMotionPackage(copiedRoot))).rejects.toBeInstanceOf(AgentScriptProvenanceRefusal);
  });

  it("does not create a missing authority root through a symlinked ancestor", async ({ skip }) => {
    const targetRoot = await temporaryRoot("shellx-motion-approved-agent-target-");
    const linkRoot = `${targetRoot}-link`;
    roots.push(linkRoot);
    try {
      await symlink(targetRoot, linkRoot, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
        skip("The standard Windows test account cannot create directory symbolic links.");
        return;
      }
      throw error;
    }
    const missingStateRoot = join(linkRoot, "missing-state-root");
    const authority = createApprovedAgentScriptProvenanceAuthority({ stateRoot: missingStateRoot });
    await expect(authority.revoke("evidence-12345678")).rejects.toBeInstanceOf(AgentScriptProvenanceRefusal);
    await expect(lstat(join(targetRoot, "missing-state-root"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
