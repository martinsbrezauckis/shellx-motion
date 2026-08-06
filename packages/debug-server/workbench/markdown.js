/**
 * markdown.js — a small, strict, dependency-free Markdown → HTML renderer for the
 * ShellX Motion engine-room docs reader.
 *
 * Why hand-written: the workbench ships as static files with a strict
 * `default-src 'none'; script-src 'self'` CSP and no build step, so pulling in an
 * external Markdown library is neither possible nor desirable. This renderer
 * covers exactly the subset the bundled docs use — headings, paragraphs,
 * bold/italic/inline-code, fenced code blocks, unordered/ordered lists, links,
 * and GitHub-style pipe tables — and nothing else.
 *
 * Security model (the load-bearing property, exercised by markdown.test.ts):
 *   1. EVERY character of the source is HTML-escaped BEFORE any structural tag is
 *      emitted, so a `<script>` (or any other tag) in the source renders as inert
 *      text, never as live markup.
 *   2. The renderer only ever emits a fixed whitelist of structural tags; it never
 *      copies source bytes into an attribute or tag position unescaped.
 *   3. Links accept only `http://`, `https://`, and same-document `#anchor` hrefs;
 *      any other scheme (e.g. `javascript:`) is dropped and the link text is shown
 *      as plain escaped text. Emitted links always carry
 *      `target="_blank" rel="noopener noreferrer"`.
 * The returned string is therefore safe to assign via `innerHTML` — that is the
 * contract this module exists to guarantee.
 *
 * Source-hygiene note: this file is pure ASCII text and contains NO NUL or other
 * non-printable bytes (enforced by scripts/no-nul-bytes.mjs). The inline-parser's
 * placeholder delimiter is a Unicode Private-Use code point (U+E000) written as an
 * ASCII escape (`PLACEHOLDER`), so it only ever exists as a runtime string value —
 * never as a raw byte in this source — keeping the file auditable by file(1)/rg and
 * safe for formatters, minifiers, scanners, and source maps.
 *
 * Dependencies: none (ES module, browser + Node compatible).
 * Primary callers: docs.js (DOM rendering), markdown.test.ts (unit tests).
 */

/**
 * Inline-parser placeholder delimiter: a single Unicode Private-Use Area code point
 * (U+E000). It is collision-resistant for wrapping `CODE{n}`/`LINK{n}` tokens
 * because it survives escapeHtml (it is not one of & < > " '), is untouched by
 * applyEmphasis (it is not `*` or `_`), never matches the code/link source regexes,
 * and does not occur in Markdown documents. Written as an escape so the source file
 * stays pure ASCII (the previous implementation used a raw NUL byte, which made the
 * file read as binary `data` to file(1) or rg).
 */
const PLACEHOLDER = "\uE000";

/**
 * HTML-escape a raw source string so it can never introduce markup. Applied to
 * all text before any structural tag is emitted. Quotes are escaped too so the
 * same helper is safe for attribute values.
 *
 * @param {string} value Raw source text.
 * @returns {string} Escaped text safe for element or attribute context.
 */
export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Decide whether a link href is allowed. Only absolute http(s) URLs and
 * same-document `#fragment` anchors pass; everything else (javascript:, data:,
 * vbscript:, protocol-relative //host, mailto:, etc.) is rejected so the caller
 * renders the link as plain text instead of a live, potentially dangerous href.
 *
 * @param {string} href Raw href text from the source.
 * @returns {boolean} True when the href is a safe http(s) or anchor target.
 */
export function isSafeHref(href) {
  const trimmed = String(href).trim();
  if (trimmed.startsWith("#")) return true;
  // Reject protocol-relative (//evil) and control chars that could smuggle a scheme.
  if (/^\/\//.test(trimmed)) return false;
  if (/[\u0000-\u001f]/.test(trimmed)) return false;
  return /^https?:\/\//i.test(trimmed);
}

/**
 * Apply inline formatting to a single already-plain (unescaped) source string and
 * return safe HTML. Order matters: inline code spans are extracted first and
 * carried as opaque placeholders so their contents are never re-interpreted as
 * bold/italic/links; the remaining text is escaped, then emphasis and links are
 * applied over the escaped text.
 *
 * @param {string} source Raw inline source (one paragraph/line's worth).
 * @returns {string} Safe inline HTML.
 */
export function renderInline(source) {
  // Strip any stray PLACEHOLDER sentinel from the source up front so it cannot be
  // used to forge a token boundary; the parser then owns every sentinel occurrence.
  const text = String(source).split(PLACEHOLDER).join("");
  const codeSpans = [];
  // 1. Pull out `code` spans as placeholders (protect them from further parsing).
  //    The placeholder wraps an index in the collision-resistant PLACEHOLDER sentinel.
  const withoutCode = text.replace(/`([^`]+)`/g, (_match, code) => {
    const token = `${PLACEHOLDER}CODE${codeSpans.length}${PLACEHOLDER}`;
    codeSpans.push(`<code>${escapeHtml(code)}</code>`);
    return token;
  });

  // 2. Pull out links [text](href) as placeholders BEFORE escaping, so we can
  //    validate the raw href. The link text is rendered through renderInline-lite
  //    (escape + emphasis) but never re-parsed for nested links.
  const linkSpans = [];
  const withoutLinks = withoutCode.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (match, label, href) => {
    if (!isSafeHref(href)) {
      // Disallowed scheme: keep the ORIGINAL literal text, escaped, no live href.
      const token = `${PLACEHOLDER}LINK${linkSpans.length}${PLACEHOLDER}`;
      linkSpans.push(escapeHtml(match));
      return token;
    }
    const token = `${PLACEHOLDER}LINK${linkSpans.length}${PLACEHOLDER}`;
    const safeHref = escapeHtml(href.trim());
    const safeLabel = applyEmphasis(escapeHtml(label));
    linkSpans.push(`<a href="${safeHref}" target="_blank" rel="noopener noreferrer">${safeLabel}</a>`);
    return token;
  });

  // 3. Escape the remaining text, then apply emphasis over the escaped text.
  let html = applyEmphasis(escapeHtml(withoutLinks));

  // 4. Restore link and code placeholders (their HTML is already safe). The regexes
  //    match the PLACEHOLDER (U+E000) sentinel written as an escape.
  html = html.replace(/\uE000LINK(\d+)\uE000/g, (_m, index) => linkSpans[Number(index)] ?? "");
  html = html.replace(/\uE000CODE(\d+)\uE000/g, (_m, index) => codeSpans[Number(index)] ?? "");
  return html;
}

/**
 * Apply bold and italic emphasis to already-escaped text. Bold (`**` or `__`)
 * is applied before italic (`*` or `_`) so `**bold**` is not mis-parsed as two
 * italics. Operates purely on escaped text, emitting only `<strong>`/`<em>`.
 *
 * @param {string} escaped Already HTML-escaped text.
 * @returns {string} Text with emphasis tags applied.
 */
function applyEmphasis(escaped) {
  return escaped
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, "$1<em>$2</em>")
    .replace(/(^|[^_\w])_([^_\s][^_]*?)_/g, "$1<em>$2</em>");
}

/**
 * Render a full Markdown document to safe HTML. Block-level parsing is line
 * oriented; fenced code blocks and tables consume multiple lines. Unknown or
 * unsupported constructs degrade to escaped paragraph text (never dropped, never
 * executed).
 *
 * @param {string} source Markdown source text.
 * @returns {string} Safe HTML string suitable for innerHTML assignment.
 */
export function renderMarkdown(source) {
  const lines = String(source ?? "").replace(/\r\n?/g, "\n").split("\n");
  const html = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    // Blank line: separates blocks.
    if (line.trim() === "") {
      index += 1;
      continue;
    }

    // Fenced code block: ``` ... ``` (contents are escaped verbatim, no inline).
    const fence = /^\s*```(.*)$/.exec(line);
    if (fence) {
      const lang = fence[1].trim();
      const codeLines = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }
      index += 1; // consume closing fence (if present)
      const langClass = /^[a-z0-9+#-]+$/i.test(lang) ? ` class="language-${escapeHtml(lang)}"` : "";
      html.push(`<pre><code${langClass}>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
      continue;
    }

    // Heading: # .. ######
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      html.push(`<h${level}>${renderInline(heading[2].trim())}</h${level}>`);
      index += 1;
      continue;
    }

    // Horizontal rule.
    if (/^\s*(?:---|\*\*\*|___)\s*$/.test(line)) {
      html.push("<hr>");
      index += 1;
      continue;
    }

    // Table: a header row followed by a divider row of ---|--- cells.
    if (line.includes("|") && index + 1 < lines.length && isTableDivider(lines[index + 1])) {
      const consumed = renderTable(lines, index);
      html.push(consumed.html);
      index = consumed.nextIndex;
      continue;
    }

    // Unordered list.
    if (/^\s*[-*+]\s+/.test(line)) {
      const consumed = renderList(lines, index, "ul");
      html.push(consumed.html);
      index = consumed.nextIndex;
      continue;
    }

    // Ordered list.
    if (/^\s*\d+\.\s+/.test(line)) {
      const consumed = renderList(lines, index, "ol");
      html.push(consumed.html);
      index = consumed.nextIndex;
      continue;
    }

    // Blockquote.
    if (/^\s*>\s?/.test(line)) {
      const quoteLines = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      html.push(`<blockquote>${renderInline(quoteLines.join(" "))}</blockquote>`);
      continue;
    }

    // Paragraph: gather consecutive non-blank, non-block lines.
    const paragraph = [];
    while (
      index < lines.length &&
      lines[index].trim() !== "" &&
      !/^\s*```/.test(lines[index]) &&
      !/^(#{1,6})\s+/.test(lines[index]) &&
      !/^\s*[-*+]\s+/.test(lines[index]) &&
      !/^\s*\d+\.\s+/.test(lines[index]) &&
      !/^\s*>\s?/.test(lines[index])
    ) {
      paragraph.push(lines[index]);
      index += 1;
    }
    if (paragraph.length > 0) {
      html.push(`<p>${renderInline(paragraph.join(" "))}</p>`);
    }
  }

  return html.join("\n");
}

/**
 * Whether a line is a Markdown table divider row (e.g. `--- | :--: | ---`).
 * @param {string} line Candidate divider line.
 * @returns {boolean} True when the line is a valid table divider.
 */
function isTableDivider(line) {
  return /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/.test(line);
}

/**
 * Split a table row into trimmed cell strings, tolerating optional leading and
 * trailing pipes.
 * @param {string} line Table row source.
 * @returns {string[]} Cell source strings.
 */
function splitTableRow(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

/**
 * Render a pipe table starting at `start` (header row; `start + 1` is the
 * divider). Consumes rows until a blank or non-table line.
 *
 * @param {string[]} lines All document lines.
 * @param {number} start Index of the header row.
 * @returns {{ html: string, nextIndex: number }} Rendered table and next index.
 */
function renderTable(lines, start) {
  const header = splitTableRow(lines[start]);
  let index = start + 2; // skip header + divider
  const bodyRows = [];
  while (index < lines.length && lines[index].trim() !== "" && lines[index].includes("|")) {
    bodyRows.push(splitTableRow(lines[index]));
    index += 1;
  }
  const head = `<thead><tr>${header.map((cell) => `<th>${renderInline(cell)}</th>`).join("")}</tr></thead>`;
  const body = bodyRows
    .map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join("")}</tr>`)
    .join("");
  return { html: `<table>${head}<tbody>${body}</tbody></table>`, nextIndex: index };
}

/**
 * Render a contiguous run of list items into a `<ul>` or `<ol>`.
 *
 * @param {string[]} lines All document lines.
 * @param {number} start Index of the first list item.
 * @param {"ul"|"ol"} tag List element to emit.
 * @returns {{ html: string, nextIndex: number }} Rendered list and next index.
 */
function renderList(lines, start, tag) {
  const marker = tag === "ul" ? /^\s*[-*+]\s+(.*)$/ : /^\s*\d+\.\s+(.*)$/;
  const items = [];
  let index = start;
  while (index < lines.length) {
    const match = marker.exec(lines[index]);
    if (!match) break;
    items.push(`<li>${renderInline(match[1].trim())}</li>`);
    index += 1;
  }
  return { html: `<${tag}>${items.join("")}</${tag}>`, nextIndex: index };
}
