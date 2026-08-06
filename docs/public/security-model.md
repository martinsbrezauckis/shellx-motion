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

Motion also contains render/agent subprocesses in process groups (Unix) or Job
Objects (Windows) so a deadline or cancellation terminates the whole tree, and it
runs an optional host-sandbox capability probe (for example Linux Bubblewrap).
Where Motion cannot yet prove kernel-level sandbox enforcement, its receipts say
so (`status: requested`) rather than claiming a guarantee it has not verified.
Same-user malware with arbitrary file read or process inspection is treated as an
OS-account compromise, which is outside what Motion can defend.

## Network: deny by default

Motion does not reach the network as a side effect of rendering. Browser captures
are network-denied by default; a package's `allowedOrigins` entries are requests,
not authority, and the host must separately approve an exact origin. When network
access is deliberately used — a user-selected public source URL, or the release
update check below — every hostname is resolved first, private/reserved addresses
are rejected, one public address is pinned into the connection, redirects are
revalidated, HTTPS downgrade is refused, and response bytes/content-types/time/
concurrency are bounded.

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
it through a one-use launch exchange; the bundled MCP bridge reads it directly rather than embedding
it in agent configuration. Advanced direct server launches remain able to use an ephemeral private
key file or `SHELLX_MOTION_DEBUG_TOKEN`. Theft of a high-tier key by another local process would
grant that process Motion's filesystem/render authority — treat the key like any other local secret.

## What a capability key does NOT grant

Holding a valid key is authentication, not a licence to read the machine. Three
fences bound what an authenticated client can reach, each enforced at the
transport boundary and covered by regression tests:

- **Receipt reads are fenced to roots the host declared.** Commands that take a
  `receiptsRoot` refuse any directory outside the host's own configured roots, so
  a read-tier client cannot point a receipt or transcript read at an arbitrary
  path the Motion process happens to be able to open. A folder chosen through the
  Workbench's native file chooser is granted for that session only — a client can
  ask for the dialog, but a person decides what comes back.
- **Retained raw prompts die at their stated deadline.** When a prompt receipt is
  kept with `--retain-raw-prompt`, its deletion deadline is enforced at every
  read: after it passes, reads return the receipt without the prompt and the
  stored receipt is rewritten to match. Copies exported before the deadline are
  explicitly outside this promise.
- **Portable review bundles copy only what resolves inside an approved root.**
  A receipt-referenced artifact outside the approved roots becomes an explicit
  omission carrying its role and reason — never a silent copy of a host path the
  reviewer was not meant to see, and never a silently missing file.

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
