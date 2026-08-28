import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { secureApprovedAgentEntryHtml } from "./approved-agent-entry-admission.js";

function hash(body: string): string {
  return `'sha256-${createHash("sha256").update(body, "utf8").digest("base64")}'`;
}

describe("approved-agent-entry admission", () => {
  it("hashes the exact executable classic-script bytes while leaving style/comment text inert", () => {
    const executable = "document.body.dataset.ready = 'yes';";
    const styleText = "notExecutableSecondaryCode()";
    const result = secureApprovedAgentEntryHtml(`<!doctype html><html><head><style>.x::after { content: '<script>${styleText}</script>'; }</style><!-- <script>ignored()</script> --></head><body><script>${executable}</script></body></html>`);

    expect(result).toEqual({ html: expect.any(String) });
    if ("error" in result) return;
    expect(result.html).toMatch(/^<!doctype html><html><head><meta http-equiv="Content-Security-Policy"/);
    expect(result.html).toContain(hash(executable));
    expect(result.html).not.toContain(hash(styleText));
    expect(result.html).not.toContain("unsafe-eval");
  });

  it("puts the host CSP before a malformed caller script even when a head appears later", () => {
    const body = "globalThis.allowedByEntry = true;";
    const result = secureApprovedAgentEntryHtml(`<script>${body}</script><head><title>late</title></head>`);
    expect(result).toEqual({ html: expect.any(String) });
    if ("error" in result) return;
    expect(result.html.indexOf("Content-Security-Policy")).toBeLessThan(result.html.indexOf(body));
    expect(result.html).toContain(hash(body));
  });

  it("hashes the browser-normalized classic body while retaining the submitted source bytes", () => {
    const submitted = "document.body.dataset.line = 'one';\r\ndocument.body.dataset.line += 'two';";
    const result = secureApprovedAgentEntryHtml(`<script>${submitted}</script>`);
    expect(result).toEqual({ html: expect.any(String) });
    if ("error" in result) return;
    expect(result.html).toContain(hash(submitted.replace(/\r\n?/g, "\n")));
    expect(result.html).toContain(submitted);
  });

  it("refuses computed eval, constructor codegen, inert script data, event handlers, and javascript URLs", () => {
    const rejected = [
      "<script>globalThis['ev' + 'al']('secondary')</script>",
      "<script>[].filter.constructor('secondary')()</script>",
      "<script /src=payload.js></script>",
      "<script /type=module>export {}</script>",
      "<svg><script href=payload.js></script></svg>",
      "<script type=application/json>{\"code\":\"secondary\"}</script>",
      "<button onclick=\"secondary()\">go</button>",
      "<button/onclick=\"secondary()\">go</button>",
      "<a href=\"javascript:secondary()\">go</a>",
      "<meta http-equiv=refresh content=\"0; url=secondary.html\">",
    ];
    for (const html of rejected) expect(secureApprovedAgentEntryHtml(html)).toEqual({ error: expect.any(String) });
  });
});
