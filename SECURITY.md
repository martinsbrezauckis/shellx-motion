# Security policy

ShellX Motion is a local-first, self-hosted rendering engine maintained by one person. This file
says how to report a vulnerability, what counts as one, and what you can expect back. It promises
nothing it cannot keep — in particular, it does not promise a response time.

The posture this policy is written against is [`docs/public/security-model.md`](docs/public/security-model.md):
data-only packages, two native parsers consuming untrusted bytes (Chromium and FFmpeg), a
loopback-only control plane behind a capability token, and network access denied by default. Read it
first — it will tell you whether what you found is a boundary crossing or a documented limit.

## Reporting

Use GitHub's **private vulnerability reporting** on this repository: the *Security* tab →
*Report a vulnerability*. That opens a private advisory visible only to the maintainer.

If that option is not available to you, open a public issue that says only that you have a security
report and asks for a private channel. **Do not put the details in it.** A one-line issue with no
technical content is not a disclosure; a proof of concept in a public issue is.

There is no bug bounty and no payment. Credit in the advisory and the fix commit is offered to
anyone who wants it, and withheld from anyone who does not.

A useful report contains: the commit you tested, the platform and Node/FFmpeg/Chromium versions,
the exact command or Debug API call, the input that triggers it (a minimal package, media file, or
request body), what you observed, and what you expected. Motion writes receipts for most
operations — attaching the receipt is usually faster than describing the run.

## What is in scope

| Surface | What a report should show |
|---|---|
| **CLI** (`@shellx-motion/cli`) | An input — package JSON, referenced asset, media file, argument — that makes Motion read, write, or delete outside the roots it declares, execute code, or misreport what it did. |
| **Debug / SDK / MCP server** (`@shellx-motion/debug-server`) | Anything reachable without the capability token beyond `GET /health` and the static workbench shell; any request that raises its own permission tier above the launch grant; any `Host`/`Origin` or WebSocket path that bypasses the loopback and origin checks; any workbench input that reaches a DOM or filesystem sink. |
| **Render lanes** (native, browser, ffmpeg) | Untrusted bytes that escape a lane: a package that reaches the network from a browser capture, a media file that makes the FFmpeg invocation run something other than the declared arguments, a render that survives its deadline or cancellation. |
| **Package and contract validation** | A construct the schemas and validators are supposed to refuse but accept — shader source outside the allowed GLSL-ES subset, an asset path escaping the package root, an unbounded count where the contract states a bound. |
| **Public export boundary** | Anything private that reaches the published tree, including credentials, host paths, internal operational history, or files outside the declared public documentation and source surfaces. |
| **Connectors** (Design Studio, Cut) | A connector plan or bridge payload that writes outside the target project, or that applies operations the host did not authorise. |
| **False security claims** | Documentation, a receipt field, or a capability report that states a guarantee Motion does not actually enforce. This project treats an overclaim as a defect in its own right, not a documentation nit. |

## What is not in scope

- **Same-user compromise.** An attacker who already runs code as your user can read the token file,
  inspect Motion's processes, and write its inputs. That is an OS-account compromise; Motion does
  not claim to defend against it, and neither does this policy.
- **Upstream vulnerabilities in FFmpeg, Chromium, Node.js, or npm dependencies.** Report those to
  their projects. They become in scope here only if Motion's *invocation* makes one reachable that
  otherwise would not be, or if Motion fails to pass a bound the upstream tool expects — say so
  explicitly and show the link.
- **Resource exhaustion you caused on your own machine.** Motion is a local tool with bounded
  concurrency; handing it a deliberately enormous job is a supported way to use up your own CPU.
  A *bypass* of a declared bound (the memory ceiling, the render deadline, the request size cap)
  is in scope.
- **Missing hardening on the loopback server** with no demonstrated attack path — the server binds
  `127.0.0.1`, refuses direct non-loopback binding, and is not a public web application. Show how
  it is reached.
- **`push_remote` refusals.** The tier is reserved and never automatic. A refusal is the design.
- **Findings against a modified tree**, a fork, or a build with the safety flags removed.
- **Automated scanner output with no analysis.** A CVE list against the lockfile, or a report that
  a linter fired, is not a vulnerability report.

## Supported versions

Pre-1.0, and shipped as a **source release**: you clone this tree, build it, and run it from here.
There is no published binary and no signed in-place update channel, so there are no back-ported
security branches to speak of.

Only the current default branch is supported. Fixes land there; if you are running an older commit,
the remedy is to update. Report against the newest commit you can reproduce on, and say which one.

## What happens next

The maintainer is one person, working on this alongside other projects. Concretely:

- Your report is read. There is **no guaranteed acknowledgement time and no fix deadline** — a
  policy that promised 48 hours here would be a number invented to look professional.
- If you have heard nothing after **14 days**, assume the message did not arrive and send it again
  through the same channel. That is a real failure mode, not impatience on your part.
- When a report is confirmed, you will be told so, and told when the fix lands. When it is not a
  vulnerability, you will be told that too, with the reasoning — a report that turns out to be a
  documented limit is still worth the exchange, and this project's own reviews have produced both
  kinds.
- Please give the fix a chance to land before publishing. **90 days** is the window this project
  asks for and considers reasonable. It is a request, not a legal condition, and it does not apply
  to a vulnerability already being exploited in the wild — tell us and publish.

## Hardening this project already applies

Reported here so you can skip re-deriving it, and so a claim below that turns out to be false is
itself a reportable finding:

- Loopback-only binding, capability-token authentication, and a permission tier that acts as a
  ceiling rather than a starting point.
- Browser-lane renders capture exactly one page. A composition cannot open a second window and
  reach the network from it: secondary pages are refused at the request layer, which is the only
  point that reliably sees a popup's first request before it leaves.
- Imported assets are opened once and copied from that same open file, so a file swapped after
  validation cannot be the file that gets staged. One boundary is documented rather than claimed
  away: a hard link created inside a source directory you already control resolves to its target,
  and is not treated as an escape.
- Network denied by default during rendering; when network access is deliberate, DNS is resolved
  first, private and reserved addresses are rejected, one public address is pinned into the
  connection, redirects are revalidated, and HTTPS downgrade is refused.
- FFmpeg and FFprobe invoked with `shell:false` through argument arrays, with validated input and
  output roots.
- Render and agent subprocesses contained in process groups (Unix) or Job Objects (Windows), so a
  deadline or cancellation terminates the whole tree.
- Receipts that state what was actually verified. Where Motion cannot prove an enforcement — kernel
  sandboxing, for instance — the receipt records `requested` rather than claiming a guarantee.

MIT licensed, with no warranty: see [`LICENSE`](LICENSE). This policy describes intent and practice,
and does not modify that.
