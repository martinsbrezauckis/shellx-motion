/* Canonical manual interaction layer: ranked search, record selection, focused
 * deep links, copy feedback, the optional mobile tree, and the Workbench map. */
(() => {
  "use strict";

  const search = document.querySelector("[data-manual-search]");
  const status = document.querySelector("[data-search-status]");
  const results = document.querySelector("[data-search-results]");
  const empty = document.querySelector("[data-empty-state]");
  const links = Array.from(document.querySelectorAll("[data-feature-link]"));
  const features = Array.from(document.querySelectorAll("[data-feature-id]"));
  const sections = Array.from(document.querySelectorAll("[data-manual-section]"));
  const folders = Array.from(document.querySelectorAll(".manual-folder"));
  const copyButtons = Array.from(document.querySelectorAll("[data-copy-permalink]"));
  const featuresById = new Map(features.map((feature) => [feature.dataset.featureId, feature]));
  const navToggle = document.querySelector("[data-manual-nav-toggle]");
  const nav = document.querySelector("[data-manual-nav]");
  const navSymbol = document.querySelector("[data-manual-nav-symbol]");
  const interfaceMap = document.querySelector("[data-interface-map]");
  const interfaceMapImage = document.querySelector("[data-interface-map-image]");
  const interfaceMapData = parseRecords(document.querySelector("[data-interface-map-data]")?.textContent);
  const highlight = document.querySelector("[data-manual-highlight]");
  const highlightFrame = document.querySelector("[data-manual-highlight-frame]");
  const surfaceLink = document.querySelector("[data-map-open-image]");
  const detailTitle = document.querySelector("[data-detail-title]");
  const detailDescription = document.querySelector("[data-detail-description]");
  const detailView = document.querySelector("[data-detail-view]");
  const detailSection = document.querySelector("[data-detail-section]");
  const detailId = document.querySelector("[data-detail-id]");
  const detailSteps = document.querySelector("[data-detail-steps]");
  const detailNote = document.querySelector("[data-detail-note]");
  const detailNoteText = document.querySelector("[data-detail-note-text]");
  const detailOpenImage = document.querySelector("[data-detail-open-image]");
  const detailArticleLink = document.querySelector("[data-detail-article-link]");
  let ranked = [];
  let activeResult = -1;

  function parseRecords(text) {
    if (!text) return {};
    try {
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  function reducedMotion() {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function setNavOpen(open) {
    nav?.classList.toggle("is-open", open);
    navToggle?.setAttribute("aria-expanded", String(open));
    if (navSymbol) navSymbol.textContent = open ? "−" : "+";
  }

  navToggle?.addEventListener("click", () => {
    setNavOpen(navToggle.getAttribute("aria-expanded") !== "true");
  });

  function captureAssetHref(record) {
    const file = record?.capture?.file;
    return typeof file === "string" && /^assets\/[A-Za-z0-9][A-Za-z0-9._-]*\.png$/.test(file)
      ? `./${file}`
      : null;
  }

  function featureFragmentHref(featureId) {
    return typeof featureId === "string" && /^[a-z0-9][a-z0-9._-]*$/i.test(featureId)
      ? `#${featureId}`
      : null;
  }

  function updateInterfaceMap(featureId) {
    if (!Object.hasOwn(interfaceMapData, featureId)) return false;
    const record = interfaceMapData[featureId];
    const imagePath = captureAssetHref(record);
    const articleHref = featureFragmentHref(record?.id);
    const focus = record?.focus;
    if (!imagePath || !articleHref || typeof record.label !== "string" || typeof record.summary !== "string" ||
        typeof record.section !== "string" || !Array.isArray(record.steps) || !Array.isArray(focus) ||
        focus.length !== 4 || !focus.every(Number.isFinite) || !Number.isFinite(record.capture?.width) ||
        !Number.isFinite(record.capture?.height)) return false;
    if (interfaceMapImage) {
      interfaceMapImage.setAttribute("src", imagePath);
      interfaceMapImage.width = record.capture.width;
      interfaceMapImage.height = record.capture.height;
      interfaceMapImage.alt = `ShellX Motion Workbench showing ${record.label}`;
    }
    if (highlight) {
      const [left, top, width, height] = focus;
      highlight.hidden = false;
      highlightFrame?.setAttribute("x", String(left));
      highlightFrame?.setAttribute("y", String(top));
      highlightFrame?.setAttribute("width", String(width));
      highlightFrame?.setAttribute("height", String(height));
    }
    if (surfaceLink) {
      surfaceLink.setAttribute("href", imagePath);
      surfaceLink.setAttribute("aria-label", `Open the full Workbench capture for ${record.label}`);
    }
    if (detailTitle) detailTitle.textContent = record.label;
    if (detailDescription) detailDescription.textContent = record.summary;
    if (detailView) detailView.textContent = record.capture.label;
    if (detailSection) detailSection.textContent = record.section;
    if (detailId) detailId.textContent = record.id;
    if (detailSteps) {
      detailSteps.replaceChildren(...record.steps.map((step) => {
        const item = document.createElement("li");
        item.textContent = step;
        return item;
      }));
      detailSteps.hidden = record.steps.length === 0;
    }
    if (detailNote && detailNoteText) {
      detailNoteText.textContent = record.note || "";
      detailNote.hidden = !record.note;
    }
    if (detailOpenImage) detailOpenImage.setAttribute("href", imagePath);
    if (detailArticleLink) detailArticleLink.setAttribute("href", articleHref);
    if (interfaceMap) interfaceMap.dataset.selectedFeature = featureId;
    return true;
  }

  function recordUrl(featureId) {
    const url = new URL(window.location.href);
    url.searchParams.set("feature", featureId);
    url.hash = featureId;
    return url;
  }

  function selectFeature(featureId, options = {}) {
    const target = featuresById.get(featureId);
    if (!target) return false;
    const mapped = updateInterfaceMap(featureId);
    for (const feature of features) feature.classList.toggle("highlighted", feature === target);
    for (const link of links) {
      const selected = link.dataset.featureLink === featureId;
      link.classList.toggle("active", selected);
      if (selected) link.setAttribute("aria-current", "location");
      else link.removeAttribute("aria-current");
    }
    if (options.updateUrl !== false) {
      const url = recordUrl(featureId);
      if (options.replaceUrl) window.history.replaceState({}, "", url);
      else window.history.pushState({}, "", url);
    }
    if (window.matchMedia("(max-width: 720px)").matches) setNavOpen(false);
    if (options.scroll !== false) {
      target.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
    }
    if (options.focus) {
      target.tabIndex = -1;
      target.focus({ preventScroll: true });
    }
    return mapped || true;
  }

  for (const link of links) {
    link.addEventListener("click", () => selectFeature(link.dataset.featureLink));
  }

  function scoreFeature(feature, tokens, query) {
    const id = (feature.dataset.featureId || "").toLowerCase();
    const title = (feature.querySelector("h3")?.textContent || "").toLowerCase();
    const text = feature.dataset.searchText || "";
    if (!tokens.every((token) => text.includes(token))) return -1;
    let score = 0;
    if (id === query || title === query) score += 100;
    if (id.startsWith(query) || title.startsWith(query)) score += 45;
    for (const token of tokens) {
      if (id.startsWith(token)) score += 20;
      else if (id.includes(token)) score += 12;
      if (title.startsWith(token)) score += 10;
      else if (title.includes(token)) score += 6;
    }
    return score;
  }

  function renderResults() {
    if (!results) return;
    results.replaceChildren(...ranked.map((item, index) => {
      const li = document.createElement("li");
      const button = document.createElement("button");
      const label = item.querySelector("h3")?.textContent || item.dataset.featureId || "Record";
      const recordId = item.dataset.featureId || "";
      button.type = "button";
      button.id = `manual-result-${index}`;
      button.setAttribute("role", "option");
      button.dataset.searchResult = recordId;
      button.setAttribute("aria-selected", String(index === activeResult));
      if (index === activeResult) button.classList.add("is-active");
      const title = document.createElement("strong");
      title.textContent = label;
      const subline = document.createElement("span");
      subline.textContent = recordId;
      button.append(title, subline);
      button.addEventListener("click", () => selectFeature(recordId, { focus: true }));
      li.append(button);
      return li;
    }));
    results.hidden = ranked.length === 0;
    search?.setAttribute("aria-expanded", String(ranked.length > 0));
    if (search) {
      if (activeResult >= 0 && ranked[activeResult]) search.setAttribute("aria-activedescendant", `manual-result-${activeResult}`);
      else search.removeAttribute("aria-activedescendant");
    }
  }

  function applySearch() {
    const query = (search?.value || "").trim().toLowerCase();
    const tokens = query.split(/\s+/).filter(Boolean);
    const matches = [];
    for (const feature of features) {
      const score = tokens.length === 0 ? 0 : scoreFeature(feature, tokens, query);
      const match = tokens.length === 0 || score >= 0;
      feature.hidden = !match;
      if (match && tokens.length) matches.push({ feature, score });
    }
    for (const link of links) {
      const target = featuresById.get(link.dataset.featureLink);
      link.hidden = Boolean(tokens.length && target?.hidden);
    }
    for (const section of sections) {
      section.hidden = !Array.from(section.querySelectorAll("[data-feature-id]")).some((feature) => !feature.hidden);
    }
    for (const folder of folders) {
      const hasVisible = Array.from(folder.querySelectorAll("[data-feature-link]")).some((link) => !link.hidden);
      folder.hidden = Boolean(tokens.length) && !hasVisible;
      if (tokens.length && hasVisible) folder.open = true;
    }
    ranked = matches.sort((a, b) => b.score - a.score || (a.feature.dataset.featureId || "").localeCompare(b.feature.dataset.featureId || "")).slice(0, 8).map((item) => item.feature);
    activeResult = ranked.length ? 0 : -1;
    renderResults();
    if (status) {
      status.textContent = tokens.length ? `${matches.length} matching record${matches.length === 1 ? "" : "s"}; use ↓ and Enter.` : "Press / or Ctrl+K to focus search.";
    }
    if (empty) empty.hidden = tokens.length === 0 || matches.length !== 0;
  }

  search?.addEventListener("input", applySearch);
  search?.addEventListener("keydown", (event) => {
    if (!ranked.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      activeResult = (activeResult + 1) % ranked.length;
      renderResults();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      activeResult = (activeResult - 1 + ranked.length) % ranked.length;
      renderResults();
    } else if (event.key === "Enter" && activeResult >= 0) {
      event.preventDefault();
      selectFeature(ranked[activeResult].dataset.featureId, { focus: true });
    } else if (event.key === "Escape") {
      event.preventDefault();
      search.value = "";
      applySearch();
    }
  });

  document.addEventListener("keydown", (event) => {
    const target = event.target;
    const editable = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable;
    if ((event.key === "/" && !editable) || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k")) {
      event.preventDefault();
      search?.focus();
    }
  });

  for (const button of copyButtons) {
    button.addEventListener("click", async () => {
      const featureId = button.dataset.copyPermalink;
      if (!featureId) return;
      const original = "Copy link";
      try {
        if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
        await navigator.clipboard.writeText(recordUrl(featureId).href);
        button.textContent = "Copied";
        button.dataset.copyState = "copied";
        button.setAttribute("aria-label", "Link copied");
      } catch {
        button.textContent = "Copy unavailable";
        button.dataset.copyState = "unavailable";
        button.setAttribute("aria-label", "Clipboard access is unavailable in this context");
      }
      window.setTimeout(() => {
        button.textContent = original;
        delete button.dataset.copyState;
        button.setAttribute("aria-label", `Copy a link to ${featureId}`);
      }, 2200);
    });
  }

  window.addEventListener("hashchange", () => {
    const requested = decodeURIComponent(window.location.hash.slice(1));
    if (featuresById.has(requested)) selectFeature(requested, { updateUrl: false, scroll: false });
  });
  window.addEventListener("popstate", () => {
    const requested = new URL(window.location.href).searchParams.get("feature") || window.location.hash.slice(1);
    if (featuresById.has(requested)) selectFeature(requested, { updateUrl: false, scroll: false });
  });

  const requested = new URL(window.location.href).searchParams.get("feature") || decodeURIComponent(window.location.hash.slice(1));
  if (requested && featuresById.has(requested)) {
    window.requestAnimationFrame(() => selectFeature(requested, { updateUrl: false, replaceUrl: true }));
  } else {
    const firstMapped = interfaceMap?.dataset.defaultFeature || features.map((feature) => feature.dataset.featureId).find((id) => id && Object.hasOwn(interfaceMapData, id));
    if (firstMapped) selectFeature(firstMapped, { updateUrl: false, scroll: false });
  }
  applySearch();
})();
