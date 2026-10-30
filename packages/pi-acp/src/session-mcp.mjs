import { fileURLToPath } from 'node:url';

export const MCP_ENV = 'CLOWDER_PI_ACP_MCP_SERVERS';

export function validateServers(servers) {
  if (!Array.isArray(servers) || servers.length > 32 || Buffer.byteLength(JSON.stringify(servers)) > 65536) {
    throw Error('ACP MCP servers must be an array of at most 32 entries / 64 KiB');
  }
  const names = new Set();
  for (const server of servers) {
    if (!server || !/^[a-zA-Z0-9_-]{1,128}$/.test(server.name ?? '')) throw Error('Invalid MCP server name');
    const key = server.name.replaceAll('-', '_');
    if (names.has(key)) throw Error(`Duplicate MCP server: ${server.name}`);
    names.add(key);
    if (server.type === 'sse') throw Error('Pi supports stdio and streamable HTTP MCP; SSE is unsupported');
    if (server.type === 'http') {
      const url = new URL(server.url);
      if (!['http:', 'https:'].includes(url.protocol)) throw Error('Invalid MCP HTTP URL');
      validatePairs(server.headers, 'headers');
    } else {
      if (server.type && server.type !== 'stdio') throw Error('Unsupported MCP transport');
      if (typeof server.command !== 'string' || !server.command.trim() || server.command.includes('\0'))
        throw Error('Invalid MCP executable');
      if (!Array.isArray(server.args) || server.args.some((arg) => typeof arg !== 'string' || arg.includes('\0')))
        throw Error('Invalid MCP arguments');
      validatePairs(server.env, 'environment');
    }
  }
  return servers;
}

function validatePairs(pairs, label) {
  if (!Array.isArray(pairs) || pairs.length > 128) throw Error(`Invalid MCP ${label}`);
  const names = new Set();
  for (const pair of pairs) {
    if (
      !pair ||
      typeof pair.name !== 'string' ||
      !pair.name ||
      /[\0\r\n=]/.test(pair.name) ||
      typeof pair.value !== 'string' ||
      pair.value.includes('\0') ||
      names.has(pair.name)
    ) {
      throw Error(`Invalid or duplicate MCP ${label} entry`);
    }
    names.add(pair.name);
  }
}

export function preparePiMcp(servers, cwd) {
  validateServers(servers);
  return {
    args: servers.length ? ['--extension', fileURLToPath(new URL('./native-mcp-extension.mjs', import.meta.url))] : [],
    env: { [MCP_ENV]: JSON.stringify(servers), CLOWDER_PI_ACP_CWD: cwd },
  };
}

export function toNativeServer(server, cwd) {
  return server.type === 'http'
    ? {
        type: 'http',
        url: server.url,
        headers: Object.fromEntries(server.headers.map((pair) => [pair.name, pair.value])),
        exposure: 'direct',
      }
    : {
        command: server.command,
        args: server.args,
        env: Object.fromEntries(server.env.map((pair) => [pair.name, pair.value])),
        cwd,
        exposure: 'direct',
      };
}
