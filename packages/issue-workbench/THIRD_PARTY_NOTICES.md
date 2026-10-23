# Licenses

The extracted Issue workbench is from Clowder AI, Copyright (c) 2026 Clowder AI
Contributors, under the MIT license included in LICENSE.

The browser bundle includes React, React DOM and Scheduler (MIT), marked (MIT), and DOMPurify
(Apache-2.0 OR MPL-2.0). esbuild preserves bundled license notices in the linked
`dist/browser.js.LEGAL.txt` artifact. Complete upstream license texts are included
in `dist/licenses/<package>/`. Build tools and test dependencies are not
runtime dependencies. See the exact versions in package.json and the repository
lockfile.

The native conversation MCP bundle also contains the Model Context Protocol SDK,
the Clowder AI plugin SDK and their bundled dependencies. Their license texts are
included under `dist/licenses/`, with linked notices in `dist/team-mcp.js.LEGAL.txt`.
The packed bridge needs no separately installed runtime dependencies.
