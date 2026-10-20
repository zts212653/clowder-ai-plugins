import { rowsResult, operationRowAction, type PluginActionHandler, type PluginHostActionContext } from '@clowder-ai/plugin-sdk';
import { z } from 'zod';
import type { CollectiveConnector } from './business/connector/connector.js';
import { collectiveOwnerOperationInput } from './owner-operation-input.js';
const actionInput = z.object({ connectionId: z.string().min(1).max(240), operationId: z.string().regex(/^[a-f0-9]{64}$/), expectedRevision: z.number().int().positive() }).strict();
const listInput = z.object({ after: z.string().max(500).optional() }).strict();
function inputOf(input: unknown): unknown {
  input = collectiveOwnerOperationInput(input);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'input')) throw new Error('Recovery input is invalid');
  return 'input' in input ? input.input : {};
}
export function createRecoveryActions(connector: CollectiveConnector, assertServiceCurrent: () => Promise<void>): Record<string, PluginActionHandler> {
  const owner = async (native: unknown, context: PluginHostActionContext | undefined, actionId: string) => {
    if (native !== undefined || context?.kind !== 'owner-operation' || context.operationKey !== 'recovery' || context.actionId !== actionId ||
      !context.userId || !context.pluginInstanceId || !context.requestId) throw new Error('Authenticated recovery owner operation is required');
    const assertCurrent = async () => { context.signal.throwIfAborted(); await context.assertCurrent(); await assertServiceCurrent(); context.signal.throwIfAborted(); };
    await assertCurrent(); return { userId: context.userId, assertCurrent };
  };
  const readRows = async (caller: { userId: string; assertCurrent(): Promise<void> }, after?: string) => {
    await caller.assertCurrent();
    const pending = connector.listRecoveryRows(caller.userId, after);
    const rows = pending.rows.map(({ key, connectionId, endpointLabel, operation }) => ({ key,
      label: `${operation.kind} · ${endpointLabel}`.slice(0, 200),
      detail: `Result ${operation.effect}; ${operation.reason}. Revision ${operation.revision}.`,
      actions: operation.choices.map(choice => operationRowAction(choice, { connectionId,
        operationId: operation.operationId, expectedRevision: operation.revision })),
    }));
    if (pending.next) rows.push({ key: 'recovery-next', label: 'More held operations', detail: 'Read the next page',
      actions: [operationRowAction('page', { after: pending.next })] });
    await caller.assertCurrent(); return rowsResult(rows, { empty: 'No held local operations' });
  };
  const list = (actionId: 'list' | 'page'): PluginActionHandler => async (input, native, context) => {
    const caller = await owner(native, context, actionId); const { after } = listInput.parse(inputOf(input));
    return readRows(caller, after);
  };
  const recover = (mode: 'reconcile' | 'resume'): PluginActionHandler => async (input, native, context) => {
    const caller = await owner(native, context, mode); const value = actionInput.parse(inputOf(input));
    await connector.recover(value.connectionId, value.operationId, value.expectedRevision, mode, caller);
    await caller.assertCurrent();
    return readRows(caller);
  };
  return { 'collective.recovery.list': list('list'), 'collective.recovery.page': list('page'),
    'collective.recovery.reconcile': recover('reconcile'), 'collective.recovery.resume': recover('resume') };
}
