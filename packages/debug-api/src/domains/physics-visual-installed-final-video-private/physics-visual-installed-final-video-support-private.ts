import { assertTrustedWorkspaceAnchorPath, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { canonicalJsonSha256 } from "@shellx-motion/core";
import type { GpuGltfObjectRetainedRenderSession } from "@shellx-motion/renderer-browser/internal/gltf-object-retained-render";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { PhysicsVisualPackageInstalledOutput } from "../physics-visual-package-materialize-private/physics-visual-package-materialize-output-private.js";

export interface PhysicsVisualInstalledFinalVideoWorkspaceHost {
  readonly outputPackageRoot: string;
  readonly packageWorkspaceRoot: string;
  readonly packageWorkspaceAuthority: Parameters<typeof withTrustedWorkspaceAnchor>[0];
  readonly finalOutputPath: string;
  readonly finalReceiptPath: string;
}

export async function withFinalOutputWorkspaceAuthority<T>(host: PhysicsVisualInstalledFinalVideoWorkspaceHost, operation: () => Promise<T>): Promise<T> {
  const workspace = resolve(host.packageWorkspaceRoot), packageRoot = resolve(host.outputPackageRoot);
  if (!strictDescendant(workspace, packageRoot) || !strictDescendant(workspace, resolve(host.finalOutputPath)) || !strictDescendant(workspace, resolve(host.finalReceiptPath))) {
    throw new Error("C7B5 final video and receipt must be sibling private outputs inside the trusted package workspace.");
  }
  await assertTrustedWorkspaceAnchorPath(host.packageWorkspaceAuthority, workspace);
  return await withTrustedWorkspaceAnchor(host.packageWorkspaceAuthority, operation);
}

export function assertSeparateOutput(packageRoot: string, outputPath: string): void {
  const packagePath = resolve(packageRoot), target = resolve(outputPath), pathFromPackage = relative(packagePath, target);
  if (pathFromPackage === "" || (!pathFromPackage.startsWith(`..${sep}`) && pathFromPackage !== ".." && !isAbsolute(pathFromPackage))) {
    throw new Error("C7B5 final video output must be outside the immutable C7B4D installed package.");
  }
}

export function isContainedFinalBrowser(browser: GpuGltfObjectRetainedRenderSession["browserProcess"], maxProcessTreeRssBytes: number): browser is GpuGltfObjectRetainedRenderSession["browserProcess"] & { containment: NonNullable<GpuGltfObjectRetainedRenderSession["browserProcess"]["containment"]> } {
  const containment = browser.containment;
  return browser.launcher === "precontained-direct-chromium" && Number.isSafeInteger(browser.pid) && browser.pid > 1 && containment !== null && containment.rootPid === browser.pid && containment.maxProcessTreeRssBytes === maxProcessTreeRssBytes && containment.status === "enforced" && containment.killTree === true && (containment.mode === "unix-process-group" || containment.mode === "windows-job-object");
}

export function installedIdentity(installed: PhysicsVisualPackageInstalledOutput): string {
  return canonicalJsonSha256({ recipeBundleFingerprint: installed.recipeBundleFingerprint, presentationStaticFingerprint: installed.presentationStaticFingerprint, plans: installed.plans, package: installed.package, artifact: installed.artifact, sidecar: installed.sidecar, receiptFingerprint: installed.receiptFingerprint });
}

export async function closeRetainedSession(session: GpuGltfObjectRetainedRenderSession): Promise<Awaited<ReturnType<GpuGltfObjectRetainedRenderSession["close"]>>> {
  const cleanup = await session.close();
  if (cleanup.remainingGpuBytes !== 0) throw new Error("C7B5 retained WebGPU cleanup left GPU bytes allocated.");
  return cleanup;
}

export function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value as object)) freeze(child); Object.freeze(value); }
  return value;
}

function strictDescendant(parent: string, target: string): boolean {
  const pathFromParent = relative(parent, target);
  return pathFromParent !== "" && !pathFromParent.startsWith(`..${sep}`) && pathFromParent !== ".." && !isAbsolute(pathFromParent);
}
