# Third-party compliance entrypoint

The renderer artifact is built from GenOffice `v0.8.1039`, commit
`e833fff87f5628cc681e0fd1a063ce64fde5baa4`. Exact source and license digests live
in `source-lock.json`.

Every renderer build invokes that frozen source's
`tools/gen-third-party-notices.mjs`. The built source maps select the npm
packages that actually reach the renderer bundle, and every emitted font file
must map to the upstream-generated font notices. Those notices and the exact
file-level SPDX inventory ship as:

- `renderer/THIRD-PARTY-NOTICES.txt`
- `renderer/SBOM.spdx.json`

The pack gate rejects either missing file or any renderer file whose SHA-256 no
longer matches the SBOM. The enterprise `ee/` tree, Electron main/preload,
Chromium runtime, other Office apps, and native sidecars are not packaged.
