/** Internal Debug host selection: an injected renderer is not provenance authority. */
import type { AgentScriptProvenanceAuthority } from "@shellx-motion/core";
import {
  createHostBoundBrowserFrameRenderer,
  createHostBoundBrowserRenderSessionFactory,
  type MotionBrowserRenderSessionFactory
} from "@shellx-motion/renderer-browser";
import type { BrowserFrameRenderer } from "./domains/integration-browser-workflow.js";
import { provenanceBoundInjectedBrowserFrameRenderer } from "./injected-browser-frame-renderer-provenance.js";

export function selectDebugBrowserFrameRenderer(
  injected: BrowserFrameRenderer | undefined,
  authority: AgentScriptProvenanceAuthority | undefined
): {
  renderer: BrowserFrameRenderer;
  sessionFactory?: MotionBrowserRenderSessionFactory;
  activeScriptSessionAvailable: boolean;
  injectedForFrameTransport: boolean;
} {
  return {
    renderer: injected
    ? provenanceBoundInjectedBrowserFrameRenderer(injected, authority)
    : createHostBoundBrowserFrameRenderer({ agentScriptAuthority: authority }),
    ...(!injected ? { sessionFactory: createHostBoundBrowserRenderSessionFactory({ agentScriptAuthority: authority }) } : {}),
    activeScriptSessionAvailable: Boolean(authority && !injected),
    injectedForFrameTransport: Boolean(injected)
  };
}
