import { extname, resolve, sep } from "node:path";
import { readVerifiedPackageAsset, type MotionLayer, type MotionPackage } from "@shellx-motion/core";
import { MAX_HTML_ASSET_BYTES } from "./html-snippet-types.js";
import {
  assertSafeHtmlMediaAsset,
  mediaTypeFor,
  normalizeHtmlAssetRef,
  readString
} from "./html-snippet-shared.js";

export async function mediaSource(pkg: MotionPackage, layer: MotionLayer): Promise<string> {
  const source = readString(layer.source) ?? readString(layer.src) ?? readString(layer.assetRef);
  if (!source) return "";
  if (!normalizeHtmlAssetRef(source, layer.type)) {
    throw new Error(`HTML snippet export requires a bounded package-relative source on layer ${layer.id}.`);
  }
  if (!pkg.manifest.assets.includes(source)) {
    throw new Error(`HTML snippet export media source is not declared in manifest.assets on layer ${layer.id}.`);
  }
  const asset = await readVerifiedPackageAsset(pkg, source, {
    label: `HTML snippet export media source on layer ${layer.id}`,
    maxBytes: MAX_HTML_ASSET_BYTES
  });
  const assetPath = asset.canonicalPath;
  if (extname(assetPath).toLowerCase() !== extname(source).toLowerCase()) {
    throw new Error(`HTML snippet export media source extension changes through a symlink on layer ${layer.id}.`);
  }
  assertSafeHtmlMediaAsset(assetPath, asset.bytes, `HTML snippet export layer ${layer.id}`);
  return `data:${mediaTypeFor(assetPath)};base64,${asset.bytes.toString("base64")}`;
}

export function assertNotInsidePackage(packageRoot: string, outDir: string): void {
  const root = resolve(packageRoot);
  const candidate = resolve(outDir);
  const rootWithSep = root.endsWith(sep) ? root : `${root}${sep}`;
  if (candidate === root || candidate.startsWith(rootWithSep)) {
    throw new Error("HTML snippet export outDir must be outside packageRoot.");
  }
}
