/** Copy-on-write typed compositing graph inspection, compilation, and removal. */
import {
  compileMotionDocumentCompositing,
  compositingGraphFingerprint,
  hashBuffer,
  hashPackageFile,
  loadSchema,
  resolvePackageAsset,
  restoreMotionDocumentCompositing,
  validateDocument,
  validateMotionCompositingGraph,
  type MotionCompositingGraph,
  type MotionDocument,
  type MotionPackage,
  type OperationReceipt,
  type ReceiptArtifact,
} from "@shellx-motion/core";
import { join, resolve } from "node:path";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { recordArg, stringArg } from "./args.js";
import {
  commitMotionDocumentEdit,
  PackageEditTransactionError,
} from "./package-edit-transaction.js";

export interface CompositingGraphAuthoringServices {
  authoringInputRoots?: string[];
  authoringOutputRoots?: string[];
  receiptsRoot?: string;
  packageLoader?: (packageRoot: string) => Promise<MotionPackage>;
  writeReceipt?: (root: string, receipt: OperationReceipt) => Promise<string>;
}

export async function dispatchCompositingGraphAuthoringCommand(
  command: MotionDebugCommand,
  args: unknown,
  services: CompositingGraphAuthoringServices,
): Promise<MotionDebugResult | null> {
  if (command === "motion.compositing.graph.inspect") return inspect(args, services);
  if (command === "motion.compositing.graph.set") return mutate(command, args, services, "set");
  if (command === "motion.compositing.graph.remove") return mutate(command, args, services, "remove");
  return null;
}

async function inspect(
  args: unknown,
  services: CompositingGraphAuthoringServices,
): Promise<MotionDebugResult> {
  const packageRoot = stringArg(args, "packageRoot");
  if (!packageRoot) return invalidArgs("motion.compositing.graph.inspect requires packageRoot.");
  if (!services.packageLoader) return unavailable("Motion package inspection is unavailable.");
  try {
    const pkg = await services.packageLoader(packageRoot);
    const state = inspectGraphState(pkg.motion);
    const receiptId = `compositing-graph-inspect-${pkg.manifest.id}-${hashBuffer(
      Buffer.from(JSON.stringify(state), "utf8"),
    ).slice(0, 16)}`;
    return {
      ok: true,
      receiptId,
      result: { packageId: pkg.manifest.id, packageRoot: pkg.root, state },
      visibleState: {
        panel: "compositingGraph",
        operation: "compositing.graph.inspect",
        packageId: pkg.manifest.id,
        packageRoot: pkg.root,
        state,
      },
      warnings: [],
    };
  } catch (error) {
    return failure("compositing_graph_inspect_failed", error);
  }
}

async function mutate(
  command: MotionDebugCommand,
  args: unknown,
  services: CompositingGraphAuthoringServices,
  mutation: "set" | "remove",
): Promise<MotionDebugResult> {
  const packageRoot = stringArg(args, "packageRoot");
  const outputArg = stringArg(args, "outDir") ?? stringArg(args, "packageDir");
  const receiptsRoot = stringArg(args, "receiptsRoot") ?? services.receiptsRoot;
  const createdBy = stringArg(args, "createdBy") ?? undefined;
  const graph = recordArg(args, "graph");
  if (!packageRoot) return invalidArgs(`${command} requires packageRoot.`);
  if (!outputArg) return invalidArgs(`${command} requires outDir.`);
  if (mutation === "set" && !graph) return invalidArgs(`${command} requires graph.`);
  if (!services.packageLoader) return unavailable("Atomic compositing graph editing is unavailable.");
  if (receiptsRoot && !services.writeReceipt) return unavailable("Graph receipt persistence is unavailable.");

  try {
    const pkg = await services.packageLoader(packageRoot);
    const outputRoot = resolve(outputArg);
    const motion = applyMutation(pkg.motion, mutation, graph);
    const validation = await validateDocument(await loadSchema("motion"), motion);
    if (!validation.ok) {
      throw new Error(`Patched Motion document failed validation: ${validation.errors
        .map((entry) => `${entry.path}: ${entry.message}`).join("; ")}`);
    }
    const operation = `compositing.graph.${mutation}`;
    const changedPaths = mutation === "set"
      ? ["/compositing", "/layers", "/x-compositing-compile"]
      : ["/compositing", "/layers", "/x-compositing-compile"];
    const state = inspectGraphState(motion);
    const receiptFileName = `compositing-graph-${mutation}.receipt.json`;
    const receiptPath = join(outputRoot, "receipts", receiptFileName);
    const inputHashes = {
      "manifest.json": await hashPackageFile(resolvePackageAsset(pkg, "manifest.json")),
      [pkg.manifest.motion]: await hashPackageFile(resolvePackageAsset(pkg, pkg.manifest.motion)),
      mutation: hashBuffer(Buffer.from(JSON.stringify({ operation, graph }), "utf8")),
    };
    const output = {
      packageRoot: outputRoot,
      changedPaths,
      state,
      validation,
      ...(createdBy ? { createdBy } : {}),
    };
    const receipt = graphReceipt(
      operation,
      mutation,
      pkg,
      inputHashes,
      output,
      outputRoot,
      receiptPath,
    );
    const installed = await commitMotionDocumentEdit({
      sourcePackage: pkg,
      outputRoot,
      authoringInputRoots: services.authoringInputRoots!,
      authoringOutputRoots: services.authoringOutputRoots!,
      patchedMotion: motion,
      receipt,
      receiptFileName,
      ...(receiptsRoot ? { receiptsRoot, writeHostReceipt: services.writeReceipt! } : {}),
    });
    const result = {
      ...output,
      packageId: pkg.manifest.id,
      motionPath: installed.motionPath,
      receiptPath: installed.receiptPath,
      receipt,
      ...(installed.hostReceiptPath ? { hostReceiptPath: installed.hostReceiptPath } : {}),
    };
    return {
      ok: true,
      result,
      receiptId: receipt.id,
      visibleState: {
        panel: "compositingGraph",
        operation,
        packageId: pkg.manifest.id,
        packageRoot: outputRoot,
        changedPaths,
        state,
        receiptPath: installed.receiptPath,
      },
      warnings: [],
    };
  } catch (error) {
    const code = error instanceof PackageEditTransactionError
      ? error.code
      : `compositing_graph_${mutation}_failed`;
    return failure(code, error);
  }
}

function applyMutation(
  motion: MotionDocument,
  mutation: "set" | "remove",
  graph: Record<string, unknown> | null,
): MotionDocument {
  const restored = restoreMotionDocumentCompositing(motion);
  if (mutation === "set") {
    return compileMotionDocumentCompositing({
      ...restored,
      compositing: structuredClone(graph) as unknown as MotionCompositingGraph,
    });
  }
  const next = structuredClone(restored);
  delete next.compositing;
  return next;
}

function inspectGraphState(motion: MotionDocument) {
  const source = restoreMotionDocumentCompositing(motion);
  const graph = source.compositing ? structuredClone(source.compositing) : null;
  const validation = graph
    ? validateMotionCompositingGraph(graph, {
      width: source.width,
      height: source.height,
      layers: source.layers,
    })
    : null;
  const metadata = readCompileMetadata(motion["x-compositing-compile"]);
  return {
    graph,
    compiled: Boolean(graph && metadata),
    metadata,
    validation,
    fingerprint: graph ? compositingGraphFingerprint(graph) : null,
  };
}

function readCompileMetadata(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const metadata = value as Record<string, unknown>;
  return metadata.schema === "shellx-motion/compositing-compile@1"
    ? structuredClone(metadata)
    : null;
}

function graphReceipt(
  operation: string,
  mutation: string,
  pkg: MotionPackage,
  inputHashes: Record<string, string>,
  output: Record<string, unknown>,
  outputRoot: string,
  receiptPath: string,
): OperationReceipt {
  const artifacts: ReceiptArtifact[] = [
    { role: "motion_package", path: outputRoot, status: "available", primary: true },
    {
      role: "compositing_graph_receipt",
      path: receiptPath,
      status: "available",
      mediaType: "application/json",
    },
  ];
  return {
    schema: "shellx-motion/receipt@1",
    id: `compositing-graph-${mutation}-${hashBuffer(
      Buffer.from(JSON.stringify({ packageId: pkg.manifest.id, inputHashes }), "utf8"),
    ).slice(0, 16)}`,
    operation,
    status: "passed",
    packageId: pkg.manifest.id,
    inputHashes,
    createdAt: new Date().toISOString(),
    lane: "debug-api",
    output,
    artifacts,
    warnings: [],
  };
}

function invalidArgs(message: string): MotionDebugResult {
  return { ok: false, error: { code: "invalid_args", message }, warnings: [] };
}

function unavailable(message: string): MotionDebugResult {
  return {
    ok: false,
    error: {
      code: "capability_unavailable",
      message,
      suggestedAction: "Configure the required host capability and retry.",
    },
    warnings: [],
  };
}

function failure(code: string, error: unknown): MotionDebugResult {
  return {
    ok: false,
    error: { code, message: error instanceof Error ? error.message : String(error) },
    warnings: [],
  };
}
