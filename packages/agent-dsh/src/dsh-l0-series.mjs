import { randomUUID } from 'node:crypto';
export const name = 'clowder-l0-series';
export const inject = ['systemPrompt'];
export function apply(ctx, config) {
  ctx.systemPrompt.section({
    name: 'clowder-l0',
    order: 1,
    text: `${config.marker}\n${config.body}`,
    interpolate: false,
  });
  ctx.on('agent/pre-step', async ({ agent, turn, step }, next) => {
    const decision = await next();
    if (decision.kind !== 'enter') return decision;
    const history = agent.session
      .deriveMessages()
      .filter((message) => message.role === 'system' && message.content.length);
    const prior = history.at(-1);
    const marker = history
      .flatMap((message) => message.content)
      .flatMap((block) =>
        block.type === 'text'
          ? (block.text?.match(/^<!-- clowder-l0:[a-f0-9]{64} -->$/m) ?? [])
          : [],
      )
      .at(-1);
    if (!prior || marker === config.marker) return decision;
    if (Array.isArray(prior.source?.sections)) {
      agent.session.append(
        'system/message',
        {
          turn,
          step,
          message: {
            id: randomUUID(),
            role: 'system',
            content: [],
            source: {
              kind: 'system-prompt',
            },
          },
        },
        {
          surfaceOp: 'append',
        },
      );
    }
    return {
      ...decision,
      startsRequestSeries: true,
    };
  });
}
