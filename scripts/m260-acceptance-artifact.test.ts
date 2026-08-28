import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { listRendererCapabilityCards } from "../packages/core/src/index.js";
import {
  CAPABILITY_EVIDENCE_SOURCE_INVENTORY_REFERENCE,
  CAPABILITY_LIFECYCLE_STAGES,
  CAPABILITY_PROOF_LEVELS,
  generateCapabilityEvidenceMatrix,
  generateSourceCapabilityEvidenceMatrix,
  sourceCapabilityEvidenceSemanticInventory,
  type CapabilityEvidenceSemanticTag
} from "./m260-acceptance-artifact/matrix.js";
import {
  M260_ACCEPTANCE_FIXTURE_DESCRIPTOR,
  M260_ACCEPTANCE_FIXTURE_REQUIRED_LIFECYCLE
} from "./m260-acceptance-artifact/descriptor.js";
import {
  M260_ACCEPTANCE_ARTIFACT_COMMAND,
  M260_ACCEPTANCE_ARTIFACT_REFUSAL_LOCATOR,
  M260_SOURCE_CONTRACT_REASON,
  generateM260AcceptanceFixtureArtifact
} from "./m260-acceptance-artifact/orchestration.js";

const execFileAsync = promisify(execFile);
const REPO = fileURLToPath(new URL("../", import.meta.url));

function semanticTag(rendererCapabilityId = "renderer.browser"): CapabilityEvidenceSemanticTag {
  return {
    rendererCapabilityId,
    lifecycle: CAPABILITY_LIFECYCLE_STAGES.map((stage) => ({
      stage,
      status: ["create", "inspect", "edit"].includes(stage) ? "source-accepted" : stage === "refusal" ? "refused" : "planned"
    })),
    proof: CAPABILITY_PROOF_LEVELS.map((level) => level === "source"
      ? { level, status: "captured", evidenceRef: "scripts/m260-acceptance-artifact.test.ts#semanticTag" }
      : { level, status: "not-captured" })
  };
}

describe("M260 acceptance artifact repository tool", () => {
  it("derives an immutable inventory from the canonical renderer-card reader without a copied registry", () => {
    const inventory = sourceCapabilityEvidenceSemanticInventory();
    const expectedIds = listRendererCapabilityCards().map((card) => card.id);

    expect(inventory.map((tag) => tag.rendererCapabilityId)).toEqual(expectedIds);
    expect(inventory.every((tag) => tag.lifecycle.every((cell) => cell.status === "planned"))).toBe(true);
    expect(inventory.every((tag) => tag.proof.every((cell) => cell.level === "source"
      ? cell.status === "captured" && cell.evidenceRef === `${CAPABILITY_EVIDENCE_SOURCE_INVENTORY_REFERENCE}:${tag.rendererCapabilityId}`
      : cell.status === "not-captured"))).toBe(true);
    expect(Object.isFrozen(inventory)).toBe(true);

    const matrix = generateSourceCapabilityEvidenceMatrix();
    expect(matrix.rows.map((row) => row.capabilityId)).toEqual([...expectedIds].sort());
    expect(matrix.rows.every((row) => row.lifecycle.every((cell) => cell.status === "planned"))).toBe(true);
  });

  it("keeps lifecycle and proof validation stage-safe", () => {
    const missingReceipt = semanticTag();
    missingReceipt.lifecycle = missingReceipt.lifecycle.filter((cell) => cell.stage !== "receipt");
    expect(() => generateCapabilityEvidenceMatrix([missingReceipt])).toThrow("lifecycle is missing: receipt");

    expect(() => generateCapabilityEvidenceMatrix([semanticTag("renderer.unregistered")])).toThrow(
      "Capability evidence tag is not registered by a canonical renderer card: renderer.unregistered"
    );

    const unsafePreview = semanticTag();
    unsafePreview.lifecycle = unsafePreview.lifecycle.map((cell) => cell.stage === "preview"
      ? { ...cell, status: "source-accepted" }
      : cell);
    expect(() => generateCapabilityEvidenceMatrix([unsafePreview])).toThrow(
      "lifecycle.preview cannot be source-accepted; runtime stages require evidence-accepted proof"
    );
  });

  it("makes the source-contract command and refusal evidence locator explicit without claiming host proof", () => {
    const artifact = generateM260AcceptanceFixtureArtifact();
    const repeated = generateM260AcceptanceFixtureArtifact();
    const sourceContract = artifact.projections.find((projection) => projection.id === "source-contract");

    expect(artifact).toMatchObject({
      createsPackageOrOutput: false,
      executedProjectionIds: ["source-contract", "refusal"],
      refusal: {
        projectionId: "refusal",
        capabilityGate: "core.match-renderer-capability",
        capabilityId: "renderer.native",
        changedPaths: ["/layers/fixed-adjustment-refusal"],
        unsupported: [{
          layerId: "fixed-adjustment-refusal",
          feature: "layer.type:adjustment",
          reason: "Lane native does not support adjustment layers."
        }]
      }
    });
    expect(sourceContract).toMatchObject({ execution: "executed", missingProof: [], reason: M260_SOURCE_CONTRACT_REASON });
    expect(artifact.refusal.proof[0]).toEqual({
      level: "source",
      status: "captured",
      evidenceRef: M260_ACCEPTANCE_ARTIFACT_REFUSAL_LOCATOR
    });
    expect(artifact.refusal.proof[0]?.evidenceRef).not.toContain(artifact.refusal.evidenceIdentity);
    expect(repeated).toEqual(artifact);
    expect(Object.isFrozen(artifact.projections)).toBe(true);
    expect(Object.isFrozen(artifact.refusal.proof)).toBe(true);
    expect(M260_ACCEPTANCE_FIXTURE_REQUIRED_LIFECYCLE).toEqual(CAPABILITY_LIFECYCLE_STAGES);
    expect(M260_ACCEPTANCE_FIXTURE_DESCRIPTOR.materialization).toBe("repository-tool");
  });

  it("has a root command that emits the deterministic inspectable artifact", async () => {
    const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { scripts?: Record<string, string> };
    const coreManifest = JSON.parse(await readFile(new URL("../packages/core/package.json", import.meta.url), "utf8")) as { exports?: Record<string, unknown> };
    const coreIndex = await readFile(new URL("../packages/core/src/index.ts", import.meta.url), "utf8");
    const repositoryToolModules = [
      "m260-acceptance-artifact.ts",
      "m260-acceptance-artifact/matrix.ts",
      "m260-acceptance-artifact/descriptor.ts",
      "m260-acceptance-artifact/orchestration.ts"
    ];
    expect(manifest.scripts?.[M260_ACCEPTANCE_ARTIFACT_COMMAND]).toBe("tsx scripts/m260-acceptance-artifact.ts");
    expect(Object.keys(coreManifest.exports ?? {})).not.toContain("./m260-acceptance-artifact");
    expect(coreIndex).not.toContain("m260-acceptance-artifact");
    for (const path of repositoryToolModules) {
      const source = await readFile(new URL(`./${path}`, import.meta.url), "utf8");
      expect(source.split("\n").length, `${path} stays within the repository module target`).toBeLessThanOrEqual(350);
    }

    const command = process.platform === "win32"
      ? { executable: "cmd.exe", args: ["/d", "/s", "/c", "pnpm.cmd", "--silent", M260_ACCEPTANCE_ARTIFACT_COMMAND] }
      : { executable: "pnpm", args: ["--silent", M260_ACCEPTANCE_ARTIFACT_COMMAND] };
    const first = await execFileAsync(command.executable, command.args, { cwd: REPO });
    const second = await execFileAsync(command.executable, command.args, { cwd: REPO });

    expect(first.stderr).toBe("");
    expect(second.stdout).toBe(first.stdout);
    expect(JSON.parse(first.stdout)).toEqual(generateM260AcceptanceFixtureArtifact());
  });
});
