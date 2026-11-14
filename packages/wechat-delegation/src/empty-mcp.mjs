// The controlled conversation exposes no tools, resources, prompts or Host
// actions. Importing this file is not part of the builtin module entrypoint.
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  if (Buffer.byteLength(buffer) > 65536) { process.exitCode = 1; process.stdin.destroy(); return; }
  for (;;) {
    const end = buffer.indexOf('\n'); if (end < 0) break;
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    let request;
    try { request = JSON.parse(line); } catch { continue; }
    if (request.id === undefined) continue;
    const result = request.method === 'initialize' ? { protocolVersion: request.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'wechat-isolated', version: '0.1.0-alpha.1' } }
      : request.method === 'tools/list' ? { tools: [] }
      : request.method === 'resources/list' ? { resources: [] }
      : request.method === 'prompts/list' ? { prompts: [] }
      : request.method === 'ping' ? {} : null;
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...(result === null ? { error: { code: -32601, message: 'No tools are exposed in this conversation' } } : { result }) }) + '\n');
  }
});
