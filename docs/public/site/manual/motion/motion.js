(() => {
  "use strict";

  const sections = [...document.querySelectorAll(".manual-section")];
  const controls = [...document.querySelectorAll("[data-section-target]")];
  const navControls = [...document.querySelectorAll("[data-section-nav] [data-section-target]")];
  const search = document.querySelector("[data-manual-search]");
  const empty = document.querySelector("[data-empty-search]");
  const byId = new Map(sections.map((section) => [section.id, section]));

  function selectSection(id, scroll = true) {
    const section = byId.get(id);
    if (!section || section.hidden) return;
    for (const button of navControls) {
      if (button.dataset.sectionTarget === id) button.setAttribute("aria-current", "true");
      else button.removeAttribute("aria-current");
    }
    if (scroll) section.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  for (const control of controls) {
    control.addEventListener("click", () => selectSection(control.dataset.sectionTarget));
  }

  search?.addEventListener("input", () => {
    const query = search.value.trim().toLowerCase();
    let visible = 0;
    for (const section of sections) {
      const searchable = `${section.textContent || ""} ${section.dataset.search || ""}`.toLowerCase();
      section.hidden = Boolean(query) && !searchable.includes(query);
      if (!section.hidden) visible += 1;
    }
    for (const button of navControls) {
      button.hidden = Boolean(byId.get(button.dataset.sectionTarget)?.hidden);
    }
    if (empty) empty.hidden = visible !== 0;
    const first = sections.find((section) => !section.hidden);
    if (first) selectSection(first.id, false);
  });

  const initial = decodeURIComponent(window.location.hash.slice(1));
  selectSection(byId.has(initial) ? initial : "overview", false);

  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (visible?.target?.id) selectSection(visible.target.id, false);
    }, { rootMargin: "-15% 0px -70%", threshold: [0.05, 0.2, 0.5] });
    for (const section of sections) observer.observe(section);
  }
})();
