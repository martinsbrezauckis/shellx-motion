/**
 * Native block-glyph font table and text-coverage classification for the ShellX Motion native lane.
 *
 * Role: owns the entire "font" the native rasterizer has — a fixed 5x7 bitmap per character covering
 * uppercase A-Z, 0-9 and 20 ASCII punctuation marks — plus the classifiers that say, for a given
 * string, which characters the lane can draw faithfully, which it silently case-folds, and which it
 * can only approximate with a codepoint-derived fallback box. Extracted from `index.ts` (the text-delivery invariant,
 * and the module-size gate) so both the rasterizer and the delivery gate read one source of truth.
 *
 * There is no font rasterizer in this package by design: the native lane is the fast, dependency-free
 * preview/CI lane. Anything this table cannot draw is reported, never silently substituted — the
 * capability gate refuses non-ASCII text outright (`text.charset.non-ascii`, declared in
 * `@shellx-motion/core`), preview renders warn per layer, and delivery renders refuse (see
 * `./text-delivery-gate`).
 *
 * Dependencies: none (pure data + pure functions).
 *
 * Primary callers: `./index.ts` (drawing + preview warnings) and `./text-delivery-gate.ts`.
 */

const GLYPHS: Record<string, string[]> = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01111", "10000", "10000", "10011", "10001", "10001", "01111"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  J: ["00111", "00010", "00010", "00010", "10010", "10010", "01100"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "10000", "11110", "00001", "00001", "11110"],
  "6": ["01110", "10000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00001", "01110"],
  ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
  ",": ["00000", "00000", "00000", "00000", "01100", "01100", "01000"],
  ":": ["00000", "01100", "01100", "00000", "01100", "01100", "00000"],
  ";": ["00000", "01100", "01100", "00000", "01100", "01100", "01000"],
  "!": ["00100", "00100", "00100", "00100", "00100", "00000", "00100"],
  "?": ["01110", "10001", "00001", "00010", "00100", "00000", "00100"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  "_": ["00000", "00000", "00000", "00000", "00000", "00000", "11111"],
  "+": ["00000", "00100", "00100", "11111", "00100", "00100", "00000"],
  "/": ["00001", "00010", "00010", "00100", "01000", "01000", "10000"],
  "\\": ["10000", "01000", "01000", "00100", "00010", "00010", "00001"],
  "'": ["00100", "00100", "01000", "00000", "00000", "00000", "00000"],
  "\"": ["01010", "01010", "01010", "00000", "00000", "00000", "00000"],
  "(": ["00010", "00100", "01000", "01000", "01000", "00100", "00010"],
  ")": ["01000", "00100", "00010", "00010", "00010", "00100", "01000"],
  "[": ["01110", "01000", "01000", "01000", "01000", "01000", "01110"],
  "]": ["01110", "00010", "00010", "00010", "00010", "00010", "01110"],
  "#": ["01010", "01010", "11111", "01010", "11111", "01010", "01010"],
  "%": ["11001", "11010", "00010", "00100", "01000", "01011", "10011"],
  "&": ["01100", "10010", "10100", "01000", "10101", "10010", "01101"]
};

/** Characters the layout treats as whitespace rather than as glyphs to draw. */
export function isTextLayoutWhitespace(char: string): boolean {
  return char === " " || char === "\n" || char === "\r" || char === "\t";
}

/**
 * Whether `char` has a real bitmap in the table, either directly or via the uppercase fold the
 * renderer applies. `true` does NOT mean the character renders faithfully — see
 * {@link caseFoldedCharacters} for the lowercase case.
 */
export function hasNativeGlyph(char: string): boolean {
  return GLYPHS[char] !== undefined || GLYPHS[char.toUpperCase()] !== undefined;
}

/**
 * The 5x7 rows the rasterizer draws for `char`.
 *
 * Falls back to a boxed pattern whose interior bits are derived from the codepoint when no bitmap
 * exists. That fallback is deterministic noise, never legible text, which is why every caller path
 * either warns ({@link fallbackGlyphCharacters}) or refuses before it can reach a deliverable.
 */
export function glyphRows(char: string): string[] {
  const known = GLYPHS[char] ?? GLYPHS[char.toUpperCase()];
  if (known) return known;

  const code = char.codePointAt(0) ?? 0;
  return Array.from({ length: 7 }, (_, row) =>
    Array.from({ length: 5 }, (_, col) => {
      if (row === 0 || row === 6 || col === 0 || col === 4) return "1";
      return (code >> ((row + col) % 8)) & 1 ? "1" : "0";
    }).join("")
  );
}

/**
 * Distinct characters in `text` that have no bitmap at all and would therefore be drawn as the
 * codepoint-derived fallback box.
 *
 * @param text Raw layer text.
 * @returns Unique offending characters in first-seen order (empty when every character is drawable).
 */
export function fallbackGlyphCharacters(text: string): string[] {
  const unsupported = new Set<string>();
  for (const char of text) {
    if (isTextLayoutWhitespace(char)) continue;
    if (!hasNativeGlyph(char)) unsupported.add(char);
  }
  return [...unsupported];
}

/**
 * Distinct characters in `text` that the rasterizer draws only after folding them to uppercase.
 *
 * These are the silently-transformed characters the regression flagged: "Sveiks" renders "SVEIKS" with no
 * signal at all before this existed. Reported so preview renders can warn and delivery renders can
 * refuse.
 *
 * @param text Raw layer text.
 * @returns Unique case-folded characters in first-seen order (empty when nothing is folded).
 */
export function caseFoldedCharacters(text: string): string[] {
  const folded = new Set<string>();
  for (const char of text) {
    if (isTextLayoutWhitespace(char)) continue;
    const upper = char.toUpperCase();
    if (upper !== char && GLYPHS[char] === undefined && GLYPHS[upper] !== undefined) folded.add(char);
  }
  return [...folded];
}

/** The exact character repertoire the native lane can draw, sorted; used by coverage regression tests. */
export function nativeGlyphRepertoire(): string[] {
  return Object.keys(GLYPHS).sort();
}
