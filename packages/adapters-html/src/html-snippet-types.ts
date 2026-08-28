import type {
  MotionDocument,
  MotionLayer,
  OperationReceipt,
  PackageManifest,
  ReceiptArtifact
} from "@shellx-motion/core";

export interface HtmlSnippetExportOptions {
  packageRoot: string;
  outDir: string;
  createdAt?: string;
}

export interface HtmlSnippetLossinessFinding {
  path: string;
  layerId: string;
  feature: string;
  reason: string;
}

export interface HtmlSnippetExportResult {
  ok: true;
  packageId: string;
  htmlPath: string;
  receiptPath: string;
  receipt: OperationReceipt;
  htmlSha256: string;
  layerCount: number;
  exportedLayerCount: number;
  unsupportedFeatureCount: number;
  artifacts: ReceiptArtifact[];
  warnings: string[];
}

export interface HtmlSnippetImportOptions {
  htmlPath: string;
  packageDir: string;
  createdAt?: string;
  createdBy?: string;
}

export interface HtmlSnippetImportResult {
  ok: true;
  packageDir: string;
  packageId: string;
  manifestPath: string;
  motionPath: string;
  receiptPath: string;
  receipt: OperationReceipt;
  layerCount: number;
  warningCount: number;
  stagedAssetCount: number;
  stagedAssets: Array<{ path: string; sha256: string; size: number }>;
  artifacts: ReceiptArtifact[];
  warnings: string[];
}

export interface ParsedHtmlSnippet {
  manifest: PackageManifest;
  motion: MotionDocument;
  lossiness: HtmlSnippetLossinessFinding[];
}

export interface ParsedHtmlLayer {
  layer: MotionLayer | null;
  assetRef?: string;
  lossiness: HtmlSnippetLossinessFinding[];
}

export interface HtmlComposition {
  htmlAttrs: Record<string, string>;
  mainAttrs: Record<string, string>;
  mainInner: string;
  title: string;
  mainStyle: Record<string, string>;
}

export interface HtmlLayerElement {
  tagName: string;
  attrs: Record<string, string>;
  innerHtml: string;
  style: Record<string, string>;
}

export const HTML_SNIPPET_FILE = "index.html";
export const HTML_SNIPPET_RECEIPT_FILE = "html-snippet-export.receipt.json";
export const HTML_SNIPPET_IMPORT_RECEIPT_FILE = "html-snippet-import.receipt.json";
export const MOTION_PACKAGE_MEDIA_TYPE = "application/vnd.shellx.motion.package";
export const SUPPORTED_LAYER_TYPES = new Set(["text", "caption", "shape", "image", "video"]);
export const MAX_HTML_SNIPPET_BYTES = 8 * 1024 * 1024;
export const MAX_HTML_LAYER_COUNT = 1_000;
export const MAX_HTML_ATTRIBUTES_PER_ELEMENT = 64;
export const MAX_HTML_ATTRIBUTES = (MAX_HTML_LAYER_COUNT + 2) * MAX_HTML_ATTRIBUTES_PER_ELEMENT;
export const MAX_HTML_STYLE_ENTRIES_PER_ELEMENT = 64;
export const MAX_HTML_STYLE_ENTRIES = (MAX_HTML_LAYER_COUNT + 2) * MAX_HTML_STYLE_ENTRIES_PER_ELEMENT;
export const MAX_HTML_DECODED_STRING_CHARS_PER_ELEMENT = 64 * 1024;
export const MAX_HTML_DECODED_STRING_CHARS = MAX_HTML_SNIPPET_BYTES;
export const MAX_HTML_LOSSINESS_FINDINGS = 2_048;
export const MAX_HTML_LOSSINESS_RECEIPT_BYTES = 768 * 1024;
export const MAX_HTML_ASSET_BYTES = 256 * 1024 * 1024;
export const MAX_HTML_TOTAL_ASSET_BYTES = 512 * 1024 * 1024;
export const IMAGE_ASSET_EXTENSIONS = new Set([".gif", ".jpeg", ".jpg", ".png", ".svg", ".webp"]);
export const VIDEO_ASSET_EXTENSIONS = new Set([".mp4", ".webm"]);
