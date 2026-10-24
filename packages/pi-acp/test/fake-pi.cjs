const fs = require('node:fs');
fs.writeFileSync(
  process.env.PI_ACP_CAPTURE,
  JSON.stringify({
    args: process.argv.slice(2),
    mcp: process.env.CLOWDER_PI_ACP_MCP_SERVERS,
  }),
);
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const q = JSON.parse(line);
    let data = {};
    if (q.type === 'get_state')
      data = {
        sessionId: 'fixture',
        sessionFile: process.env.PI_ACP_SESSION_FILE,
        model: {
          id: 'fixture',
          provider: 'fixture',
          name: 'Fixture',
          contextWindow: 10000,
        },
        thinkingLevel: 'off',
      };
    if (q.type === 'get_available_models')
      data = {
        models: [
          {
            id: 'fixture',
            provider: 'fixture',
            name: 'Fixture',
            contextWindow: 10000,
          },
        ],
      };
    if (q.type === 'get_commands') data = { commands: [] };
    if (q.type === 'get_available_thinking_levels') data = { levels: ['off', 'low', 'medium', 'high'] };
    process.stdout.write(
      JSON.stringify({
        type: 'response',
        id: q.id,
        command: q.type,
        success: true,
        data,
      }) + '\n',
    );
  }
});
