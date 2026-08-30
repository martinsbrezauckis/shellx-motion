# Security model

ShellX Motion is a local, self-hosted, single-user (or trusted self-host) tool.
It is not currently a SaaS or multi-tenant service, and any future hosted product
would be a separate architecture that has to be threat-modeled before it exists.
This page condenses the practical security posture; the full analysis lives in the
project threat model.

Found something this page says cannot happen? That is a vulnerability report, and
[`SECURITY.md`](../../SECURITY.md) at the repository root says how to send it privately, what is in
scope, and what to expect back.

## Data-only packages

Most of a Motion package is data. Shapes, text, keyframes, environments,
particles, and fixed 3D scenes declare what to draw and **cannot execute
arbitrary source code, fetch remote assets implicitly, or raise host resource
limits.**

One layer family is different, and the distinction is the whole of this section.
`web`, `html`, and `canvas` layers name an HTML file inside the package, which
Motion loads into Chromium **with JavaScript enabled**. Rendering such a package
runs that script. The execution is fenced — network denied by default, service
workers blocked, secondary pages refused, file reads confined to the package root
— but the fence bounds what the code can reach, not whether it runs. A package
from a source you do not trust should be treated as a script from that source.
Foreign HTML brought in through `motion.html.snippet.import` is stripped of
`<script>` and reported as lossy, so the import path is the safe one. "Shaders" are a validated GLSL-ES subset with no loops, branches, helper
functions, samplers, or network access; "3D scenes" are Motion-owned primitives
with bounded counts; environments run fixed, package-code-free host shaders. A
construct the contract does not allow is refused — it is never a reason to
hand-inject code or URLs into package JSON.

### Governed local effect modules are installed authority, not package code

A package may reference one installed `motion.afterimage-stack@1.0.0` by exact id/version plus a
closed set of bounded colour/offset parameters. That reference cannot install, replace, enable, or
revoke anything and cannot contain WGSL, JavaScript, WebAssembly, native code, commands, paths,
URLs, assets, imports, browser flags, or resource-ceiling claims. Motion executes only its checked-in
fixed implementation.

The private registry is controlled by explicit human-only Workbench install/confirm/inspect/revoke
operations. Its management authority is not a package, CLI, SDK, Debug request, MCP, RPC, connector,
or receipt field. Selected manifest bytes are stable-read once, copied into private immutable
content-addressed storage, and atomically published. Same id/version with different bytes is an
immutable conflict; revocation disables future use rather than claiming secure deletion.

Pure planning may resolve an entry, but every preview/final/segment operation obtains a fresh opaque
begin-use lease after admission and before module resources or runtime open. Revocation blocks later
jobs, resume, replay, and every later segment range; an already admitted operation may finish and its
receipt records that exact linearization. Browser independently revalidates the fixed ABI and
resource ceiling, then receipts bind installed bytes/provenance, normalized parameters, per-frame
applications, high-water facts, cleanup, and successful lease release. A missing, forged, changed,
revoked, released, oversized, nested, overlapping, or incompatible reference fails closed.

### GPU hybrid sources are stricter than normal browser rendering

The GPU final lane has two narrowly governed hybrid forms, neither of which widens
the normal `web`/`html`/`canvas` execution policy. A GPU HTML hybrid accepts exactly
one package-relative, canonical UTF-8 HTML document only after a strict data-only
scan: scripts, handlers, executable URLs, forms/interactive controls, frames/embeds,
meta refresh, external imports, animation/transition CSS, and remote origins refuse.
Quoted and browser-valid unquoted URL attributes pass through the same bounded closure
classifier, so alternate HTML spelling cannot widen the admitted resource set.
The admitted source bytes are stable-read once, hashed, and supplied from that same
cached fulfillment to the borrowed GPU Chromium session; arbitrary package HTML is
not silently treated as safe.

A GPU restricted-shader hybrid accepts exactly one declared package GLSL asset under
the existing restricted expression validator. Motion stable-reads and hashes it,
rasterizes only that isolated layer through legacy WebGL, releases the WebGL capture,
and gives WebGPU the resulting straight-alpha texture plus declared Motion data for
compositing. GLSL text never enters a WebGPU shader module, and no package may choose
WGSL, a workgroup size, a browser executable, or a second Chromium process. The HTML
and GLSL hybrid forms are mutually exclusive and data-only at browser admission.

Governed GPU segmented delivery carries exactly one such source through a host-owned durable
contract. Before its store opens, Motion freezes source bytes, browser/runtime policy, exact Core
capture requests, texture dimensions, and the full range schedule. Every checkpoint binds the
ordered decoded-pixel ledger and cleanup result for its range. Changed source, runtime, policy,
schedule, pixels, missing cleanup, or a second hybrid source refuses rather than reusing a prefix.

### Approved-agent-entry provenance

Active package scripts are **fail-closed by default**. The only current exception
is a deliberately narrow, local host integration called **approved-agent-entry
provenance**. An operator pre-creates and configures a private, absolute host state root and
injects its authority into the browser host; no package field, path, receipt,
`createdBy` value, CLI flag, Debug/MCP/SDK argument, or agent prompt can select
or construct that authority. The durable state root is pre-created rather than recursively made,
permission-restricted,
symlink-safe, bounded, atomically updated, and separate from every package tree.

The one writing route is `motion.package.script.author`. It requires an
**server-established observed MCP session**, a host-granted `write_local` tier, configured
authoring roots, and that private authority. The server creates the process-local, non-serializable
session fact only after the first valid `2025-06-18` legacy MCP `initialize` exchange on a live
WebSocket connection. The fact is connection-local, cleared on close, and absent from receipts and
results; receipt attribution, a caller-selected `tools/call`, a duplicate or malformed initialize,
and modern client metadata are not authorization facts. Stateless `POST /rpc` remains compatible for
normal legacy and modern MCP tools, but cannot use this sensitive authoring route. It begins with a data-only package,
writes one bounded inline local `web`, `html`, or `canvas` entry into a
copy-on-write output package, forces no requested browser origins, and has the
host mint its own non-secret attestation id and clock. Raw Debug and raw JSON-RPC, CLI,
and SDK calls cannot self-declare into this route. Imports strip scripts; copied
packages and package-local claims do not become approved.

At render time the authority independently rechecks the package-root device/inode,
the framed whole-tree hash, and every executed source descriptor/hash. It rejects
symlinks and special files, creates a private verified snapshot, and Chromium
executes that snapshot rather than the live package path. A same-filesystem move
can remain valid only while its identity and exact bytes still match; copy,
archive extraction, content tampering, revocation, or store tampering fails
closed and needs fresh operator-authorized authoring. This preserves the normal
network, filesystem, process, service-worker, and secondary-page fences.
The one attested inline entry cannot fetch a second executable resource: script,
module-import, worker, and secondary-document resources are denied by the browser
route before they load; an early document guard also refuses dynamic script/frame/
worker construction, and secondary composition inlining is refused. Before the
authority is minted, Motion parses each classic inline script and rejects dynamic
code construction (including computed `eval` and constructor paths), module/src and
inert script blocks, event-handler/`javascript:` markup, workers, frames, and
secondary compositions. The committed entry then receives a host-generated CSP with
hashes of its browser-normalized classic-script bodies: it permits no `unsafe-eval`, network read,
worker, frame, object, or unlisted script. A package stylesheet or other readable
data asset therefore cannot become a second executable source. Normal package/data
image, font, and media assets continue through the existing asset and network fences.

This is evidence of an **approved local script entry and its bytes**, not a
semantic review, a human-authorship claim, a signature for portable trust, or a
general plugin mechanism. Browser receipts record requested and active mode,
resolver version, source hashes, package snapshot hash, and the non-secret
attestation id; the authoring receipt lives in the host store so writing evidence
does not alter the attested package. The command returns the receipt id and inline
evidence, never a private authority-store path. Marketplace scripting remains unavailable
and no agent-facing surface can enable it.

The resolver is session-scoped: preview strips, materialized browser sequences, and streamed browser
finals resolve once, reuse that immutable snapshot, and release it in cleanup. An injected per-frame or
streamed renderer cannot stand in for that host authority. Batch package expansion is refused before
copying active content because inode-bound provenance does not transfer to the copied package. The
Linux Bubblewrap `enforced-untrusted` browser profile remains data-only and is not combined with this
trusted-host route. Final-video script evidence covers the browser snapshot that supplied pixels, not
FFmpeg audio or unrelated encoder inputs.

The highest realistic risk is opening an attacker-supplied package or media on a
trusted workstation. Motion reduces that risk with schema validation,
package-relative asset fencing, content hashing, receipts, deterministic revision
outputs, and explicit fallback/lossiness reporting.

## Sandbox and parser boundaries

Two native processes consume untrusted bytes and run with your OS privileges:

- **Chromium (browser lane)** renders active HTML/CSS/fonts/images/video. Motion
  runs it in a bounded render session with service workers, WebSockets, WebRTC,
  external files, and undeclared origins blocked; package-local file URLs and
  data/blob URLs are allowed.
- **FFmpeg / FFprobe (ffmpeg lane)** parse untrusted media. Motion invokes them
  with `shell:false` through argument arrays, validates input/output roots and
  preset extensions, and bounds diagnostic output.

Motion contains PID-visible render/agent subprocesses in process groups on Unix.
On Windows, native process-tree containment is proved only when a receipt reports
`mode: windows-job-object`, `status: enforced`, and `killTree: true`. When native
setup fails, FFmpeg or agent execution may instead report
`windows-taskkill-fallback`; a security-sensitive host can fail closed with
`SHELLX_MOTION_REQUIRE_NATIVE_WINDOWS_JOB_OBJECT`. Playwright does not expose
Chromium's worker PID to Motion. Browser-lane
receipts therefore report `mode: cooperative-browser-session`,
`status: fallback`, and `killTree: false`; cancellation closes the browser
session cooperatively, but Motion does not claim OS process-tree containment for
that lane. A security-sensitive host can reject this fallback evidence. Motion
also runs an optional host-sandbox capability probe (for example Linux Bubblewrap).
Where Motion cannot yet prove kernel-level sandbox enforcement, its receipts say
so (`status: requested`) rather than claiming a guarantee it has not verified.
Same-user malware with arbitrary file read or process inspection is treated as an
OS-account compromise, which is outside what Motion can defend.

### Enforced untrusted browser host mode (Linux, renderer-host integration)

Motion also has a deliberately narrow, fail-closed **enforced-untrusted** browser
host mode for a package obtained from an untrusted source. It is Linux-only and
requires a successful, hash-bound Bubblewrap capability probe. The browser is
then launched only through a fixed, hash-recorded repository-owned launcher
(never a package executable, eval payload, or page argument). Its conventional
`/usr/bin/env node` shebang receives a two-key launcher-only environment: a `PATH`
pinned to the canonical, hash-recorded Node interpreter's directory and one bounded
configuration value. The launcher verifies that interpreter and its own identity
before Bubblewrap starts. The Bubblewrap profile has a new namespace and network
namespace, dropped capabilities, a read-only package mount, fixed read-only runtime
mounts, and a writable in-namespace tmpfs root (including a separate tmpfs `/tmp`).
The private Playwright browser profile is the **only host-backed writable bind**.
All non-profile filesystem writes are therefore ephemeral inside the namespace;
`/proc` and `/dev` are namespace pseudo-filesystems, not host-backed writable
mounts. The launcher deletes the configuration and Bubblewrap clears the environment
before Chromium starts. A prepared plan is `requested`; only a successful default
Playwright launch can promote its receipt to `linux-bubblewrap: enforced`, recording
the interpreter, launcher, and Bubblewrap identities. Generic injected browser
launchers are refused in this mode so they cannot forge that receipt. This remains
an implementation-attested launch chain, not a completed independent host-runtime
mount proof or Chromium-internal sandbox guarantee; seccomp is not configured by
this slice.

Ordinary Playwright sessions intentionally retain Playwright's default launch shape. Current
Playwright adds Chromium's `--no-sandbox` when `chromiumSandbox` is omitted, so ordinary browser
receipts report `chromium: disabled` with reason `playwright_default_no_sandbox`; they never claim
that Chromium sandboxing was requested. An explicit trusted-host `--no-sandbox` opt-out remains
distinct as `trusted_host_opt_out`. The Linux enforced-untrusted Bubblewrap receipt remains the
only `enforced` browser-process sandbox evidence.

This mode accepts **data-only** packages only. A `web`, `html`, or `canvas` layer,
any host-approved network origin, or a Chromium `--no-sandbox` opt-out is refused
before the browser is launched. Package provenance cannot grant an exception.
Trusted-local agent-authored scripting remains a separately host-owned policy;
an untrusted package cannot select it by claiming a creator, a manifest field, or
a prompt.

It is a public **renderer-host** integration (`BrowserRenderSessionOptions` plus
`ENFORCED_UNTRUSTED_BROWSER_EXECUTION`), not a CLI, Debug/MCP, SDK, or package
data option. The embedding host must make that policy decision from trusted local
configuration and must never relay a package or agent-requested value. Windows
and macOS intentionally refuse it rather than treating Job Objects or deprecated
`sandbox-exec` as equivalent filesystem/network isolation. FFmpeg/FFprobe are
also not yet routed through this browser-specific profile, so the normal public
render surfaces retain the parser-risk boundary described above.

## Network: deny by default

Motion does not reach the network as a side effect of rendering. Browser captures
are network-denied by default; a package's `allowedOrigins` entries are requests,
not authority, and the host must separately approve an exact origin. When network
access is deliberately used — a user-selected public source URL, or the release
update check below — every hostname is resolved first, private/reserved addresses
are rejected, one public address is pinned into the connection, redirects are
revalidated, and HTTPS downgrade is refused. Host-approved browser responses are
brokered before Chromium consumes them: each decoded response is capped at 64 MiB,
the aggregate admitted response body for one frame is capped at 256 MiB, at most
eight responses may be brokered concurrently, and only render-oriented text,
image, audio, video, font, JSON, JavaScript, WebAssembly, and binary media types
are accepted. Browser time and request concurrency remain separately bounded by
the render governor and network policy.

## Loopback-only control plane

The debug/SDK/MCP server binds `127.0.0.1` only. Direct non-loopback binding is
disabled; a tunnel or reverse proxy would have to add its own authentication and
host/origin policy. The server:

- requires a capability token (`Authorization: Bearer`, or WebSocket subprotocol)
  for everything except `GET /health` and the static workbench shell;
- rejects forged `Host` and unapproved `Origin` values;
- bounds request and WebSocket size and concurrency;
- binds the launch tier as a ceiling — a request can drop to a lower tier but
  never elevate above the grant, and packages/prompts cannot elevate themselves.

The normal Start Motion launcher creates one private per-user key, reuses it across restarts, and
stores it outside project directories with user-only permissions. The first Workbench tab receives
it through a one-use launch exchange. Its bootstrap value lives in an owner-only local HTML handoff;
the OS opener receives only the non-secret `file:` URL, never the value in argv or environment.
Motion removes the handoff after claim, opener failure, or shutdown, and consumes the value before
cleanup. The bundled MCP bridge reads the persistent key directly rather than embedding it in agent
configuration. Advanced direct server launches remain able to use an ephemeral private key file or
`SHELLX_MOTION_DEBUG_TOKEN`. Theft of a high-tier key by another local process would grant that
process Motion's filesystem/render authority — treat the key like any other local secret.

Workbench provider setup also treats the child boundary explicitly. On POSIX, built-in agent
providers ignore empty and relative `PATH` entries during health, retain the canonical absolute
executable's device/inode identity, and execute the prompt through a rechecked retained descriptor.
Windows uses its documented canonical-target and fixed PowerShell-wrapper path.
Motion passes a filtered environment without Motion's bearer or ambient credential capabilities; the
provider CLI performs its own normal configuration in place, and Motion neither reads nor copies
provider authentication material.

Attested render reuse has a separate private producer key. Motion uses it to authenticate a
root-bound HMAC proof for each public reuse descriptor; output media, receipts, descriptors, and
their hashes are insufficient by themselves. The installed launcher retains this producer key in
the same user-private Motion access directory, never in a project or output root. A direct embedded
server receives an opaque process-lifetime authority unless its trusted host injects a retained one.

## What a capability key does NOT grant

Holding a valid key is authentication, not a licence to read or write the machine. The following
fences bound what an authenticated client can reach, each enforced at the
transport boundary and covered by regression tests:

- **Receipt reads are fenced to roots the host declared.** Commands that take a
  `receiptsRoot` refuse any directory outside the host's own configured roots, so
  a read-tier client cannot point a receipt or transcript read at an arbitrary
  path the Motion process happens to be able to open. A folder chosen through the
  Workbench's native file chooser is granted for that session only — a client can
  ask for the dialog, but a person decides what comes back.
- **Caller-steered package reads and rendering use host-owned package, input, and output roots.**
  The loopback server fails closed unless read/draft/render package paths, external
  cache/final/batch inputs, and caller-named preview/cache/final/batch destinations are inside their
  respective launch grants or exact human-completed Workbench chooser grants. An omitted preview
  destination remains host-owned scratch. Request path fields never create authority, and batch
  retains the admitted package/data root through the stable open rather than re-deriving it from
  caller data. Package-browser and template-catalog aliases and arrays are admitted element by
  element; template roots are a separate host grant and do not become general package/render roots.
- **Authoring and retained connector routes use separate host-owned roots.** A `write_local` key
  does not authorize arbitrary filesystem paths. Package creation and copy-on-write authoring need
  the configured authoring input and output roots. Archive/extract, review/support bundle and
  tracking-request paths are admitted by their actual input, output, receipt or scratch role rather
  than by permission-tier name alone; legacy Canvas/Cut connector routes enforce the input and/or
  output root classes their operation actually uses. Raw Debug, RPC, MCP and server-SDK fields
  cannot widen those grants, and refusal occurs before an adapter or analyzer runs or an outside
  destination is created.
- **Retained raw prompts die at their stated deadline.** Raw retention is admitted only on Linux,
  where the descriptor-relative stable-reader and purge capability can enforce its deletion
  deadline at every read. After the deadline, reads return the receipt without the prompt and the
  stored receipt is rewritten to match. Debug and direct CLI entry points refuse raw retention
  before prompt execution or receipt writing when governed persistence is absent; macOS and Windows
  therefore refuse it before the prompt receipt is written. Debug and the direct CLI retain the
  exact no-follow receipt root across provider execution, refuse symlink or replaced roots, and
  redact before persistence if provider execution crosses the deadline. Copies exported before
  the deadline are explicitly outside this promise.
- **Portable review bundles copy only what resolves inside an approved root.**
  Core reopens each stable-reader receipt snapshot itself, retaining the approved
  root-relative identity, digest, byte length, and file identity rather than trusting
  a mutable caller entry. It substitutes that private snapshot when rendering the
  review and rechecks the exact receipt/package identities immediately before
  publication; a replacement, mutation, or changed input refuses the bundle. A
  receipt-referenced artifact outside the approved roots becomes an explicit omission
  carrying its role and reason — never a silent copy of a host path the reviewer was
  not meant to see, and never a silently missing file. Serialized review receipts use
  bundle-relative paths and portable leaf names; immediate local results keep their
  absolute published paths. One bundle accepts at most 1,024 artifact attributions
  and copies at most 256 canonical sources, 4 GiB per source and 16 GiB aggregate. A
  limit breach or a source that changes while it is copied aborts publication instead
  of producing a partial public bundle.

## What `push_remote` refusal means

`push_remote` is the top permission tier, and it is **reserved and never
automatic.** It exists so a future hosted or repository-handoff surface can refuse
it explicitly without inventing a new gate. The server requires a separate
`--allow-push-remote` opt-in on top of a `push_remote` grant, and Motion never
infers permission for remote publish or hosted rendering. Today, a request that
would push remote is refused by design — Motion keeps all execution local.

## The automatic, quiet update channel

The standalone CLI checks the configured GitHub release channel at startup and every 30 minutes.
The About page reads that cached result, **Check now** refreshes it, and MCP/JSON-RPC discovery
reports the same `checkedAt`, `latestVersion`, and `updateAvailable` fields to agents. The check sends
only the release-feed request: no project content, prompts, receipts, usage data, or telemetry.
Release builds default to the official ShellX Motion repository. A host can explicitly disable or
override that channel; a disabled channel returns an explicit "not configured" state. A network or
parse failure returns an honest error — never a fabricated "up to date" result.
Applying an update reports the truthful install state: a source checkout is
updated through git, and there is no signed in-place binary channel yet, so the
server will not download and run unverified release bytes.
