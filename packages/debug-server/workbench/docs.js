/**
 * docs.js — DOM controller for the engine-room Docs reader.
 *
 * Role: consume the server-half documentation contract — `GET /workbench/docs/index.json`
 * (a nav tree of sections → pages) and `GET /workbench/docs/page?id=<pageId>`
 * (Markdown text) — and render it locally. Markdown is rendered by the hand-written,
 * dependency-free strict renderer in markdown.js, which HTML-escapes all source
 * before emitting a whitelisted tag set, so a doc page can never inject live markup
 * or scripts into this surface (the CSP would block scripts anyway).
 *
 * Honest degradation: the server half that serves these endpoints may not be merged
 * into a given build. When the index endpoint 404s, the reader shows a clear
 * "documentation endpoints unavailable in this build" state instead of failing
 * silently or pretending it has content.
 *
 * Dependencies: /workbench-session.js (optional auth token), /markdown.js (renderer).
 * Transport: GET /workbench/docs/index.json, GET /workbench/docs/page?id=…
 * Primary caller: served at /workbench/docs by the Motion debug server.
 */
import { createWorkbenchSession } from "/workbench-session.js";
import { renderMarkdown } from "/markdown.js";

(() => {
  "use strict";

  const $ = (selector) => document.querySelector(selector);
  const object = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});
  const list = (value) => (Array.isArray(value) ? value : []);
  const text = (value, fallback = "") => (typeof value === "string" && value.trim() ? value.trim() : fallback);

  const ui = {
    shell: $("#appShell"),
    sessionState: $("#sessionState"),
    sessionButton: $("#sessionButton"),
    tierChip: $("#tierChip"),
    connectDialog: $("#connectDialog"),
    connectForm: $("#connectForm"),
    capabilityToken: $("#capabilityToken"),
    connectError: $("#connectError"),
    docsNav: $("#docsNav"),
    docsContent: $("#docsContent"),
    statusMessage: $("#statusMessage"),
    statusDetail: $("#statusDetail")
  };

  const store = { pages: [], activePageId: "" };

  const session = createWorkbenchSession({
    ui,
    // Documentation is authenticated like the rest of the Workbench. A fresh connection loads
    // the index; a disconnected page renders its local connect state without deliberately making
    // a request the server must reject.
    onConnected: () => { void loadIndex(); },
    onDisconnected: () => showDisconnectedDocs()
  });

  function el(tag, className, textContent) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (textContent !== undefined) node.textContent = String(textContent);
    return node;
  }

  function setStatus(message, detail = "Documentation reader") {
    ui.statusMessage.textContent = message;
    ui.statusDetail.textContent = detail;
  }

  /** Auth header when a token is available; docs endpoints may or may not require it. */
  function authHeaders() {
    return session.state.token ? { authorization: `Bearer ${session.state.token}` } : {};
  }

  function degraded(title, detail) {
    ui.docsNav.replaceChildren(el("div", "empty-copy", "Unavailable"));
    const article = el("div", "docs-article");
    const box = el("div", "empty-state");
    box.append(el("strong", "", title), el("span", "", detail));
    article.append(box);
    ui.docsContent.replaceChildren(article);
  }

  function showDisconnectedDocs() {
    degraded("Connect to read the documentation", "Start Motion normally to connect automatically, or use Connect for a manual session.");
    setStatus("Motion is disconnected.", "Start Motion to continue");
  }

  // ----- index -----
  async function loadIndex() {
    setStatus("Loading documentation…", "Preparing Motion guides and references");
    try {
      const response = await fetch("/workbench/docs/index.json", { headers: authHeaders() });
      if (response.status === 404) {
        degraded("Documentation unavailable in this build", "This Motion build does not include the documentation reader content.");
        setStatus("Documentation unavailable.", "Not included in this build");
        return;
      }
      if (response.status === 401) {
        degraded("Connect to read the documentation", "Start Motion normally to connect automatically, or use Connect for a manual Debug API session.");
        setStatus("Motion is disconnected.", "Start Motion to continue");
        return;
      }
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        degraded("Could not load the documentation", text(object(body.error).message, "The documentation could not be read."));
        return;
      }
      renderNav(object(body));
    } catch (error) {
      degraded("Could not reach the documentation index", error instanceof Error ? error.message : String(error));
    }
  }

  /** Render the nav tree (sections → pages) and open the first page. */
  function renderNav(index) {
    const sections = list(index.sections);
    store.pages = [];
    ui.docsNav.replaceChildren();
    if (sections.length === 0) {
      degraded("No documentation pages", "The documentation index is empty.");
      return;
    }
    for (const rawSection of sections) {
      const section = object(rawSection);
      const label = text(section.title, text(section.label, "Section"));
      ui.docsNav.append(el("div", "docs-section-label", label));
      for (const rawPage of list(section.pages)) {
        const page = object(rawPage);
        const id = text(page.id);
        if (!id) continue;
        const title = text(page.title, id);
        store.pages.push({ id, title });
        const link = el("button", "docs-nav-link", title);
        link.type = "button";
        link.dataset.pageId = id;
        link.addEventListener("click", () => void openPage(id));
        ui.docsNav.append(link);
      }
    }
    setStatus(`${store.pages.length} documentation pages.`, "Ready to read");
    const first = new URLSearchParams(location.search).get("page") || (store.pages[0] && store.pages[0].id);
    if (first) void openPage(first);
    else degraded("No documentation pages", "The documentation index has sections but no pages.");
  }

  // ----- page -----
  async function openPage(id) {
    store.activePageId = id;
    document.querySelectorAll(".docs-nav-link").forEach((link) => {
      if (link.dataset.pageId === id) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
    const article = el("div", "docs-article");
    article.append(el("div", "empty-copy", "Loading…"));
    ui.docsContent.replaceChildren(article);
    setStatus(`Loading ${pageTitle(id)}…`, "Opening guide");
    try {
      const response = await fetch(`/workbench/docs/page?id=${encodeURIComponent(id)}`, { headers: authHeaders() });
      if (response.status === 404) {
        showPageError("Page not found", `The documentation page "${id}" is not available in this build.`);
        return;
      }
      if (!response.ok) {
        showPageError("Could not load page", "The selected documentation page could not be read.");
        return;
      }
      const markdown = await response.text();
      const rendered = el("article", "docs-article");
      // renderMarkdown escapes all source before emitting a whitelisted tag set,
      // so assigning its output via innerHTML is safe by construction.
      rendered.innerHTML = renderMarkdown(markdown);
      ui.docsContent.replaceChildren(rendered);
      ui.docsContent.scrollTop = 0;
      setStatus(pageTitle(id), "Ready to read");
    } catch (error) {
      showPageError("Could not load the page", error instanceof Error ? error.message : String(error));
    }
  }

  function pageTitle(id) {
    const page = store.pages.find((entry) => entry.id === id);
    return page ? page.title : id;
  }

  function showPageError(title, detail) {
    const article = el("div", "docs-article");
    const box = el("div", "empty-state danger");
    box.append(el("strong", "", title), el("span", "", detail));
    article.append(box);
    ui.docsContent.replaceChildren(article);
    setStatus(title, "Could not display this guide");
  }

  // ----- boot -----
  session.wire();
  // Wait for the retained/bootstrap session before requesting authenticated docs. Starting the
  // index request in parallel created a visible disconnected flash and a spurious 401 on slower
  // hosts. With no usable session, render the page's honest Connect state locally.
  void bootDocsSession();

  async function bootDocsSession() {
    try {
      await session.boot({ autoPrompt: false });
    } catch {
      showDisconnectedDocs();
      return;
    }
    if (!session.state.connected) showDisconnectedDocs();
  }
})();
