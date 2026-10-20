import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { collectModels } from './assets.mjs';
import { callBridge } from './bridge-client.mjs';
import { VERSION } from './contract.mjs';
import { exportSelected } from './export-selected.mjs';
import { prepareHelper } from './install.mjs';
import { closeActiveReview, reviewSharedModel } from './shared-review.mjs';
import { wrapTool as wrap } from './tool-request.mjs';
import { defaultRoot, readStatus } from './status.mjs';

const outputDirectoryInput = z
  .string()
  .max(4096)
  .optional()
  .describe(
    'User-selected absolute output directory, e.g. /absolute/project/review. Defaults to Downloads/Tripo.',
  );
const server = new McpServer({ name: 'tripo-studio-mcp-server', version: VERSION });
server.registerTool(
  'tripo_review_shared_model',
  {
    description:
      'Read one user-shared Tripo model in an isolated anonymous background Chrome and save four orbit views. Use when comparing white-mesh candidates from Studio share links. NOT for login, generation, texturing or official export. Output: local PNGs and source/hash manifest; a preview GLB only when actually available. Orbit steps are not calibrated front/side views.',
    inputSchema: {
      url: z
        .string()
        .max(8192)
        .describe('Exact https://studio.tripo3d.ai/3d-model/<UUID> share URL, optional invite_code.'),
      number: z.number().int().min(1).max(8).describe('Candidate number in the user-provided order (1–8).'),
      output_directory: outputDirectoryInput,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  wrap(({ url, number, output_directory }, { signal }) =>
    reviewSharedModel(url, number, output_directory ?? defaultRoot, { signal }),
  ),
);
server.registerTool(
  'tripo_status',
  {
    description:
      'Inspect Tripo plugin version, configured output directory and optional authorized Chrome bridge. Use for setup or recovery. NOT proof that the page is readable or a model exported. Output: separate artifact/config/auth/live state and exact next action.',
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  wrap((_args, { signal }) => readStatus({ signal })),
);
server.registerTool(
  'tripo_prepare_chrome',
  {
    description:
      'Prepare or repair the optional Tripo Chrome Native Messaging component from this installed package. Use only when the user has authorized connecting their Chrome Studio pages. NOT needed for anonymous share-link review; does not grant browser permission or change tabs. Output: stable extension folder and one native Chrome confirmation step; pairing secret stays local.',
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  wrap((_args, { signal }) => prepareHelper({ signal })),
);
server.registerTool(
  'tripo_collect_authorized_models',
  {
    description:
      'Read the exact model pages explicitly authorized in the Tripo extension, download unambiguous existing preview GLBs and write source/focus evidence. Use for an authorized open batch. NOT for generation, arbitrary browser commands, or official export. Output: numbered local candidate files or honest per-candidate failure; activity changes abort the observation.',
    inputSchema: {
      output_directory: outputDirectoryInput,
      model_ids: z
        .array(z.string().uuid())
        .min(1)
        .max(8)
        .describe('Model UUIDs in the user-provided comparison order; no unlisted page will be read into the report.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  wrap(async ({ output_directory, model_ids }, { signal }) =>
    collectModels(await callBridge('observe', { signal }), output_directory ?? defaultRoot, {
      modelIds: model_ids,
      signal,
    }),
  ),
);
server.registerTool(
  'tripo_export_selected',
  {
    description:
      'Copy one already-downloaded candidate selected by the human into the configured output directory. Use after the user chooses a model from a collected authorized batch. NOT for choosing a model, creating a supplier export or overwriting files. Output: GLB plus source/hash receipt; tampered or unavailable files are rejected.',
    inputSchema: {
      batch_id: z.string().max(120),
      output_directory: outputDirectoryInput,
      number: z.number().int().min(1).max(8),
      filename: z
        .string()
        .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}\.glb$/)
        .describe('New filename, for example train-selected.glb; no directories.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  wrap(({ batch_id, number, filename, output_directory }, { signal }) =>
    exportSelected(output_directory ?? defaultRoot, batch_id, number, filename, { signal }),
  ),
);
server.server.onclose = () => {
  void closeActiveReview();
};
process.once('SIGTERM', () => {
  void closeActiveReview().finally(() => process.exit(0));
});
await server.connect(new StdioServerTransport());
