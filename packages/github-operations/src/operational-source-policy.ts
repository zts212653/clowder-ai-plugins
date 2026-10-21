import { z } from 'zod';
import type { LegacySourceScope } from './operational-source.js';
import { taskFields } from './operational-source-values.js';

const id = z.string().regex(/^[A-Za-z0-9_.@-]{1,200}$/);
export const operatorConfigSchema = z
  .object({
    v: z.literal(1),
    redisCli: z.string().startsWith('/'),
    redisCliSha256: z.string().regex(/^[a-f0-9]{64}$/),
    connection: z.union([
      z.object({ kind: z.literal('unix'), socket: z.string().startsWith('/') }).strict(),
      z
        .object({
          kind: z.literal('tcp'),
          host: z.string().regex(/^[A-Za-z0-9.-]+$/),
          port: z
            .number()
            .int()
            .min(1)
            .max(65535)
            .refine((p) => p !== 6399),
          tls: z.boolean(),
        })
        .strict()
        .refine((c) => c.tls || ['127.0.0.1', 'localhost'].includes(c.host)),
    ]),
    database: z.number().int().min(0).max(15),
    username: id,
    passwordEnv: z
      .string()
      .regex(/^GITHUB_RECOVERY_[A-Z0-9_]+$/)
      .optional(),
    scope: z
      .object({
        ownerUserId: id,
        keyPrefix: z.string().regex(/^[A-Za-z0-9_.-]{1,100}:$/),
        repositories: z
          .array(z.string().regex(/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/))
          .min(1)
          .max(50),
        excludedTaskIds: z.array(id).max(100),
        sourceRef: z.string().min(1).max(500),
        oldWriterProofRef: z.string().min(1).max(500),
      })
      .strict(),
  })
  .strict();
export type OperatorConfig = z.infer<typeof operatorConfigSchema>;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const validId = (s: string) => /^[A-Za-z0-9_.@-]{1,200}$/.test(s);
const meta = ['id', 'userId', 'threadId', 'mentions', 'deliveryStatus'];
const configFields = [
  'repo',
  'guardThreadId',
  'guardCatId',
  'reviewMode',
  'cloudReviewPolicy',
  'createdAt',
  'updatedAt',
];
const bindingFields = ['connectorId', 'externalChatId', 'threadId', 'userId'];

/** No generic Redis dispatch is exposed by the operator CLI. This predicate is
 * also checked before spawning the trusted binary, including every scan page. */
export function assertLegacyRead(scope: LegacySourceScope, command: string, args: readonly string[]) {
  const fail = () => {
    throw new Error('Command or field outside GitHub read-only plan');
  };
  if ((command === 'PING' && args.length === 0) || (command === 'ACL' && args.join(' ') === 'WHOAMI')) return;
  const key = args[0];
  if (!key?.startsWith(scope.keyPrefix)) return fail();
  const name = key.slice(scope.keyPrefix.length),
    fields = args.slice(1);
  const task = name.startsWith('task:') && validId(name.slice(5)) && !scope.excludedTaskIds.includes(name.slice(5));
  const repo = scope.repositories.find(
    (r) => name === `community:repo-config:${r}` || name === `connector-binding:github-repo-event:${r}`,
  );
  const index = /^tasks:kind:(pr_tracking|issue_tracking)$/.test(name);
  if (command === 'ZCARD' && index && args.length === 1) return;
  if (
    command === 'ZRANGE' &&
    index &&
    args.length === 3 &&
    fields.every((f) => /^\d{1,5}$/.test(f)) &&
    Number(fields[1]) - Number(fields[0]) < 256
  )
    return;
  if (['SCARD', 'SMEMBERS'].includes(command) && name === 'community:repo-configs:index' && args.length === 1) return;
  if (
    command === 'HEXISTS' &&
    task &&
    fields.length === 1 &&
    ['typedWaitRegistration', 'invocationLease', 'claimHistory', 'pluginWait', 'entrustedWork'].includes(fields[0]!)
  )
    return;
  if (
    command === 'HMGET' &&
    fields.length &&
    fields.every((f) =>
      (task
        ? (taskFields as readonly string[])
        : repo
          ? name.startsWith('connector-binding:')
            ? bindingFields
            : configFields
          : /^msg:[A-Za-z0-9_.@-]{1,200}$/.test(name)
            ? meta
            : []
      ).includes(f),
    )
  )
    return;
  if (
    command === 'HGET' &&
    fields.length === 1 &&
    ((/^thread:[A-Za-z0-9_.@-]{1,200}$/.test(name) && fields[0] === 'createdBy') ||
      (/^queue:\{[A-Za-z0-9_.@%-]{1,600}\}:messages$/.test(name) && validId(fields[0]!)))
  )
    return;
  const progress = scope.repositories.some(
    (r) =>
      name === `f141:baseline:${r}` ||
      name === `community:repo-comment:cursor:${r}` ||
      new RegExp(`^f141:notified:${escape(r)}#(pr|issue)-[1-9]\\d*$`).test(name),
  );
  const idem = new RegExp(
    `^msg:idem:${escape(scope.ownerUserId)}:[A-Za-z0-9_.@-]{1,200}:github-wait:[A-Za-z0-9_.@-]{1,200}:[A-Za-z0-9_.:@-]{1,500}$`,
  ).test(name);
  const reconciliation = scope.repositories.some((r) =>
    new RegExp(
      `^msg:idem:${escape(scope.ownerUserId)}:[A-Za-z0-9_.@-]{1,200}:github-repo-event:reconciliation-(pr|issue)-${escape(r)}#[1-9]\\d*$`,
    ).test(name),
  );
  if (
    command === 'GET' &&
    args.length === 1 &&
    (progress || idem || reconciliation || /^f141:delivery:[A-Za-z0-9_.-]{1,200}$/.test(name))
  )
    return;
  if (
    command === 'SSCAN' &&
    name === 'community:events:seen' &&
    args.length === 6 &&
    /^\d+$/.test(args[1]!) &&
    args[2] === 'MATCH' &&
    scope.repositories.some((r) => args[3] === `comment:${r}#*`) &&
    args[4] === 'COUNT' &&
    args[5] === '256'
  )
    return;
  // SCAN has its cursor, rather than a key, in argument zero.
  return fail();
}
export function assertLegacyScan(scope: LegacySourceScope, args: readonly string[]) {
  if (args.length !== 5 || !/^\d+$/.test(args[0]!) || args[1] !== 'MATCH' || args[3] !== 'COUNT' || args[4] !== '256')
    throw new Error('Invalid bounded scan');
  const allowed = [
    scope.keyPrefix + 'f141:delivery:*',
    ...scope.repositories.map((r) => scope.keyPrefix + `f141:notified:${r}#*`),
  ];
  // Reconciliation indexes are exact owner + configured repository, not History.
  for (const repo of scope.repositories)
    allowed.push(
      scope.keyPrefix + `msg:idem:${scope.ownerUserId}:*:github-repo-event:reconciliation-pr-${repo}#*`,
      scope.keyPrefix + `msg:idem:${scope.ownerUserId}:*:github-repo-event:reconciliation-issue-${repo}#*`,
    );
  if (!allowed.includes(args[2]!)) throw new Error('Unscoped scan refused');
}
