import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function injectBrowserCaptureBase(html: string, href: string): string {
  if (/<base\b/i.test(html)) return html;
  const base = `<base href="${escapeAttribute(href)}">`;
  if (/<head\b[^>]*>/i.test(html)) return html.replace(/<head\b[^>]*>/i, (head) => `${head}\n${base}`);
  if (/<html\b[^>]*>/i.test(html)) return html.replace(/<html\b[^>]*>/i, (root) => `${root}\n<head>${base}</head>`);
  return `<head>${base}</head>\n${html}`;
}

export function packageRootBaseHref(packageRoot: string): string {
  const href = pathToFileURL(resolve(packageRoot)).href;
  return href.endsWith("/") ? href : `${href}/`;
}

export function safeBrowserCaptureFileToken(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "capture";
}

function escapeAttribute(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}
