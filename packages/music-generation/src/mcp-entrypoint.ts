import { createInterface } from 'node:readline';
import { createModuleActionClient } from '@clowder-ai/plugin-sdk';
import { object } from './types.js';

export const musicTool = {
  name: 'generate_music',
  description: 'Generate background music / 配乐 through the enabled Google Cloud music plugin. Use when: a film or game needs an instrumental soundtrack or song. NOT for: speech, transcription, AI Studio prepaid credits or Flow Music browser subscription usage. Output: one billed generation and a new project-local MP3 plus provenance, or a structured pending/refused/unknown result. GOTCHA: use the same requestId and exact arguments when polling or recovering delivery; a different requestId starts a new paid operation. Never automatically replace unknown work. Cloud OAuth, plugin enablement and the current project output grant are separate; actual charges and Ultra credit deduction remain unverified.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['requestId', 'outputPath', 'parameters'], properties: {
    requestId: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,128}$', description: 'Stable unique identity for this intentional generation, retained unchanged when polling or recovering delivery.' },
    outputPath: { type: 'string', minLength: 1, maxLength: 4096, description: 'New relative .mp3 path in the current calling project. Existing audio or provenance is refused before generation.' },
    parameters: { type: 'object', additionalProperties: false, required: ['prompt'], properties: {
      prompt: { type: 'string', minLength: 1, maxLength: 12000, description: 'Music style, mood and instruments.' },
      model: { enum: ['lyria-3-clip-preview', 'lyria-3-pro-preview'], default: 'lyria-3-clip-preview' },
      instrumental: { type: 'boolean', default: true },
      durationSeconds: { type: 'integer', minimum: 5, maximum: 180, description: 'Prompt intent, not measured duration; Clip permits only 30 or omission.' },
      bpm: { type: 'integer', minimum: 20, maximum: 300 },
    } },
  } },
};

const client = createModuleActionClient();
async function handle(request: Record<string, unknown>) {
  const id = request.id;
  if (id === undefined) return;
  const result = (value: unknown) => ({ jsonrpc: '2.0', id, result: value });
  if (request.method === 'initialize') return result({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'google-cloud-music', version: '0.1.0-alpha.0' } });
  if (request.method === 'ping') return result({});
  if (request.method === 'tools/list') return result({ tools: [musicTool] });
  if (request.method !== 'tools/call' || !object(request.params) || request.params.name !== musicTool.name)
    return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Unknown music tool method' } };
  try {
    const response = await client.invoke('music.output', request.params.arguments, { _meta: request.params._meta });
    return result({ content: [{ type: 'text', text: JSON.stringify(response) }] });
  } catch {
    return result({ isError: true, content: [{ type: 'text', text: 'Music action was refused or its result is unknown. Check the plugin card; do not create a replacement paid request.' }] });
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', line => {
  void (async () => {
    if (Buffer.byteLength(line) > 128 * 1024) throw new Error('request_too_large');
    const value: unknown = JSON.parse(line);
    if (!object(value)) throw new Error('invalid_request');
    const response = await handle(value);
    if (response !== undefined) process.stdout.write(`${JSON.stringify(response)}\n`);
  })().catch(() => { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid music tool request' } })}\n`); });
});
