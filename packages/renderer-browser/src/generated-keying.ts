import {
  browserKeyingRuntimeScript,
  type BrowserKeyingRuntimeEvidence,
} from "@shellx-motion/compositing-keying";
import {
  resolvedMotionChromaKey,
  validateLayerKeyingAndRoto,
  type MotionLayer,
} from "@shellx-motion/core";
import type { Page } from "playwright-core";

export interface BrowserKeyingEvidence extends BrowserKeyingRuntimeEvidence {
  policy: "fixed-host-cpu-chroma";
  network: "denied";
  code: "host-fixed";
}

export function generatedKeyingRuntimeScript(): string {
  return browserKeyingRuntimeScript();
}

export function generatedKeyingRuntimeSource(): string {
  const script = generatedKeyingRuntimeScript();
  const match = /^<script>([\s\S]*)<\/script>$/.exec(script);
  if (!match) throw new Error("Browser keying runtime script wrapper is invalid.");
  return `try{${match[1]}}catch(error){globalThis.__SHELLX_MOTION_KEYING_INSTALL_ERROR__=error instanceof Error?error.message:String(error);throw error}`;
}

export function motionKeyingDataAttribute(layer: MotionLayer): string {
  if (!layer.keying) return "";
  const issues = validateLayerKeyingAndRoto({ type: layer.type, keying: layer.keying }, `/layers/${layer.id}`);
  if (issues.length > 0) throw new Error(`Invalid browser keying at ${issues[0].path}: ${issues[0].message}.`);
  const settings = JSON.stringify(resolvedMotionChromaKey(layer.keying));
  return ` data-motion-keying="${escapeAttr(settings)}"`;
}

export async function settleGeneratedMotionKeying(page: Page): Promise<BrowserKeyingEvidence | undefined> {
  const status = await page.evaluate(() => ({
    keyedLayers: document.querySelectorAll("[data-motion-keying]").length,
    runtimeAvailable: typeof (globalThis as typeof globalThis & {
      __SHELLX_MOTION_APPLY_KEYING__?: unknown;
    }).__SHELLX_MOTION_APPLY_KEYING__ === "function",
  }));
  if (status.keyedLayers === 0) return undefined;
  if (!status.runtimeAvailable) {
    await page.addScriptTag({ content: generatedKeyingRuntimeSource() });
  }
  const installError = await page.evaluate(() => (globalThis as typeof globalThis & {
    __SHELLX_MOTION_KEYING_INSTALL_ERROR__?: unknown;
  }).__SHELLX_MOTION_KEYING_INSTALL_ERROR__);
  if (typeof installError === "string" && installError) {
    throw new Error(`Browser keying runtime installation failed: ${installError}`);
  }
  const evidence = await page.evaluate(async () => {
    const root = globalThis as typeof globalThis & {
      __SHELLX_MOTION_APPLY_KEYING__?: () => Promise<BrowserKeyingRuntimeEvidence>;
    };
    if (!root.__SHELLX_MOTION_APPLY_KEYING__) throw new Error("Browser keying runtime is unavailable after host injection.");
    return root.__SHELLX_MOTION_APPLY_KEYING__();
  });
  return evidence ? { ...evidence, policy: "fixed-host-cpu-chroma", network: "denied", code: "host-fixed" } : undefined;
}

function escapeAttr(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[char] ?? char);
}
