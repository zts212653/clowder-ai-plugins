import { z } from 'zod';
import { workspaceClient } from './workspace-client.mjs';
import { collectOfficialExport } from './official-export.mjs';
import { wrapTool } from './tool-request.mjs';

export function registerWorkspaceTools(server) {
  const client = workspaceClient();
  server.registerTool(
    'tripo_workspace_status',
    {
      description:
        'Inspect the separately authorized subscription workspace and actual visible generation settings/login. NOT a grant, upload, generation or proof of quadruped rigging. Optional page opens only a fixed generation/rigging/animation route in the plugin-created workspace; call again to inspect it. No rig or animation is automatically applied. Requires the generation/export mode in the extension; read-only grants cannot use it.',
      inputSchema: {
        page: z.enum(['generate', 'rigging', 'animate']).optional(),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    wrapTool(({ page }, { signal }) => client.inspect(signal, page)),
  );
  server.registerTool(
    'tripo_prepare_generation',
    {
      description:
        'Upload human-approved reference images and set the authorized Studio subscription form, then return an exact preview and job digest without clicking Generate. Use for an already accepted generation task. NOT paid API, purchases, upgrades, unapproved reference art or an automatic batch. Chrome generation/export authorization is required. Check the returned privacy/model/credit display before submit.',
      inputSchema: {
        job_key: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
        approved_source_ref: z.string().min(1).max(512),
        images: z
          .object({
            front: z.string().max(4096),
            left: z.string().max(4096).optional(),
            right: z.string().max(4096).optional(),
            back: z.string().max(4096).optional(),
          })
          .strict(),
        settings: z
          .object({
            mode: z.literal('Smart Mesh'),
            privacy: z.enum(['Private', 'Share Only', 'Public']),
            topology: z.enum(['Quad', 'Triangle']).optional(),
            polycount: z.number().int().min(500).max(25000).optional(),
          })
          .strict(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    wrapTool((args, { signal }) => client.prepare(args, signal)),
  );
  server.registerTool(
    'tripo_submit_generation',
    {
      description:
        'Submit one exact prepared job through the already authorized webpage subscription; consumes the displayed Studio credits. Use only for the human-accepted task after reviewing the returned preview. Persist before clicking and never automatically retry an attempted job. An unknown result needs actual supplier reconciliation, not a new job key.',
      inputSchema: {
        job_id: z.string().regex(/^[a-f0-9]{64}$/),
        digest: z.string().regex(/^[a-f0-9]{64}$/),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    wrapTool(({ job_id, digest }, { signal }) =>
      client.submit(job_id, digest, signal),
    ),
  );
  server.registerTool(
    'tripo_generation_status',
    {
      description:
        'Read a retained local generation attempt, including submission_unknown. Does not retry, regenerate, refund credits or claim an export.',
      inputSchema: { job_id: z.string().regex(/^[a-f0-9]{64}$/) },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    wrapTool(({ job_id }) => client.read(job_id)),
  );
  server.registerTool(
    'tripo_request_official_export',
    {
      description:
        'Request GLB/FBX from the supplier export UI for the explicitly selected model. Fails when model identity or current export controls cannot be verified. NOT generation, an API export, a preview-file copy or a promise that download completed. Poll and collect using the returned exportId.',
      inputSchema: {
        model_id: z.string().uuid(),
        format: z.enum(['glb', 'fbx']),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    wrapTool(({ model_id, format }, { signal }) =>
      client.export(model_id, format, signal),
    ),
  );
  server.registerTool(
    'tripo_collect_official_export',
    {
      description:
        'Poll one tracked supplier download and, only when complete, copy verified GLB/FBX bytes plus provenance to the requested project directory without overwriting. Never submits generation. GLB counts come from actual bytes; FBX needs Blender inspection.',
      inputSchema: {
        export_id: z.string().uuid(),
        output_directory: z.string().max(4096),
        filename: z.string().max(90),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    wrapTool(async ({ export_id, output_directory, filename }, { signal }) => {
      const value = await client.downloadStatus(export_id, signal);
      return value.state === 'complete'
        ? collectOfficialExport(value, output_directory, filename, { signal })
        : value;
    }),
  );
}
