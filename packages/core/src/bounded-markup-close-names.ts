/** Exact closing-tag index for the attributed markup scanner. */

function isWordCode(code: number): boolean {
  return (code >= 0x30 && code <= 0x39)
    || (code >= 0x41 && code <= 0x5a)
    || (code >= 0x61 && code <= 0x7a)
    || code === 0x5f;
}

/** `[\w:-]` — the characters a tag name may continue with in the pattern this replaces. */
export function isTagNameRestCode(code: number): boolean {
  return isWordCode(code) || code === 0x3a || code === 0x2d;
}

/** `[A-Za-z]` — the characters a tag name may start with. */
export function isAsciiLetterCode(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

/** `\b` between `text[at - 1]` and `text[at]`, with out-of-range treated as a non-word char. */
export function isWordBoundaryAt(text: string, at: number): boolean {
  const before = at > 0 && isWordCode(text.charCodeAt(at - 1));
  const after = at < text.length && isWordCode(text.charCodeAt(at));
  return before !== after;
}

/** A radix edge refers to the already-lowercased document; it never copies a name prefix. */
interface CloseNameEdge {
  start: number;
  end: number;
  next: CloseNameNode;
}

interface CloseNameNode {
  edges: Map<number, CloseNameEdge>;
  /** Document-order starts of exact `</name>` tokens. */
  starts: number[];
}

function closeNameNode(): CloseNameNode {
  return { edges: new Map(), starts: [] };
}

/** Index exact close names in linear input space, sharing common prefixes without copying them. */
export function indexCloseNames(lower: string): CloseNameNode {
  const root = closeNameNode();
  let cursor = 0;
  while (cursor < lower.length) {
    const closeStart = lower.indexOf("</", cursor);
    if (closeStart < 0) break;
    const nameStart = closeStart + 2;
    cursor = nameStart;
    if (!isAsciiLetterCode(lower.charCodeAt(nameStart))) continue;
    let nameEnd = nameStart + 1;
    while (nameEnd < lower.length && isTagNameRestCode(lower.charCodeAt(nameEnd))) nameEnd += 1;
    if (lower.charCodeAt(nameEnd) !== 0x3e) continue;
    cursor = nameEnd + 1;

    let node = root;
    let at = nameStart;
    while (at < nameEnd) {
      const code = lower.charCodeAt(at);
      const edge = node.edges.get(code);
      if (!edge) {
        const next = closeNameNode();
        node.edges.set(code, { start: at, end: nameEnd, next });
        node = next;
        at = nameEnd;
        break;
      }
      let shared = 0;
      while (at + shared < nameEnd && edge.start + shared < edge.end
        && lower.charCodeAt(at + shared) === lower.charCodeAt(edge.start + shared)) shared += 1;
      at += shared;
      if (edge.start + shared === edge.end) {
        node = edge.next;
        continue;
      }
      const branch = closeNameNode();
      node.edges.set(code, { start: edge.start, end: edge.start + shared, next: branch });
      branch.edges.set(lower.charCodeAt(edge.start + shared), {
        start: edge.start + shared, end: edge.end, next: edge.next
      });
      if (at < nameEnd) {
        const next = closeNameNode();
        branch.edges.set(lower.charCodeAt(at), { start: at, end: nameEnd, next });
        node = next;
      } else {
        node = branch;
      }
      at = nameEnd;
    }
    node.starts.push(closeStart);
  }
  return root;
}

/** Exact close names that prefix this opening name, in greedy longest-first order. */
export function closeNamePrefixes(
  lower: string, text: string, root: CloseNameNode, nameStart: number, runEnd: number
): Array<{ end: number; starts: readonly number[] }> {
  const prefixes: Array<{ end: number; starts: readonly number[] }> = [];
  let node = root;
  let at = nameStart;
  while (at < runEnd) {
    const edge = node.edges.get(lower.charCodeAt(at));
    if (!edge) break;
    for (let source = edge.start; source < edge.end; source += 1, at += 1) {
      if (at >= runEnd || lower.charCodeAt(at) !== lower.charCodeAt(source)) return prefixes.reverse();
    }
    node = edge.next;
    if (node.starts.length > 0 && isWordBoundaryAt(text, at)) {
      prefixes.push({ end: at, starts: node.starts });
    }
  }
  return prefixes.reverse();
}

/** First exact closer after an opening tag's `>`. */
export function firstCloseAfter(starts: readonly number[], tagEnd: number): number {
  let low = 0;
  let high = starts.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (starts[mid]! <= tagEnd) low = mid + 1;
    else high = mid;
  }
  return starts[low] ?? -1;
}
