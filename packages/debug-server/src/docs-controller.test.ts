/**
 * docs-controller.test.ts — deterministic retry coverage for the shipped Docs reader.
 *
 * The Workbench controller is an untyped browser module. This test evaluates the exact
 * shipped source with its two static imports injected as controlled collaborators, then
 * drives its real navigation button through a small DOM harness. It intentionally does
 * not duplicate `openPage`: repeated loading clicks must not duplicate a request, a
 * completed failure must remain retryable, and a stale cross-page response must not
 * replace the newer requested document.
 */
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const DOCS_CONTROLLER = fileURLToPath(new URL("../workbench/docs.js", import.meta.url));

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly dataset: Record<string, string> = {};
  private readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, Array<(event: { target: FakeElement; preventDefault(): void }) => unknown>>();
  className = "";
  innerHTML = "";
  scrollTop = 0;
  textContent = "";
  type = "";

  append(...nodes: FakeElement[]): void {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes: FakeElement[]): void {
    this.children.splice(0, this.children.length, ...nodes);
    this.innerHTML = "";
  }

  addEventListener(type: string, listener: (event: { target: FakeElement; preventDefault(): void }) => unknown): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  click(): void {
    for (const listener of this.listeners.get("click") ?? []) {
      listener({ target: this, preventDefault() {} });
    }
  }

  contains(node: FakeElement): boolean {
    return node === this || this.children.some((child) => child.contains(node));
  }

  closest(selector: string): FakeElement | null {
    return this.matches(selector) ? this : null;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const matches: FakeElement[] = [];
    const visit = (node: FakeElement) => {
      if (node.matches(selector)) matches.push(node);
      for (const child of node.children) visit(child);
    };
    for (const child of this.children) visit(child);
    return matches;
  }

  scrollIntoView(): void {}

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  private matches(selector: string): boolean {
    if (selector.startsWith(".")) return this.className.split(/\s+/).includes(selector.slice(1));
    if (selector === "[id]") return this.attributes.has("id");
    return false;
  }
}

class FakeDocument {
  private readonly elements = new Map<string, FakeElement>();

  constructor() {
    for (const id of [
      "appShell", "sessionState", "sessionButton", "tierChip", "connectDialog", "connectForm",
      "capabilityToken", "connectError", "docsNav", "docsContent", "statusMessage", "statusDetail"
    ]) this.elements.set(id, new FakeElement());
  }

  createElement(): FakeElement {
    return new FakeElement();
  }

  querySelector(selector: string): FakeElement | null {
    if (!selector.startsWith("#")) return null;
    return this.elements.get(selector.slice(1)) ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    return [...this.elements.values()].flatMap((element) => [element, ...element.querySelectorAll(selector)])
      .filter((element) => selector.startsWith(".") && element.className.split(/\s+/).includes(selector.slice(1)));
  }
}

class FakeResponse {
  constructor(
    readonly status: number,
    private readonly body: unknown = ""
  ) {}

  get ok(): boolean {
    return this.status >= 200 && this.status < 300;
  }

  async json(): Promise<unknown> {
    return this.body;
  }

  async text(): Promise<string> {
    return String(this.body);
  }
}

interface WorkbenchSessionOptions {
  onConnected(): void;
  onDisconnected?(reason: string): void;
}

interface WorkbenchSessionHarness {
  state: { connected: boolean; token: string };
  disconnectReasons: string[];
  wire(): void;
  boot(): Promise<void>;
  disconnect(reason?: string): void;
  reconnect(token?: string): void;
}

type WorkbenchSessionFactory = (options: WorkbenchSessionOptions) => WorkbenchSessionHarness;

type MarkdownRenderer = (markdown: string) => string;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve(value) { resolvePromise(value); },
    reject(reason) { rejectPromise(reason); }
  };
}

async function runShippedDocsController(input: {
  document: FakeDocument;
  fetch: (url: string, init?: { headers?: Record<string, string> }) => Promise<FakeResponse>;
  renderedMarkdown: string[];
}): Promise<{ session: WorkbenchSessionHarness }> {
  const source = await readFile(DOCS_CONTROLLER, "utf8");
  const executable = source
    .replace('import { createWorkbenchSession } from "/workbench-session.js";\n', "")
    .replace('import { renderMarkdown, resolveIndexedDocumentationLink } from "/markdown.js";\n', "");
  expect(executable, "the controller imports must remain the two injected browser collaborators").not.toMatch(/^import /m);

  let session!: WorkbenchSessionHarness;
  const createWorkbenchSession: WorkbenchSessionFactory = (options) => {
    const state = { connected: true, token: "docs-retry-test-token" };
    const disconnectReasons: string[] = [];
    session = {
      state,
      disconnectReasons,
      wire() {},
      async boot() { options.onConnected(); },
      disconnect(reason = "Workbench disconnected.") {
        state.token = "";
        state.connected = false;
        disconnectReasons.push(reason);
        options.onDisconnected?.(reason);
      },
      reconnect(token = "docs-reconnected-test-token") {
        state.token = token;
        state.connected = true;
        options.onConnected();
      }
    };
    return session;
  };
  const renderMarkdown: MarkdownRenderer = (markdown) => {
    input.renderedMarkdown.push(markdown);
    return `<h1>${markdown}</h1>`;
  };
  const execute = new Function(
    "document", "location", "URLSearchParams", "fetch", "Element", "createWorkbenchSession", "renderMarkdown", "resolveIndexedDocumentationLink",
    `"use strict";\n${executable}`
  ) as (
    document: FakeDocument,
    location: { search: string },
    URLSearchParams: typeof globalThis.URLSearchParams,
    fetch: typeof input.fetch,
    Element: typeof FakeElement,
    createWorkbenchSession: WorkbenchSessionFactory,
    renderMarkdown: MarkdownRenderer,
    resolveIndexedDocumentationLink: () => null
  ) => void;
  execute(
    input.document,
    { search: "" },
    URLSearchParams,
    input.fetch,
    FakeElement,
    createWorkbenchSession,
    renderMarkdown,
    () => null
  );
  return { session };
}

async function settleUntil(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (condition()) return;
    await Promise.resolve();
  }
  expect(condition(), "the shipped async controller did not settle").toBe(true);
}

async function settleTurns(turns = 5): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
}

describe("Workbench Docs controller retry", () => {
  const pageFailures: ReadonlyArray<{
    name: string;
    settle(request: Deferred<FakeResponse>): void;
  }> = [
    { name: "404", settle(request) { request.resolve(new FakeResponse(404)); } },
    { name: "non-OK", settle(request) { request.resolve(new FakeResponse(503)); } },
    { name: "fetch throw", settle(request) { request.reject(new Error("temporary documentation transport failure")); } }
  ];

  for (const failure of pageFailures) {
    it(`suppresses duplicate clicks while loading and retries after a ${failure.name} failure`, async () => {
      const document = new FakeDocument();
      const pageUrls: string[] = [];
      const renderedMarkdown: string[] = [];
      const firstPage = deferred<FakeResponse>();
      await runShippedDocsController({
        document,
        renderedMarkdown,
        fetch: async (url) => {
          if (url === "/workbench/docs/index.json") {
            return new FakeResponse(200, {
              sections: [{ title: "Guides", pages: [{ id: "quickstart", title: "Quickstart", file: "quickstart.md" }] }]
            });
          }
          pageUrls.push(url);
          return pageUrls.length === 1
            ? firstPage.promise
            : new FakeResponse(200, "Recovered documentation");
        }
      });

      await settleUntil(() => pageUrls.length === 1);
      const retryButton = document.querySelector("#docsNav")!.querySelector(".docs-nav-link")!;
      expect(retryButton.getAttribute("aria-current")).toBeNull();

      retryButton.click();
      retryButton.click();
      expect(pageUrls).toHaveLength(1);

      failure.settle(firstPage);
      await settleUntil(() => document.querySelector("#docsContent")!.querySelector(".danger") !== null);

      retryButton.click();
      await settleUntil(() => renderedMarkdown.length === 1);

      expect(pageUrls).toEqual([
        "/workbench/docs/page?id=quickstart",
        "/workbench/docs/page?id=quickstart"
      ]);
      expect(renderedMarkdown).toEqual(["Recovered documentation"]);
      expect(retryButton.getAttribute("aria-current")).toBe("page");
    });
  }

  it("uses shared session teardown when the documentation index returns 401", async () => {
    const document = new FakeDocument();
    const renderedMarkdown: string[] = [];
    const requests: string[] = [];
    const { session } = await runShippedDocsController({
      document,
      renderedMarkdown,
      fetch: async (url) => {
        requests.push(url);
        return new FakeResponse(401);
      }
    });

    await settleUntil(() => session.disconnectReasons.length === 1);

    expect(requests).toEqual(["/workbench/docs/index.json"]);
    expect(session.disconnectReasons).toEqual(["The local access key was rejected."]);
    expect(session.state).toEqual({ connected: false, token: "" });
    expect(document.querySelector("#statusMessage")!.textContent).toBe("Motion is disconnected.");
    expect(document.querySelector("#docsNav")!.querySelector(".docs-nav-link")).toBeNull();
    expect(renderedMarkdown).toEqual([]);
  });

  it("uses shared session teardown when an indexed documentation page returns 401", async () => {
    const document = new FakeDocument();
    const renderedMarkdown: string[] = [];
    const pageUrls: string[] = [];
    const { session } = await runShippedDocsController({
      document,
      renderedMarkdown,
      fetch: async (url) => {
        if (url === "/workbench/docs/index.json") {
          return new FakeResponse(200, {
            sections: [{ title: "Guides", pages: [{ id: "quickstart", title: "Quickstart", file: "quickstart.md" }] }]
          });
        }
        pageUrls.push(url);
        return new FakeResponse(401);
      }
    });

    await settleUntil(() => session.disconnectReasons.length === 1);

    expect(pageUrls).toEqual(["/workbench/docs/page?id=quickstart"]);
    expect(session.disconnectReasons).toEqual(["The local access key was rejected."]);
    expect(session.state).toEqual({ connected: false, token: "" });
    expect(document.querySelector("#statusMessage")!.textContent).toBe("Motion is disconnected.");
    expect(document.querySelector("#docsNav")!.querySelector(".docs-nav-link")).toBeNull();
    expect(renderedMarkdown).toEqual([]);
  });

  it("tears down the current session once when an earlier deferred page returns 401", async () => {
    const document = new FakeDocument();
    const renderedMarkdown: string[] = [];
    const pageUrls: string[] = [];
    const quickstart = deferred<FakeResponse>();
    const rendering = deferred<FakeResponse>();
    const { session } = await runShippedDocsController({
      document,
      renderedMarkdown,
      fetch: async (url) => {
        if (url === "/workbench/docs/index.json") {
          return new FakeResponse(200, {
            sections: [{ title: "Guides", pages: [
              { id: "quickstart", title: "Quickstart", file: "quickstart.md" },
              { id: "rendering", title: "Rendering", file: "rendering.md" }
            ] }]
          });
        }
        pageUrls.push(url);
        return url.endsWith("quickstart") ? quickstart.promise : rendering.promise;
      }
    });

    await settleUntil(() => pageUrls.length === 1);
    const renderingButton = document.querySelector("#docsNav")!.querySelectorAll(".docs-nav-link")
      .find((button) => button.dataset.pageId === "rendering")!;
    renderingButton.click();
    await settleUntil(() => pageUrls.length === 2);

    // Quickstart is no longer the current page generation, but its response still belongs to
    // the current authenticated session and must invalidate that session.
    quickstart.resolve(new FakeResponse(401));
    await settleUntil(() => session.disconnectReasons.length === 1);

    // The second response was invalidated by the shared teardown, so even another 401 cannot
    // invoke a second teardown or restore docs state.
    rendering.resolve(new FakeResponse(401));
    await settleTurns();

    expect(pageUrls).toEqual([
      "/workbench/docs/page?id=quickstart",
      "/workbench/docs/page?id=rendering"
    ]);
    expect(session.disconnectReasons).toEqual(["The local access key was rejected."]);
    expect(session.state).toEqual({ connected: false, token: "" });
    expect(document.querySelector("#statusMessage")!.textContent).toBe("Motion is disconnected.");
    expect(document.querySelector("#docsNav")!.querySelector(".docs-nav-link")).toBeNull();
    expect(renderedMarkdown).toEqual([]);
  });

  it("ignores an earlier documentation index after disconnect then reconnect", async () => {
    const document = new FakeDocument();
    const renderedMarkdown: string[] = [];
    const pageUrls: string[] = [];
    const firstIndex = deferred<FakeResponse>();
    const reconnectedIndex = deferred<FakeResponse>();
    let indexRequests = 0;
    const { session } = await runShippedDocsController({
      document,
      renderedMarkdown,
      fetch: async (url) => {
        if (url === "/workbench/docs/index.json") {
          indexRequests += 1;
          return indexRequests === 1 ? firstIndex.promise : reconnectedIndex.promise;
        }
        pageUrls.push(url);
        return new FakeResponse(200, "Reconnected documentation");
      }
    });

    await settleUntil(() => indexRequests === 1);
    session.disconnect();
    session.reconnect();
    await settleUntil(() => indexRequests === 2);

    firstIndex.resolve(new FakeResponse(200, {
      sections: [{ title: "Stale", pages: [{ id: "stale", title: "Stale", file: "stale.md" }] }]
    }));
    await settleTurns();

    expect(pageUrls).toEqual([]);
    expect(document.querySelector("#docsNav")!.querySelector(".docs-nav-link")).toBeNull();
    expect(renderedMarkdown).toEqual([]);
    expect(document.querySelector("#statusMessage")!.textContent).toBe("Loading documentation…");

    reconnectedIndex.resolve(new FakeResponse(200, {
      sections: [{ title: "Fresh", pages: [{ id: "fresh", title: "Fresh", file: "fresh.md" }] }]
    }));
    await settleUntil(() => renderedMarkdown.length === 1);

    expect(pageUrls).toEqual(["/workbench/docs/page?id=fresh"]);
    expect(renderedMarkdown).toEqual(["Reconnected documentation"]);
    expect(document.querySelector("#statusMessage")!.textContent).toBe("Fresh");
  });

  it("ignores an earlier documentation page after disconnect then reconnect", async () => {
    const document = new FakeDocument();
    const renderedMarkdown: string[] = [];
    const pageUrls: string[] = [];
    const firstPage = deferred<FakeResponse>();
    const reconnectedPage = deferred<FakeResponse>();
    const { session } = await runShippedDocsController({
      document,
      renderedMarkdown,
      fetch: async (url) => {
        if (url === "/workbench/docs/index.json") {
          return new FakeResponse(200, {
            sections: [{ title: "Guides", pages: [{ id: "quickstart", title: "Quickstart", file: "quickstart.md" }] }]
          });
        }
        pageUrls.push(url);
        return pageUrls.length === 1 ? firstPage.promise : reconnectedPage.promise;
      }
    });

    await settleUntil(() => pageUrls.length === 1);
    session.disconnect();
    session.reconnect();
    await settleUntil(() => pageUrls.length === 2);

    firstPage.resolve(new FakeResponse(200, "Stale documentation"));
    await settleTurns();

    expect(renderedMarkdown).toEqual([]);
    expect(document.querySelector("#statusMessage")!.textContent).toBe("Loading Quickstart…");
    const freshButton = document.querySelector("#docsNav")!.querySelector(".docs-nav-link")!;
    expect(freshButton.getAttribute("aria-current")).toBeNull();

    reconnectedPage.resolve(new FakeResponse(200, "Current documentation"));
    await settleUntil(() => renderedMarkdown.length === 1);

    expect(pageUrls).toEqual([
      "/workbench/docs/page?id=quickstart",
      "/workbench/docs/page?id=quickstart"
    ]);
    expect(renderedMarkdown).toEqual(["Current documentation"]);
    expect(freshButton.getAttribute("aria-current")).toBe("page");
  });

  it("ignores an earlier response after navigation starts a different indexed page", async () => {
    const document = new FakeDocument();
    const pageUrls: string[] = [];
    const renderedMarkdown: string[] = [];
    const quickstart = deferred<FakeResponse>();
    const rendering = deferred<FakeResponse>();
    await runShippedDocsController({
      document,
      renderedMarkdown,
      fetch: async (url) => {
        if (url === "/workbench/docs/index.json") {
          return new FakeResponse(200, {
            sections: [{ title: "Guides", pages: [
              { id: "quickstart", title: "Quickstart", file: "quickstart.md" },
              { id: "rendering", title: "Rendering", file: "rendering.md" }
            ] }]
          });
        }
        pageUrls.push(url);
        return url.endsWith("quickstart") ? quickstart.promise : rendering.promise;
      }
    });

    await settleUntil(() => pageUrls.length === 1);
    const pageButtons = document.querySelector("#docsNav")!.querySelectorAll(".docs-nav-link");
    const quickstartButton = pageButtons.find((button) => button.dataset.pageId === "quickstart")!;
    const renderingButton = pageButtons.find((button) => button.dataset.pageId === "rendering")!;
    renderingButton.click();
    await settleUntil(() => pageUrls.length === 2);

    quickstart.resolve(new FakeResponse(200, "Stale quickstart"));
    await settleTurns();
    expect(renderedMarkdown).toEqual([]);
    expect(quickstartButton.getAttribute("aria-current")).toBeNull();
    expect(renderingButton.getAttribute("aria-current")).toBeNull();

    rendering.resolve(new FakeResponse(200, "Current rendering"));
    await settleUntil(() => renderedMarkdown.length === 1);

    expect(pageUrls).toEqual([
      "/workbench/docs/page?id=quickstart",
      "/workbench/docs/page?id=rendering"
    ]);
    expect(renderedMarkdown).toEqual(["Current rendering"]);
    expect(quickstartButton.getAttribute("aria-current")).toBeNull();
    expect(renderingButton.getAttribute("aria-current")).toBe("page");
  });
});
