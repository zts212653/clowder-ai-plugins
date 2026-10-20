import { z } from 'zod';

const envelope = z.object({
  input: z.record(z.unknown()).optional(),
  operationState: z.object({
    currentAction: z.string().min(1).max(200),
    updatedAt: z.number().int().nonnegative().optional(),
  }).strict().optional(),
}).strict();

/** Manager includes saved configuration and its step cursor in owner actions.
 * Neither is an operation argument or authority. Remove only these known
 * fields; each caller still applies its original strict action schema. */
export function collectiveOwnerOperationInput(value: unknown): { input?: Record<string, unknown> } {
  const parsed = envelope.parse(value);
  if (parsed.input === undefined) return {};
  const { servicePort, ...input } = parsed.input;
  z.string().max(5).optional().parse(servicePort);
  return { input };
}
