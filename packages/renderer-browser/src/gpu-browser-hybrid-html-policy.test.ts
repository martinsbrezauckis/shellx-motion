import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { crc32 } from "@shellx-motion/core";
import type { BrowserPackageFulfillment } from "./browser-package-fulfillment";
import { admitGpuHybridDataOnlyDocument, admitGpuSegmentedHybridSelfContainedDocument } from "./gpu-browser-hybrid-html-policy";

describe("GPU hybrid strict data-only HTML policy", () => {
  it("binds one static UTF-8 browser document to its fulfilled source identity", async () => {
    const fulfilled = fulfillmentFor(`<!doctype html><html><body><main class="card">Static HTML</main><img src="${STATIC_PNG_DATA_URL}"></body></html>`);
    await expect(admitGpuHybridDataOnlyDocument({ source: "surfaces/card.html", sourcePath: "/retained/package/surfaces/card.html", fulfillment: fulfilled.fulfillment })).resolves.toEqual({ schema: "shellx-motion/gpu-hybrid-html-policy@1", policy: "strict-data-only-html", source: "surfaces/card.html", sourceSha256: fulfilled.sha256, byteLength: fulfilled.byteLength });
    expect(fulfilled.reads).toEqual(["/retained/package/surfaces/card.html"]);
  });

  it.each([
    ["inline script", "<main>static</main><script>window.bad = true</script>"],
    ["inline event handler", "<body onload=alert(1)>static</body>"],
    ["javascript URL", "<img src=javascript:alert(1)>"] ,
    ["active frame", "<iframe src=\"child.html\"></iframe>"],
    ["native progress", "<progress max=\"1\" value=\"0.5\"></progress>"],
    ["declarative shadow template", "<template shadowrootmode=\"open\"><progress></progress></template>"],
    ["meta", "<meta charset=\"utf-8\">"],
    ["secondary composition", '<main data-composition-src="secondary.html"></main>'],
    ["style element", "<style>div { animation : spin 1s }</style>"],
    ["style attribute", '<div style="transition : opacity 1s"></div>'],
    ["webkit keyframes", "<style>@-webkit-keyframes spin { from { opacity: 0 } }</style>"],
    ["CSS escape", "<style>div { anim\\61tion: spin 1s }</style>"],
    ["HTML entity CSS", '<div style="anim&#97;tion:spin"></div>'],
    ["package image", '<img src="assets/logo.png">'],
    ["remote image", '<img src="https://example.test/logo.png">'],
    ["file image", '<img src="file:///outside.png">'],
    ["srcset", `<img srcset="${STATIC_PNG_DATA_URL} 1x, https://evil.test/p.png 2x">`],
    ["animated data image", '<img src="data:image/gif;base64,R0lGODlh">'],
    ["APNG data image", `<img src="${apngDataUrl()}">`],
  ])("refuses %s before browser session creation", async (_name, html) => {
    const fulfilled = fulfillmentFor(html);
    await expect(admitGpuHybridDataOnlyDocument({ source: "card.html", sourcePath: "/retained/package/card.html", fulfillment: fulfilled.fulfillment })).rejects.toThrow("strict data-only HTML refusal");
    expect(fulfilled.reads).toEqual(["/retained/package/card.html"]);
  });

  it.each([
    ["secondary composition", '<main data-composition-src="secondary.html"></main>'],
    ["native progress", "<progress max=\"1\" value=\"0.5\"></progress>"],
    ["declarative shadow template", "<template shadowrootmode=\"open\"><progress></progress></template>"],
    ["package image", '<img src="assets/logo.png">'],
    ["file image", '<img src="file:///outside.png">'],
    ["remote image", '<img src="https://example.test/logo.png">'],
    ["package stylesheet URL", '<style>.logo { background: url(assets/logo.png) }</style>'],
    ["remote stylesheet URL", '<style>.logo { background: url(https://example.test/logo.png) }</style>'],
    ["mixed srcset", `<img srcset="${STATIC_PNG_DATA_URL} 1x, https://evil.test/p.png 2x">`],
    ["animated data image", '<img src="data:image/gif;base64,R0lGODlh">'],
    ["SVG data image", '<img src="data:image/svg+xml;base64,PHN2Zz4=">'],
    ["APNG data image", `<img src="${apngDataUrl()}">`],
  ])("refuses %s from the pre-store self-contained segmented source closure", async (_name, html) => {
    const fulfilled = fulfillmentFor(html);
    await expect(admitGpuSegmentedHybridSelfContainedDocument({ source: "card.html", sourcePath: "/retained/package/card.html", fulfillment: fulfilled.fulfillment })).rejects.toThrow("GPU hybrid strict data-only HTML refusal");
    expect(fulfilled.reads).toEqual(["/retained/package/card.html"]);
  });

  it("retains only the bounded primary bytes for a self-contained segmented source", async () => {
    const html = `<main><img src="${STATIC_PNG_DATA_URL}"></main>`;
    const fulfilled = fulfillmentFor(html);
    const admitted = await admitGpuSegmentedHybridSelfContainedDocument({ source: "card.html", sourcePath: "/retained/package/card.html", fulfillment: fulfilled.fulfillment });
    expect(admitted).toMatchObject({ source: "card.html", sourceSha256: fulfilled.sha256, byteLength: fulfilled.byteLength, bytes: Buffer.from(html) });
    expect(fulfilled.reads).toEqual(["/retained/package/card.html"]);
  });

  it.each([
    ["relative src", "<img src=assets/logo.png>"],
    ["HTTPS src", "<img src=https://example.test/logo.png>"],
    ["file src", "<img src=file:///outside.png>"],
    ["GIF src", "<img src=data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=>"],
    ["SVG src", '<img src=data:image/svg+xml;base64,PHN2Zz4=>'],
    ["srcset", "<img srcset=https://example.test/logo.png>"],
    ["action", "<main action=https://example.test/submit></main>"],
    ["formaction", "<main formaction=https://example.test/submit></main>"],
    ["unquoted background", "<body background=https://example.test/background.png></body>"],
    ["unquoted entity-obfuscated style URL", "<div style=background-image:u&#114;l(https://approved.example/x)></div>"],
    ["unquoted CSS-escaped style URL", String.raw`<div style=background-image:u\72l(https://approved.example/x)></div>`],
    ["mixed-case unquoted style URL", "<div StYlE=background-image:u&#114;l(https://approved.example/x)></div>"],
    ["SVG presentation URL with an HTML entity", "<svg><rect fill=u&#114;l(https://approved.example/x#paint)></rect></svg>"],
    ["SVG presentation URL with a CSS escape", String.raw`<svg><rect filter=u\72l(https://approved.example/x#paint)></rect></svg>`],
    ["SVG presentation URL with a CSS comment", "<svg><rect clip-path=u/**/rl(https://approved.example/x#paint)></rect></svg>"],
    ["quoted background", '<table background="https://example.test/background.png"></table>'],
    ["abrupt empty comment close", "<!--><img src=https://example.test/logo.png>"],
    ["abrupt empty comment dash close", "<!---><img src=https://example.test/logo.png>"],
    ["incorrect comment end bang close", "<!--text--!><img src=https://example.test/logo.png>"],
    ["title RCDATA comment differential", "<title><!--</title><img src=https://example.test/logo.png>--></title>"],
    ["xmp raw-text comment differential", "<xmp><!--</xmp><img src=https://example.test/logo.png>--></xmp>"],
    ["noembed raw-text comment differential", "<noembed><!--</noembed><img src=https://example.test/logo.png>--></noembed>"],
    ["noframes raw-text comment differential", "<noframes><!--</noframes><img src=https://example.test/logo.png>--></noframes>"],
    ["noscript raw-text comment differential", "<noscript><!--</noscript><img src=https://example.test/logo.png>--></noscript>"],
    ["plaintext tokenizer state", "<plaintext><!--</plaintext><img src=https://example.test/logo.png>"],
    ["unterminated quote", `<img src="${STATIC_PNG_DATA_URL}>`],
    ["unterminated tag", `<img src=${STATIC_PNG_DATA_URL}`],
  ])("refuses parser-state, unquoted, or malformed %s through both strict HTML admissions", async (_name, html) => {
    const ordinary = fulfillmentFor(html);
    await expect(admitGpuHybridDataOnlyDocument({ source: "card.html", sourcePath: "/retained/package/card.html", fulfillment: ordinary.fulfillment })).rejects.toThrow("strict data-only HTML refusal");
    expect(ordinary.reads).toEqual(["/retained/package/card.html"]);

    const segmented = fulfillmentFor(html);
    await expect(admitGpuSegmentedHybridSelfContainedDocument({ source: "card.html", sourcePath: "/retained/package/card.html", fulfillment: segmented.fulfillment })).rejects.toThrow("strict data-only HTML refusal");
    expect(segmented.reads).toEqual(["/retained/package/card.html"]);
  });

  it.each([
    ["quoted static image", `<img src="${STATIC_PNG_DATA_URL}">`],
    ["quoted static background", `<body background="${STATIC_PNG_DATA_URL}"></body>`],
    ["unquoted fragment href", "<svg><use href=#shape></use></svg>"],
    ["quoted xlink fragment", "<svg><use xlink:href=\"#shape\"></use></svg>"],
    ["unquoted xlink fragment", "<svg><use xlink:href=#shape></use></svg>"],
    ["ordinary comment with an inert remote-looking image", "<!-- inert <img src=https://example.test/logo.png> --><svg><use href=#shape></use></svg>"],
    ["single-dash comment continuation", "<!--text-><img src=https://example.test/logo.png>"],
    ["end-bang-dash comment continuation", "<!--text--!-><img src=https://example.test/logo.png>"],
  ])("admits %s through both strict HTML admissions", async (_name, html) => {
    const ordinary = fulfillmentFor(html);
    await expect(admitGpuHybridDataOnlyDocument({ source: "card.html", sourcePath: "/retained/package/card.html", fulfillment: ordinary.fulfillment })).resolves.toMatchObject({ policy: "strict-data-only-html" });
    expect(ordinary.reads).toEqual(["/retained/package/card.html"]);

    const segmented = fulfillmentFor(html);
    await expect(admitGpuSegmentedHybridSelfContainedDocument({ source: "card.html", sourcePath: "/retained/package/card.html", fulfillment: segmented.fulfillment })).resolves.toMatchObject({ policy: "strict-data-only-html" });
    expect(segmented.reads).toEqual(["/retained/package/card.html"]);
  });
});

function fulfillmentFor(html: string): { fulfillment: BrowserPackageFulfillment; sha256: string; byteLength: number; reads: string[] } {
  const bytes = Buffer.from(html, "utf8"); const sha256 = createHash("sha256").update(bytes).digest("hex"); const reads: string[] = [];
  return {
    sha256, byteLength: bytes.byteLength, reads,
    fulfillment: {
      rootPath: "/retained/package",
      canFulfillFileUrl: () => false,
      async readPath(path) { reads.push(path); return { bytes: Buffer.from(bytes), sha256, byteLength: bytes.byteLength, relativePath: "card.html", contentType: "text/html; charset=utf-8" }; },
      async readFileUrl() { throw new Error("not used"); },
      inputHashes: () => ({ "browser-package/card.html": sha256 })
    }
  };
}

const STATIC_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4z8DwH4QZYAwAR8oH+WdZbrcAAAAASUVORK5CYII=";
const STATIC_PNG_DATA_URL = `data:image/png;base64,${STATIC_PNG_BASE64}`;

function apngDataUrl(): string {
  const png = Buffer.from(STATIC_PNG_BASE64, "base64");
  const insertAt = 8 + 12 + png.readUInt32BE(8);
  const type = Buffer.from("acTL", "ascii");
  const data = Buffer.from([0, 0, 0, 1, 0, 0, 0, 0]);
  const chunk = Buffer.alloc(12 + data.byteLength);
  chunk.writeUInt32BE(data.byteLength, 0);
  type.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([type, data])), 8 + data.byteLength);
  return `data:image/png;base64,${Buffer.concat([png.subarray(0, insertAt), chunk, png.subarray(insertAt)]).toString("base64")}`;
}
