# ShellX Motion Workbench Design Contract

Surface: local-first motion editor workstation.

Archetype: Precision with cinematic monitor influence and restrained chrome.

Density: high, with a large preview anchor and compact timeline/inspector data.

Visual thesis: a graphite editing surface where the rendered frame is the brightest object and cyan is reserved for selection, playhead, and primary action.

Interaction thesis: Start Motion opens an authenticated Workbench without making a human retrieve a secret file; the human surface opens directly on package inspection and rendering; file/folder choices use native Browse actions; package loading resolves preview, timeline, and inspector state together; queue, receipts, connections, docs, and engine identity remain one tab away. Template packages are agent reference material and never appear as a human gallery.

Verification thesis: exercise first-run bootstrap, explicit connect/disconnect, access persistence across a server restart, provider-neutral MCP forwarding, history loading, every native Browse purpose, package preview, render, queue/receipts, cached update state, and agent discovery at desktop and compact widths; prove the retired Gallery route and assets are absent; capture screenshots after real engine data loads.

Primary job: inspect a local Motion package, verify its animated output, and render a receipt-backed artifact.

Highest-cost failure: displaying stale or invented package/render state, or allowing a visible control that does not invoke a real local action.

Truth source: the authenticated local engine contract. Static UI copy never substitutes for a command result.

Structural fingerprint:

- 46 px command bar with product/session identity;
- package rail on the left, preview over timeline in the center, contextual inspector on the right;
- cardless regions separated by hairlines and surface value;
- preview uses contain-fit against a checker-free black stage;
- fast 120–180 ms selection/rail transitions, no ornamental looping motion.

State priorities:

| State | Entry | Available action | Guard | Feedback | Recovery |
| --- | --- | --- | --- | --- | --- |
| Disconnected | manually opened page or Disconnect | enter the local access key | access key required | connect dialog and neutral status | Start Motion to reconnect automatically |
| Empty | unlocked, no package | Browse for a package | folder selection required | package rail placeholder | choose another folder |
| Loading | command submitted | wait | duplicate command disabled | inline activity and status text | error preserves input |
| Ready | package commands pass | scrub, select, refresh, render | command tier enforced server-side | preview/timeline/inspector update | reconnect or reopen |
| Rendering | final render submitted | inspect progress text | render submit disabled | modal progress, then receipt-backed queue | failure keeps render form values |
| Error | any command fails | retry relevant action | none | inline concrete API error | no state is silently discarded |

Keyboard routes: Tab reaches every action; Enter opens a package; Space toggles local playback when focus is outside an input; ArrowLeft/ArrowRight step one frame; Escape closes dialogs.

Human/product boundary:

- User-visible copy describes Motion, actions, access, and results. The dedicated Connections surface may show the live MCP/Debug API addresses, access level, masked key, and one-click/copyable client setup because those are user-owned connection controls; protocol internals and token-file permissions stay in technical docs.
- Package, receipt, render-output, and quality-manifest locations are read-only displays backed by native Browse actions. Agent/API callers keep path arguments on their own surfaces.
- Template packages, catalogs, controls, and posters remain available through agent/CLI contracts as reference material. They are not advertised or rendered as a human Gallery.
- Startup, periodic, About-page, and agent update status share one cached result. About explains the product first and keeps update/privacy behavior inside the update section.

Post-install connection flow:

1. **Start Motion** creates or reuses one private per-user access key, publishes the current local port, and opens a single-use Workbench bootstrap URL. The one-time bootstrap value is exchanged for the key and removed from the address before the page becomes interactive.
2. The Workbench opens connected. Disconnect remains available for a shared-screen privacy action; reopening through Start Motion reconnects without asking the user to find a key.
3. **Connections** shows whether the engine is running, the exact access level, and separate user jobs: connect an MCP agent or connect a Debug API client.
4. MCP clients use a local stdio bridge that reads Motion's private key and live-port files. Provider configuration never contains the bearer value and survives Motion choosing a new port.
5. Debug API clients use the displayed loopback base URL and the same bearer key. Reveal/copy are deliberate actions; rotation is never implied by hiding the value.

Connections states:

| State | Entry | Available action | Guard | Feedback | Recovery |
| --- | --- | --- | --- | --- | --- |
| Connected | Workbench bootstrap or manual connection succeeds | copy endpoint/key, configure agent | authenticated session | live endpoint and access badge | reopen Start Motion if server stopped |
| Provider unavailable | client binary is not found | view install guidance | no configuration attempt | named client marked unavailable | install client, then Recheck |
| Ready to configure | supported client is detected | Configure | explicit user click | configuring, then connected/restart-needed | retry with provider error preserved |
| Already configured | client reports Motion entry | Recheck or replace after confirmation | no silent overwrite | connected badge | remove/replace through explicit action |
| Server unavailable | MCP bridge cannot read live port or health fails | Start Motion | no request forwarded | direct start instruction | start engine and retry unchanged agent config |

Docs reader:

- Navigation stays in a fixed rail; the article is left-anchored to that rail rather than centered as a narrow strip.
- Paragraphs use a comfortable technical-manual measure, while tables and code blocks may use the wider reading canvas.
- Desktop body copy is at least 14 px with a relaxed line height; compact layouts keep one readable column and horizontal code scrolling.
