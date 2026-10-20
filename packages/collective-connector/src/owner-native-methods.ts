import { z } from 'zod';
import { collectiveTargetSchema } from './business/contracts/index.js';

export const COLLECTIVE_OWNER_NATIVE_ID = 'collective-owner-native';
// Legal input of the original queueVerifiedAgentMessage; Host identity is never a tool argument.
export const collectiveOwnerSendSchema = z.object({ connectionId: z.string().trim().min(1).max(240),
  clientEventId: z.string().trim().min(1).max(200), target: collectiveTargetSchema,
  replyToEventId: z.string().optional(), body: z.string().trim().min(1).max(32000) }).strict();
export const collectiveOwnerNativeTools = [{ method: 'collective.connector.send', name: 'cat_cafe_collective_connector_send',
  description: 'Queue an owner-authorized Agent message on your paired Collective connection. Supply a stable clientEventId, target and body; reuse the same input after response loss in this invocation. Public participation, limited-policy and private Work returns must use their exact reply/progress operations instead. This does not accept Work or start a Task.',
  schema: collectiveOwnerSendSchema }] as const;
