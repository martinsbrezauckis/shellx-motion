/** Session-only binding for the opaque approved-agent-entry authority. */
import {
  APPROVED_AGENT_SCRIPT_MODE,
  AgentScriptProvenanceRefusal,
  activeScriptLayers,
  agentScriptExecutionEvidenceForDataOnly,
  type AgentScriptProvenanceAuthority,
  type AgentScriptExecutionEvidence,
  type MotionPackage,
  type ResolvedAgentScriptPackage,
} from "@shellx-motion/core";

export function bindApprovedAgentScriptEntry(
  evidence: AgentScriptExecutionEvidence,
  source: unknown
): AgentScriptExecutionEvidence {
  if (evidence.activeMode !== APPROVED_AGENT_SCRIPT_MODE) return evidence;
  const entry = typeof source === "string" ? evidence.sources.find((candidate) => candidate.path === source) : undefined;
  if (!entry) throw new AgentScriptProvenanceRefusal("Approved-agent-entry render source is absent from the attested source evidence.");
  return { ...evidence, entry };
}

/**
 * Document-start defense in depth for the route-level one-entry policy. The route
 * remains authoritative because `location.href = …` cannot be safely redefined.
 */
export function approvedAgentEntryInitGuard(entryUrl: string): string {
  return String.raw`(() => {
  const refuse = () => { throw new DOMException("Secondary executable content is disabled for approved-agent-entry scripts.", "SecurityError"); };
  const blockedTags = new Set(["script", "iframe", "frame", "object", "embed"]);
  const blockedMarkup = (value) => /<\s*\/?\s*(?:script|iframe|frame|object|embed)\b/i.test(String(value));
  const containsBlockedNode = (node) => {
    if (!node || typeof node !== "object") return false;
    const tagName = typeof node.tagName === "string" ? node.tagName.toLowerCase() : "";
    if (blockedTags.has(tagName)) return true;
    try { return typeof node.querySelector === "function" && Boolean(node.querySelector("script,iframe,frame,object,embed")); } catch { return true; }
  };
  const guardFactory = (prototype, name, tagArgument) => {
    const original = prototype[name];
    if (typeof original !== "function") return;
    Object.defineProperty(prototype, name, {
      value: function(...args) {
        const tagName = args[tagArgument];
        if (typeof tagName === "string" && blockedTags.has(tagName.toLowerCase())) return refuse();
        return Reflect.apply(original, this, args);
      }, configurable: false, writable: false
    });
  };
  guardFactory(Document.prototype, "createElement", 0);
  guardFactory(Document.prototype, "createElementNS", 1);
  const guardNodeInsertion = (prototype, name, argumentIndexes) => {
    const original = prototype[name];
    if (typeof original !== "function") return;
    Object.defineProperty(prototype, name, {
      value: function(...args) {
        const candidates = argumentIndexes ? argumentIndexes.map((index) => args[index]) : args;
        if (candidates.some(containsBlockedNode)) return refuse();
        return Reflect.apply(original, this, args);
      }, configurable: false, writable: false
    });
  };
  for (const name of ["appendChild", "insertBefore", "replaceChild"]) guardNodeInsertion(Node.prototype, name, [0]);
  for (const prototype of [Element.prototype, Document.prototype, DocumentFragment.prototype]) {
    for (const name of ["append", "prepend", "before", "after", "replaceWith", "replaceChildren"]) {
      guardNodeInsertion(prototype, name);
    }
  }
  const guardMarkupSetter = (prototype, name) => {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    if (!descriptor?.set) return;
    Object.defineProperty(prototype, name, {
      get: descriptor.get,
      set(value) { if (blockedMarkup(value)) return refuse(); return Reflect.apply(descriptor.set, this, [value]); },
      configurable: false
    });
  };
  for (const prototype of [Element.prototype, ShadowRoot.prototype]) {
    for (const name of ["innerHTML", "outerHTML"]) guardMarkupSetter(prototype, name);
  }
  const guardMarkupMethod = (prototype, name, valueIndex) => {
    const original = prototype[name];
    if (typeof original !== "function") return;
    Object.defineProperty(prototype, name, {
      value: function(...args) { if (blockedMarkup(args[valueIndex])) return refuse(); return Reflect.apply(original, this, args); },
      configurable: false, writable: false
    });
  };
  guardMarkupMethod(Element.prototype, "insertAdjacentHTML", 1);
  guardMarkupMethod(Range.prototype, "createContextualFragment", 0);
  for (const name of ["write", "writeln", "open", "close"]) {
    try { Object.defineProperty(Document.prototype, name, { value: refuse, configurable: false, writable: false }); } catch { refuse(); }
  }
  const guardTimer = (name) => {
    const original = globalThis[name];
    if (typeof original !== "function") return;
    Object.defineProperty(globalThis, name, {
      value: function(callback, ...args) { if (typeof callback !== "function") return refuse(); return Reflect.apply(original, this, [callback, ...args]); },
      configurable: false, writable: false
    });
  };
  guardTimer("setTimeout");
  guardTimer("setInterval");
  // CSP installed by the authoring boundary blocks eval, Function, and WebAssembly compilation.
  // Do not replace eval/Function here: Chromium DevTools uses them to perform host-owned
  // page.evaluate calls after navigation. The document guard owns construction/loading instead.
  for (const name of ["Worker", "SharedWorker", "importScripts", "DOMParser"]) {
    try { Object.defineProperty(globalThis, name, { value: refuse, configurable: false, writable: false }); } catch { refuse(); }
  }
  const replace = (prototype, name) => {
    try { Object.defineProperty(prototype, name, { value: refuse, configurable: false, writable: false }); } catch { /* route policy remains authoritative */ }
  };
  replace(Location.prototype, "assign");
  replace(Location.prototype, "replace");
  replace(History.prototype, "back");
  replace(History.prototype, "forward");
  replace(History.prototype, "go");
  for (const name of ["pushState", "replaceState"]) replace(History.prototype, name);
  for (const name of ["submit", "requestSubmit"]) replace(HTMLFormElement.prototype, name);
  const expectedEntry = ${JSON.stringify(entryUrl)};
  const removeMetaRefresh = () => document.querySelectorAll("meta[http-equiv]").forEach((meta) => {
    if (expectedEntry && meta.getAttribute("http-equiv")?.trim().toLowerCase() === "refresh") meta.remove();
  });
  removeMetaRefresh();
  new MutationObserver(removeMetaRefresh).observe(document, { childList: true, subtree: true });
})()`;
}

export async function resolveApprovedAgentScriptPackage(
  sourcePackage: MotionPackage,
  authority: AgentScriptProvenanceAuthority | undefined
): Promise<ResolvedAgentScriptPackage> {
  if (activeScriptLayers(sourcePackage.motion).length === 0) {
    return { package: sourcePackage, evidence: agentScriptExecutionEvidenceForDataOnly(sourcePackage.motion), release: async () => undefined };
  }
  if (!authority) throw new AgentScriptProvenanceRefusal("Active package scripts require a host-injected approved-agent-entry provenance authority.");
  return await authority.resolve(sourcePackage);
}

export { APPROVED_AGENT_SCRIPT_MODE };
