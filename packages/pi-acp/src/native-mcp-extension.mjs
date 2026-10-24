import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolvePiAgentDir } from './native-path.mjs';
import { MCP_ENV, toNativeServer, validateServers } from './session-mcp.mjs';

export default function registerAcpMcp(pi) {
  try {
    const servers = validateServers(JSON.parse(process.env[MCP_ENV] ?? '[]'));
    delete process.env[MCP_ENV];
    const cwd = process.env.CLOWDER_PI_ACP_CWD ?? process.cwd();
    delete process.env.CLOWDER_PI_ACP_CWD;
    if (!servers.length) return;
    if (typeof pi.registerMcpServer !== 'function')
      throw Error('Pi 1.3+ with native MCP is required; update your Pi client');
    const names = new Set(servers.map((server) => server.name.replaceAll('-', '_')));
    const paths = [join(resolvePiAgentDir(), 'mcp.json'), join(cwd, '.pi', 'mcp.json')];
    for (const path of paths) {
      if (!existsSync(path)) continue;
      const config = JSON.parse(readFileSync(path, 'utf8'));
      if (Object.keys(config.mcpServers ?? {}).some((name) => names.has(name.replaceAll('-', '_')))) {
        throw Error(
          `Remove duplicate ACP MCP server from ${path}; Clowder supplies the current session credentials automatically`,
        );
      }
    }
    for (const server of servers) pi.registerMcpServer(server.name, toNativeServer(server, cwd));
  } catch (error) {
    // Pi catches extension-load exceptions and continues. Exit so ACP cannot silently lose collaboration tools.
    process.stderr.write(
      `clowder-pi-acp: MCP setup failed: ${error instanceof Error ? error.message : 'invalid configuration'}\n`,
    );
    process.exit(64);
  }
}
