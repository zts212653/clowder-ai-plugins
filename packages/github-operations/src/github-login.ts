import { z } from 'zod';

/** GitHub account responses include managed-user logins with underscores.
 * Preserve display case here; consumers normalize only for identity comparisons. */
export const githubLoginSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$/);
