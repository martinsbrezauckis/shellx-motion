/**
 * workbench-nav.js — the persistent engine-room navigation, shared by every
 * workbench page (Inspector, History, Connections, Docs, About).
 *
 * Role: inject one consistent primary-navigation strip immediately below each
 * page's command bar, mark the current destination, and keep navigation always
 * available (it is connection-independent — you can move between surfaces without
 * a session). This is a self-executing ES module: each page includes it once and
 * needs no per-page nav markup. The current page is inferred from the URL path,
 * so no page-level marker attribute is required.
 *
 * Layout note: the nav is injected as a `.wb-subnav` element between the header
 * and the main content. `workbench-nav.css` uses `.app-shell:has(> .wb-subnav)`
 * to add the extra grid row, so existing pages need no layout edits of their own.
 *
 * Dependencies: workbench-nav.css (styling). No Debug API calls.
 * Primary callers: index.html, history.html, connections.html, docs.html, about.html.
 */
(() => {
  "use strict";

  /**
   * The engine-room destinations, in order. `match` decides which entry is the
   * current page for a given pathname; the first match wins (Inspector is the
   * fallback for the bare /workbench root).
   */
  const DESTINATIONS = [
    { id: "inspector", label: "Inspector", href: "/workbench", match: (path) => path === "/workbench" || path === "/workbench/" },
    { id: "history", label: "History", href: "/workbench/history", match: (path) => path.startsWith("/workbench/history") },
    { id: "connections", label: "Connections", href: "/workbench/connections", match: (path) => path.startsWith("/workbench/connections") },
    { id: "docs", label: "Docs", href: "/workbench/docs", match: (path) => path === "/workbench/docs" || path === "/workbench/docs/" },
    { id: "about", label: "About", href: "/workbench/about", match: (path) => path.startsWith("/workbench/about") }
  ];

  /** Inline SVG glyphs (currentColor stroke) keyed by destination id. */
  const GLYPHS = {
    inspector: "M4 5h16M4 12h10M4 19h16",
    history: "M12 8v4l3 2M4 12a8 8 0 1 0 2-5.3M4 4v3h3",
    connections: "M8 12h8M6 8H4a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h2M18 8h2a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2",
    docs: "M6 3h9l4 4v14H6zM14 3v5h5",
    about: "M12 8h.01M11 12h1v5h1M4 12a8 8 0 1 0 16 0 8 8 0 0 0-16 0z"
  };

  /**
   * Resolve the current destination id from a pathname.
   * @param {string} pathname The current URL pathname.
   * @returns {string} The current destination id.
   */
  function currentDestination(pathname) {
    const found = DESTINATIONS.find((destination) => destination.match(pathname));
    return found ? found.id : "inspector";
  }

  /**
   * Build the nav element with an accessible link per destination and the current
   * one marked `aria-current="page"`.
   * @param {string} current The current destination id.
   * @returns {HTMLElement} The nav element.
   */
  function buildNav(current) {
    const nav = document.createElement("nav");
    nav.className = "wb-subnav";
    nav.setAttribute("aria-label", "Engine room sections");
    for (const destination of DESTINATIONS) {
      const link = document.createElement("a");
      link.className = "wb-nav-link";
      link.href = destination.href;
      link.textContent = destination.label;
      if (destination.id === current) link.setAttribute("aria-current", "page");
      const glyph = destination.id in GLYPHS ? svgGlyph(GLYPHS[destination.id]) : null;
      if (glyph) link.prepend(glyph);
      nav.append(link);
    }
    return nav;
  }

  /**
   * Create a small inline SVG glyph from an SVG path string.
   * @param {string} d The SVG path `d` attribute.
   * @returns {SVGElement} The glyph element.
   */
  function svgGlyph(d) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("class", "wb-nav-glyph");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    svg.append(path);
    return svg;
  }

  /** Mount the nav below the command bar once the DOM is ready. */
  function mount() {
    const shell = document.querySelector(".app-shell");
    const header = document.querySelector(".app-shell > .command-bar");
    if (!shell || !header || shell.querySelector(":scope > .wb-subnav")) return;
    const nav = buildNav(currentDestination(location.pathname));
    header.after(nav);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount, { once: true });
  } else {
    mount();
  }
})();
