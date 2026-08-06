import { readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";

const WORKBENCH_FILES = new Map([
  ["/workbench", { url: new URL("../workbench/index.html", import.meta.url), contentType: "text/html; charset=utf-8" }],
  ["/workbench/", { url: new URL("../workbench/index.html", import.meta.url), contentType: "text/html; charset=utf-8" }],
  ["/workbench.css", { url: new URL("../workbench/workbench.css", import.meta.url), contentType: "text/css; charset=utf-8" }],
  ["/workbench.js", { url: new URL("../workbench/workbench.js", import.meta.url), contentType: "text/javascript; charset=utf-8" }],
  ["/workbench/history", { url: new URL("../workbench/history.html", import.meta.url), contentType: "text/html; charset=utf-8" }],
  ["/workbench/history/", { url: new URL("../workbench/history.html", import.meta.url), contentType: "text/html; charset=utf-8" }],
  ["/workbench/docs", { url: new URL("../workbench/docs.html", import.meta.url), contentType: "text/html; charset=utf-8" }],
  ["/workbench/docs/", { url: new URL("../workbench/docs.html", import.meta.url), contentType: "text/html; charset=utf-8" }],
  ["/workbench/connections", { url: new URL("../workbench/connections.html", import.meta.url), contentType: "text/html; charset=utf-8" }],
  ["/workbench/connections/", { url: new URL("../workbench/connections.html", import.meta.url), contentType: "text/html; charset=utf-8" }],
  ["/workbench/about", { url: new URL("../workbench/about.html", import.meta.url), contentType: "text/html; charset=utf-8" }],
  ["/workbench/about/", { url: new URL("../workbench/about.html", import.meta.url), contentType: "text/html; charset=utf-8" }],
  ["/engine-room.css", { url: new URL("../workbench/engine-room.css", import.meta.url), contentType: "text/css; charset=utf-8" }],
  ["/workbench-nav.css", { url: new URL("../workbench/workbench-nav.css", import.meta.url), contentType: "text/css; charset=utf-8" }],
  ["/workbench-nav.js", { url: new URL("../workbench/workbench-nav.js", import.meta.url), contentType: "text/javascript; charset=utf-8" }],
  ["/workbench-session.js", { url: new URL("../workbench/workbench-session.js", import.meta.url), contentType: "text/javascript; charset=utf-8" }],
  ["/workbench-path-picker.js", { url: new URL("../workbench/workbench-path-picker.js", import.meta.url), contentType: "text/javascript; charset=utf-8" }],
  ["/history.js", { url: new URL("../workbench/history.js", import.meta.url), contentType: "text/javascript; charset=utf-8" }],
  ["/docs.js", { url: new URL("../workbench/docs.js", import.meta.url), contentType: "text/javascript; charset=utf-8" }],
  ["/connections.js", { url: new URL("../workbench/connections.js", import.meta.url), contentType: "text/javascript; charset=utf-8" }],
  ["/about.js", { url: new URL("../workbench/about.js", import.meta.url), contentType: "text/javascript; charset=utf-8" }],
  ["/receipt-card.js", { url: new URL("../workbench/receipt-card.js", import.meta.url), contentType: "text/javascript; charset=utf-8" }],
  ["/markdown.js", { url: new URL("../workbench/markdown.js", import.meta.url), contentType: "text/javascript; charset=utf-8" }],
  ["/update-state.js", { url: new URL("../workbench/update-state.js", import.meta.url), contentType: "text/javascript; charset=utf-8" }]
]);

export function isWorkbenchFile(path: string): boolean {
  return WORKBENCH_FILES.has(path);
}

export async function writeWorkbenchFile(response: ServerResponse, path: string): Promise<void> {
  const asset = WORKBENCH_FILES.get(path);
  if (!asset) throw new Error("Workbench asset was not found.");
  const bytes = await readFile(asset.url);
  response.statusCode = 200;
  response.setHeader("content-type", asset.contentType);
  response.setHeader("content-length", String(bytes.byteLength));
  response.setHeader("content-security-policy", "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  response.setHeader("cross-origin-opener-policy", "same-origin");
  response.end(bytes);
}
