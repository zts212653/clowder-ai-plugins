import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createReceiverServer } from './server.mjs';

export function createRepoSyncMcpServer(receiver, options = {}) {
  const server = new McpServer({
    name: 'clowder-repo-sync',
    version: '0.1.0-alpha.0',
  });
  let workbench;
  let starting;
  let closed = false;
  const result = (value) => ({
    content: [{ type: 'text', text: JSON.stringify(value) }],
  });
  const run = (operation) => async () => {
    try {
      return result(await operation());
    } catch {
      return {
        content: [
          {
            type: 'text',
            text: '操作未完成，请在本地检查插件配置或同步台账。',
          },
        ],
        isError: true,
      };
    }
  };
  server.registerTool(
    'repo_sync_status',
    {
      title: 'Repository reception status',
      description:
        'Read bounded reception metadata from the configured private ledger. No Git execution, repository URLs, documents or credentials are returned.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    run(async () => {
      if (options.projects) receiver = await options.projects.current();
      else if (options.connection) receiver = await options.connection.current();
      const state = receiver ? await receiver.status() : null;
      return {
        configured: Boolean(receiver),
        ...(options.projects
          ? {
              scope: 'default-project',
              projectCount: (await options.projects.list()).projects.length,
            }
          : {}),
        mode: receiver?.config.mode ?? null,
        adopted: Boolean(state),
        queued: state?.queue.length ?? 0,
        accepted: state?.accepted
          ? {
              upstream: state.accepted.upstream,
              internal: state.accepted.internal,
              tag: state.accepted.tag,
            }
          : null,
        active: state?.active
          ? {
              id: state.active.id,
              status: state.active.status,
              errorCode: state.active.error?.code,
            }
          : null,
      };
    }),
  );
  server.registerTool(
    'repo_sync_open_workbench',
    {
      title: 'Open repository reception workbench',
      description:
        'Explicitly start a loopback operator workbench and return its local URL. Git reception and PR actions remain with the operator; this tool cannot start them.',
      inputSchema: {},
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    run(async () => {
      if (closed) throw new Error('Plugin stopped');
      if (!starting) {
        workbench = createReceiverServer(receiver, options);
        starting = new Promise((done, reject) => {
          workbench.once('error', reject);
          workbench.listen(0, '127.0.0.1', () => done(`http://127.0.0.1:${workbench.address().port}/`));
        });
      }
      if (options.connection) receiver = await options.connection.current();
      return {
        url: await starting,
        mode: receiver?.config.mode ?? null,
        simulation: false,
      };
    }),
  );
  const close = server.close.bind(server);
  server.close = async () => {
    closed = true;
    if (starting) await starting.catch(() => {});
    if (workbench?.listening) await workbench.shutdown();
    await close();
  };
  server.server.onclose = () => {
    void server.close();
  };
  return server;
}
