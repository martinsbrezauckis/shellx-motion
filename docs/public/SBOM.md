# Software bill of materials

ShellX Motion can generate a deterministic [CycloneDX 1.6 JSON](https://cyclonedx.org/specification/overview/)
software bill of materials (SBOM) for this source repository:

```bash
pnpm run sbom:check
pnpm run sbom:generate -- --out .scratch/sbom/shellx-motion.cdx.json
```

`sbom:check` runs the generator twice from the committed workspace manifests and
`pnpm-lock.yaml`, then rejects byte drift, absolute host paths, duplicate PURLs,
missing lockfile integrity hashes, and generated claims about installed packages.
The generator uses Node built-ins only; it neither installs dependencies nor
executes package lifecycle hooks, so this local check works without network
access once Node and pnpm are available.

## Scope and limits

The document inventories the root application, workspace packages, and resolved
npm packages from the committed pnpm v9 lockfile. Registry-package SRI hashes
are converted to CycloneDX hash entries. It deliberately has no wall-clock
timestamp or random serial number, which makes identical source inputs produce
identical bytes.

It does **not** inventory Node, operating-system libraries, FFmpeg, FFprobe,
Chromium, GPU drivers, browser downloads, host-provided native binaries, or a
published/installed package payload. Those are environment- and distribution-
specific inputs and require separate release-candidate inventory evidence.
This SBOM therefore does not prove a native or runtime binary composition.

## Artifact policy

Generated SBOM files are not checked in. The `SBOM` GitHub Actions workflow
re-runs the deterministic local gate and uploads exactly one generated
`shellx-motion.cdx.json` file as a 14-day CI artifact with read-only repository
contents permission. It does not publish, attach, sign, or release that file.

Before treating a hosted artifact as release evidence, verify the workflow run,
commit, artifact digest, and the candidate's separately generated native/runtime
inventories. A local gate cannot prove that the hosted workflow has executed.
