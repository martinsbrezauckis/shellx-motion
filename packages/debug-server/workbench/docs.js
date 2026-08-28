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
import { renderMarkdown, resolveIndexedDocumentationLink } from "/markdown.js";

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

  // This in-memory view is populated only from the authenticated, human-filtered
  // documentation index. It is the sole authority for Docs-reader navigation.
  const store = {
    pages: [],
    activePageId: "",
    loadingPageId: "",
    pageLoadSequence: 0,
    indexLoadSequence: 0,
    sessionSequence: 0
  };

  const session = createWorkbenchSession({
    ui,
    // Documentation is authenticated like the rest of the Workbench. Every connection gets a
    // distinct sequence so an earlier index/page response cannot repopulate a later session.
    onConnected: () => {
      const sessionId = beginDocsSession();
      void loadIndex(sessionId);
    },
    onDisconnected: () => showDisconnectedDocsAfterTeardown()
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

  /**
   * A disconnected session may still have index/page promises in flight. Invalidate both kinds
   * before clearing the authenticated navigation so no earlier response can restore it.
   */
  function invalidateDocsRequests() {
    store.indexLoadSequence += 1;
    store.pageLoadSequence += 1;
    store.pages = [];
    store.activePageId = "";
    store.loadingPageId = "";
  }

  function beginDocsSession() {
    store.sessionSequence += 1;
    invalidateDocsRequests();
    return store.sessionSequence;
  }

  function showDisconnectedDocsAfterTeardown() {
    store.sessionSequence += 1;
    invalidateDocsRequests();
    showDisconnectedDocs();
  }

  function isCurrentDocsSession(sessionId) {
    return session.state.connected && store.sessionSequence === sessionId;
  }

  function startIndexLoad(sessionId) {
    if (!isCurrentDocsSession(sessionId)) return 0;
    store.indexLoadSequence += 1;
    return store.indexLoadSequence;
  }

  function isCurrentIndexLoad(sessionId, requestId) {
    return requestId !== 0
      && isCurrentDocsSession(sessionId)
      && store.indexLoadSequence === requestId;
  }

  /** Keep direct Docs-endpoint 401s on the same token/chrome teardown path as Debug API calls. */
  function disconnectForUnauthorizedDocs() {
    session.disconnect("The local access key was rejected.");
  }

  // ----- index -----
  async function loadIndex(sessionId) {
    const requestId = startIndexLoad(sessionId);
    if (!isCurrentIndexLoad(sessionId, requestId)) return;
    setStatus("Loading documentation…", "Preparing Motion guides and references");
    try {
      const response = await fetch("/workbench/docs/index.json", { headers: authHeaders() });
      if (!isCurrentIndexLoad(sessionId, requestId)) return;
      if (response.status === 404) {
        degraded("Documentation unavailable in this build", "This Motion build does not include the documentation reader content.");
        setStatus("Documentation unavailable.", "Not included in this build");
        return;
      }
      if (response.status === 401) {
        disconnectForUnauthorizedDocs();
        return;
      }
      const body = await response.json().catch(() => ({}));
      if (!isCurrentIndexLoad(sessionId, requestId)) return;
      if (!response.ok) {
        degraded("Could not load the documentation", text(object(body.error).message, "The documentation could not be read."));
        return;
      }
      renderNav(object(body), sessionId);
    } catch (error) {
      if (!isCurrentIndexLoad(sessionId, requestId)) return;
      degraded("Could not reach the documentation index", error instanceof Error ? error.message : String(error));
    }
  }

  /** Render the nav tree (sections → pages) and open the first page. */
  function renderNav(index, sessionId) {
    if (!isCurrentDocsSession(sessionId)) return;
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
        const file = text(page.file);
        store.pages.push({ id, title, file });
        const link = el("button", "docs-nav-link", title);
        link.type = "button";
        link.dataset.pageId = id;
        link.addEventListener("click", () => void openPage(id));
        ui.docsNav.append(link);
      }
    }
    setStatus(`${store.pages.length} documentation pages.`, "Ready to read");
    const requested = new URLSearchParams(location.search).get("page");
    const first = pageForId(requested)?.id || (store.pages[0] && store.pages[0].id);
    if (first) void openPage(first, "", sessionId);
    else degraded("No documentation pages", "The documentation index has sections but no pages.");
  }

  // ----- page -----
  async function openPage(id, anchor = "", sessionId = store.sessionSequence) {
    if (!isCurrentDocsSession(sessionId)) return;
    const page = pageForId(id);
    if (!page) {
      showPageError("Page not found", "The selected documentation page is not present in this authenticated index.");
      return;
    }
    if (store.activePageId === page.id && ui.docsContent.querySelector(".docs-article")) {
      const anchorFound = scrollToAnchor(ui.docsContent.querySelector(".docs-article"), anchor);
      if (anchor && !anchorFound) setStatus(page.title, `Anchor #${anchor} is unavailable in this page.`);
      return;
    }
    if (store.loadingPageId === page.id) return;
    // A loading or error article is not a rendered page. Clearing the current selection
    // before the request means a transient failure leaves the same nav item retryable.
    const requestId = startPageLoad(page.id);
    clearActivePage();
    const article = el("div", "docs-article");
    article.append(el("div", "empty-copy", "Loading…"));
    ui.docsContent.replaceChildren(article);
    setStatus(`Loading ${page.title}…`, "Opening guide");
    try {
      const response = await fetch(`/workbench/docs/page?id=${encodeURIComponent(page.id)}`, { headers: authHeaders() });
      // A 401 is session state, rather than page state. An earlier page request from this
      // still-current session must tear the shared session down before page-generation
      // suppression discards ordinary stale responses.
      if (!isCurrentDocsSession(sessionId)) return;
      if (response.status === 401) {
        disconnectForUnauthorizedDocs();
        return;
      }
      if (!isCurrentPageLoad(page.id, requestId, sessionId)) return;
      if (response.status === 404) {
        finishPageLoad(page.id, requestId);
        showPageError("Page not found", `The documentation page "${id}" is not available in this build.`);
        return;
      }
      if (!response.ok) {
        finishPageLoad(page.id, requestId);
        showPageError("Could not load page", "The selected documentation page could not be read.");
        return;
      }
      const markdown = await response.text();
      if (!isCurrentPageLoad(page.id, requestId, sessionId)) return;
      const rendered = el("article", "docs-article");
      // renderMarkdown escapes all source before emitting a whitelisted tag set,
      // so assigning its output via innerHTML is safe by construction. The Docs
      // resolver can emit an internal link only when its relative file maps back
      // to this authenticated index; it never returns a filesystem path or URL.
      rendered.innerHTML = renderMarkdown(markdown, {
        headingIds: true,
        documentationLinkResolver: (href) => resolveIndexedDocumentationLink(href, {
          currentPageId: page.id,
          pages: store.pages
        })
      });
      rendered.addEventListener("click", (event) => {
        const link = event.target instanceof Element ? event.target.closest("a[data-doc-page-id]") : null;
        if (!link || !rendered.contains(link)) return;
        const targetId = text(link.dataset.docPageId);
        const targetAnchor = text(link.dataset.docAnchor);
        if (!pageForId(targetId)) return;
        event.preventDefault();
        void openPage(targetId, targetAnchor);
      });
      ui.docsContent.replaceChildren(rendered);
      const anchorFound = scrollToAnchor(rendered, anchor);
      finishPageLoad(page.id, requestId);
      setActivePage(page.id);
      setStatus(page.title, anchor && !anchorFound ? `Anchor #${anchor} is unavailable in this page.` : anchor ? `Opened #${anchor}` : "Ready to read");
    } catch (error) {
      if (!isCurrentPageLoad(page.id, requestId, sessionId)) return;
      finishPageLoad(page.id, requestId);
      showPageError("Could not load the page", error instanceof Error ? error.message : String(error));
    }
  }

  function pageForId(id) {
    return typeof id === "string" ? store.pages.find((entry) => entry.id === id) || null : null;
  }

  function scrollToAnchor(article, anchor) {
    if (!anchor) {
      ui.docsContent.scrollTop = 0;
      return true;
    }
    const target = [...article.querySelectorAll("[id]")].find((element) => element.id === anchor);
    if (!target) {
      ui.docsContent.scrollTop = 0;
      return false;
    }
    target.scrollIntoView({ block: "start" });
    return true;
  }

  function setActivePage(id) {
    store.activePageId = id;
    document.querySelectorAll(".docs-nav-link").forEach((link) => {
      if (link.dataset.pageId === id) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
  }

  function startPageLoad(id) {
    store.pageLoadSequence += 1;
    store.loadingPageId = id;
    return store.pageLoadSequence;
  }

  function isCurrentPageLoad(id, requestId, sessionId = store.sessionSequence) {
    return isCurrentDocsSession(sessionId)
      && store.loadingPageId === id
      && store.pageLoadSequence === requestId;
  }

  function finishPageLoad(id, requestId) {
    if (!isCurrentPageLoad(id, requestId)) return;
    store.loadingPageId = "";
  }

  function clearActivePage() {
    store.activePageId = "";
    document.querySelectorAll(".docs-nav-link").forEach((link) => link.removeAttribute("aria-current"));
  }

  function showPageError(title, detail) {
    clearActivePage();
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
      showDisconnectedDocsAfterTeardown();
      return;
    }
    if (!session.state.connected) showDisconnectedDocsAfterTeardown();
  }
})();
