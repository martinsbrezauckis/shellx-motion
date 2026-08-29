/** Narrow MCP-only authoring route for an approved local package script entry. */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  AGENT_SCRIPT_EXECUTION_EXTENSION,
  AGENT_SCRIPT_EXECUTION_REQUEST_SCHEMA,
  AGENT_SCRIPT_RESOLVER_VERSION,
  APPROVED_AGENT_SCRIPT_MODE,
  AgentScriptProvenanceRefusal,
  activeScriptLayers,
  applyReceiptActor,
  hashPackageFile,
  loadMotionPackage,
  loadSchema,
  resolvePackageAsset,
  validateDocument,
  type AgentScriptExecutionEvidence,
  type AgentScriptProvenanceAuthority,
  type MotionDocument,
  type MotionLayer,
  type MotionPackage,
  type OperationReceipt,
  type ReceiptActor,
} from "@shellx-motion/core";
import type { MotionPermissionTier } from "@shellx-motion/actions";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { isServerObservedMcpSession, type ServerObservedMcpSession } from "../server-observed-mcp-session.js";
import { objectArg, recordArg, stringArg } from "./args.js";
import {
  assertConfiguredAuthoringInputRoot,
  assertConfiguredAuthoringOutputRoot,
  AuthoringRootPolicyError,
} from "./authoring-root-policy.js";
import { commitPackageEdit, PackageEditTransactionError } from "./package-edit-transaction.js";
import { secureApprovedAgentEntryHtml } from "./approved-agent-entry-admission.js";

const MAX_ENTRY_BYTES = 256 * 1024;
const AUTHORING_ARGUMENTS = new Set(["packageRoot", "outDir", "html", "layer"]);
const AUTHORING_LAYER_ARGUMENTS = new Set(["id", "type", "startMs", "durationMs", "name", "opacity", "visible"]);

export interface AgentScriptAuthoringServices {
  agentScriptAuthority?: AgentScriptProvenanceAuthority;
  observedMcpAgentSession?: ServerObservedMcpSession;
  actor?: ReceiptActor;
  tier?: MotionPermissionTier;
  packageLoader?: (root: string) => Promise<MotionPackage>;
  authoringInputRoots?: string[];
  authoringOutputRoots?: string[];
}

interface ParsedAuthoringInput {
  packageRoot: string;
  outDir: string;
  html: string;
  layer: MotionLayer;
  sourcePath: string;
}

class ApprovedAgentEntryRefusal extends Error {}

class ApprovedAgentEntryInvalid extends Error {
  constructor(readonly suggestedAction: string) {
    super("Approved-agent-entry layer did not produce a valid Motion document.");
  }
}

/**
 * Create exactly one local inline HTML entry and ask the opaque host authority to attest the
 * committed package. Importers, copied script packages, raw Debug, SDK, and CLI never enter here.
 */
export async function dispatchAgentScriptAuthoringCommand(
  command: MotionDebugCommand,
  args: unknown,
  services: AgentScriptAuthoringServices,
): Promise<MotionDebugResult | null> {
  if (command !== "motion.package.script.author") return null;
  const parsed = parseArgs(args);
  if ("error" in parsed) return invalid(parsed.error);
  if (!services.agentScriptAuthority) {
    return unavailable("Approved-agent-entry script authoring requires an operator-configured host authority.");
  }
  if (!services.authoringInputRoots?.length || !services.authoringOutputRoots?.length) {
    return unavailable("Approved-agent-entry script authoring requires operator-configured input and output roots.");
  }
  if (!isObservedMcpWriteAgent(services.observedMcpAgentSession, services.actor, services.tier)) {
    return refused("Approved-agent-entry script authoring is available only to a server-established, initialized MCP WebSocket session granted write_local by the host.");
  }
  if (!services.packageLoader) return unavailable("Approved-agent-entry script authoring package loading is unavailable.");
  const packageLoader = services.packageLoader;

  try {
    await assertConfiguredAuthoringInputRoot(parsed.packageRoot, services.authoringInputRoots);
    await assertConfiguredAuthoringOutputRoot(parsed.outDir, services.authoringOutputRoots);
    const outputRoot = resolve(parsed.outDir);
    const transaction = await commitPackageEdit({
      sourceRoot: parsed.packageRoot,
      outputRoot,
      edit: async (stagedRoot) => {
        // Keep data-only admission, derivation, and receipt input hashes on the COW snapshot.
        // commitPackageEdit proves that snapshot matches its admitted source, then refuses a
        // replacement before it can install output or mint provenance.
        const staged = await packageLoader(stagedRoot);
        if (resolve(staged.root) !== resolve(stagedRoot)) {
          throw new PackageEditTransactionError("copy_mismatch", "Approved-agent-entry staging did not load the transaction snapshot.");
        }
        if (activeScriptLayers(staged.motion).length > 0) {
          throw new ApprovedAgentEntryRefusal("Approved-agent-entry script authoring starts from a data-only package; imported, copied, or pre-existing active scripts cannot be re-attested.");
        }
        const sourceHash = createHash("sha256").update(parsed.html, "utf8").digest("hex");
        const inputHashes = {
          "manifest.json": await hashPackageFile(resolvePackageAsset(staged, "manifest.json")),
          [staged.manifest.motion]: await hashPackageFile(resolvePackageAsset(staged, staged.manifest.motion)),
          "approved-agent-entry.html": sourceHash,
        };
        const patchedMotion = withApprovedAgentEntry(staged.motion, parsed.layer);
        const validation = await validateDocument(await loadSchema("motion"), patchedMotion);
        if (!validation.ok) {
          throw new ApprovedAgentEntryInvalid(validation.errors.map((entry) => `${entry.path}: ${entry.message}`).join("; "));
        }
        const stagedSourcePath = resolvePackageAsset({ root: stagedRoot }, parsed.sourcePath);
        await mkdir(dirname(stagedSourcePath), { recursive: true });
        await writeFile(stagedSourcePath, parsed.html, { encoding: "utf8", mode: 0o600 });
        const nextManifest = {
          ...staged.manifest,
          assets: [...new Set([...staged.manifest.assets, parsed.sourcePath])]
        };
        await writeJson(join(stagedRoot, "manifest.json"), nextManifest);
        await writeJson(resolvePackageAsset({ root: stagedRoot }, staged.manifest.motion), patchedMotion);
        return { packageId: staged.manifest.id, sourceHash, inputHashes, validation };
      },
      validate: async (stagedRoot, stagedInput) => {
        const staged = await loadMotionPackage(stagedRoot);
        const stagedValidation = await validateDocument(await loadSchema("motion"), staged.motion);
        if (!stagedValidation.ok) throw new Error("Staged approved-agent-entry Motion document failed validation.");
        const written = await readFile(resolvePackageAsset(staged, parsed.sourcePath), "utf8");
        if (createHash("sha256").update(written, "utf8").digest("hex") !== stagedInput.sourceHash) {
          throw new Error("Staged approved-agent-entry source bytes differ from the requested inline entry.");
        }
      },
      afterCommit: async (installedRoot, stagedInput) => {
        const packageToAttest = await loadMotionPackage(installedRoot);
        if (packageToAttest.manifest.id !== stagedInput.packageId) {
          throw new PackageEditTransactionError("copy_mismatch", "Installed approved-agent-entry package identity differs from the staged snapshot.");
        }
        const attestation = await services.agentScriptAuthority!.mint({ package: packageToAttest });
        const scriptExecution: AgentScriptExecutionEvidence = {
          schema: "shellx-motion/script-execution@1",
          detectedClass: "active-content",
          requestedMode: APPROVED_AGENT_SCRIPT_MODE,
          activeMode: APPROVED_AGENT_SCRIPT_MODE,
          resolverVersion: attestation.resolverVersion,
          packageSnapshotSha256: attestation.packageSnapshotSha256,
          attestationId: attestation.attestationId,
          sources: attestation.sources
        };
        const receipt: OperationReceipt = {
          schema: "shellx-motion/receipt@1",
          id: `approved-agent-entry-${attestation.attestationId}`,
          operation: "package.script.author",
          status: "passed",
          packageId: packageToAttest.manifest.id,
          inputHashes: stagedInput.inputHashes,
          createdAt: attestation.createdAt,
          lane: "debug-api",
          output: {
            packageRoot: installedRoot,
            sourcePath: parsed.sourcePath,
            scriptExecution,
            provenance: {
              property: "approved-agent-entry provenance",
              limitation: "This attests a host-approved local script entry and its bytes; it does not establish semantic or human authorship."
            }
          },
          warnings: []
        };
        await services.agentScriptAuthority!.writeReceipt(applyReceiptActor(receipt, services.actor));
        // The durable authority retains its full attestation, including host-local filesystem
        // identity. Public command output gets only execution evidence suitable for a receipt.
        return { scriptExecution, receipt };
      }
    });
    const result = {
      packageId: transaction.editResult.packageId,
      packageRoot: transaction.outputRoot,
      sourcePath: parsed.sourcePath,
      scriptExecution: transaction.afterCommitResult.scriptExecution,
      receipt: transaction.afterCommitResult.receipt,
      validation: transaction.editResult.validation
    };
    return {
      ok: true,
      receiptId: transaction.afterCommitResult.receipt.id,
      visibleState: {
        panel: "packages",
        operation: "package.script.author",
        packageId: transaction.editResult.packageId,
        packageRoot: transaction.outputRoot,
        sourcePath: parsed.sourcePath,
        activeMode: APPROVED_AGENT_SCRIPT_MODE
      },
      result,
      warnings: []
    };
  } catch (error) {
    if (error instanceof ApprovedAgentEntryRefusal) return refused(error.message);
    if (error instanceof ApprovedAgentEntryInvalid) {
      return {
        ok: false,
        error: {
          code: "approved_agent_entry_invalid",
          message: "Approved-agent-entry layer did not produce a valid Motion document.",
          suggestedAction: error.suggestedAction
        },
        warnings: []
      };
    }
    const code = error instanceof AuthoringRootPolicyError || error instanceof PackageEditTransactionError
      ? error.code
      : "approved_agent_entry_failed";
    return { ok: false, error: { code, message: publicAuthoringErrorMessage(error) }, warnings: [] };
  }
}

function parseArgs(args: unknown): ParsedAuthoringInput | { error: string } {
  const input = objectArg(args);
  if (!input || !onlyKnownKeys(input, AUTHORING_ARGUMENTS)) {
    return { error: "motion.package.script.author accepts only packageRoot, outDir, html, and layer." };
  }
  const packageRoot = stringArg(args, "packageRoot");
  const outDir = stringArg(args, "outDir");
  const html = stringArg(args, "html");
  const layerInput = recordArg(args, "layer");
  if (!packageRoot) return { error: "motion.package.script.author requires packageRoot." };
  if (!outDir) return { error: "motion.package.script.author requires outDir." };
  if (typeof html !== "string" || html.length === 0 || html.length > MAX_ENTRY_BYTES || Buffer.byteLength(html, "utf8") > MAX_ENTRY_BYTES) {
    return { error: `motion.package.script.author html must be a non-empty inline entry no larger than ${MAX_ENTRY_BYTES} characters or UTF-8 bytes.` };
  }
  const securedHtml = secureApprovedAgentEntryHtml(html);
  if ("error" in securedHtml) return { error: securedHtml.error };
  const layer = parseLayer(layerInput);
  if (!layer) return { error: "motion.package.script.author layer requires a safe id, type web/html/canvas, finite startMs, and positive durationMs." };
  return { packageRoot, outDir, html: securedHtml.html, layer, sourcePath: `scripts/agent/${layer.id}.html` };
}

function parseLayer(value: Record<string, unknown> | null): MotionLayer | null {
  if (!value
    || !onlyKnownKeys(value, AUTHORING_LAYER_ARGUMENTS)
    || typeof value.id !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.id)
    || (value.type !== "web" && value.type !== "html" && value.type !== "canvas")
    || typeof value.startMs !== "number" || !Number.isFinite(value.startMs) || value.startMs < 0
    || typeof value.durationMs !== "number" || !Number.isFinite(value.durationMs) || value.durationMs <= 0) return null;
  if (value.name !== undefined && (typeof value.name !== "string" || value.name.length > 256)) return null;
  if (value.opacity !== undefined && (typeof value.opacity !== "number" || !Number.isFinite(value.opacity))) return null;
  if (value.visible !== undefined && typeof value.visible !== "boolean") return null;
  return {
    id: value.id,
    type: value.type,
    startMs: value.startMs,
    durationMs: value.durationMs,
    source: `scripts/agent/${value.id}.html`,
    allowedOrigins: [],
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    ...(typeof value.opacity === "number" ? { opacity: value.opacity } : {}),
    ...(typeof value.visible === "boolean" ? { visible: value.visible } : {})
  };
}

function withApprovedAgentEntry(motion: MotionDocument, layer: MotionLayer): MotionDocument {
  if (motion.layers.some((existing) => existing.id === layer.id)) {
    throw new Error(`Approved-agent-entry layer id ${layer.id} already exists in the source package.`);
  }
  const next = structuredClone(motion) as MotionDocument & Record<string, unknown>;
  next.layers = [...next.layers, layer];
  next[AGENT_SCRIPT_EXECUTION_EXTENSION] = {
    schema: AGENT_SCRIPT_EXECUTION_REQUEST_SCHEMA,
    requestedMode: APPROVED_AGENT_SCRIPT_MODE,
    resolverVersion: AGENT_SCRIPT_RESOLVER_VERSION
  };
  return next;
}


function onlyKnownKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function publicAuthoringErrorMessage(error: unknown): string {
  if (error instanceof AuthoringRootPolicyError) return error.message;
  if (error instanceof PackageEditTransactionError) {
    return "Approved-agent-entry package edit did not complete; the source package was left unchanged.";
  }
  if (error instanceof AgentScriptProvenanceRefusal) {
    return "The operator-configured approved-agent-entry authority refused the package provenance request.";
  }
  return "Approved-agent-entry script authoring did not complete.";
}

function isObservedMcpWriteAgent(
  observedMcpAgentSession: ServerObservedMcpSession | undefined,
  actor: ReceiptActor | undefined,
  tier: MotionPermissionTier | undefined
): boolean {
  const canWrite = tier === "write_local" || tier === "push_remote";
  return canWrite
    && isServerObservedMcpSession(observedMcpAgentSession)
    && actor?.kind === "agent"
    && actor.transport === "mcp"
    && typeof actor.sessionId === "string" && actor.sessionId.length > 0
    && (actor.grantedTier === "write_local" || actor.grantedTier === "push_remote");
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function invalid(message: string): MotionDebugResult {
  return { ok: false, error: { code: "invalid_args", message }, warnings: [] };
}

function unavailable(message: string): MotionDebugResult {
  return { ok: false, error: { code: "capability_unavailable", message, suggestedAction: "Ask the operator to configure approved-agent-entry host authority and authoring roots." }, warnings: [] };
}

function refused(message: string): MotionDebugResult {
  return { ok: false, error: { code: "approved_agent_entry_refused", message, suggestedAction: "Use an operator-approved initialized MCP WebSocket session with write_local; stateless MCP HTTP, raw Debug, SDK, CLI, imports, and copied scripts cannot request this route." }, warnings: [] };
}
