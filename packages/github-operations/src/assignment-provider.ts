import { z } from 'zod';
import { executeGitHubRequest, type GitHubRequestOptions } from './business/infrastructure/github/request-budget.js';
import { fetchPaginated } from './business/infrastructure/github/fetch-paginated.js';
import { assignedIssueSchema, type AssignedIssue, type AssignmentProvider } from './assignment-inbox.js';

const loginSchema = assignedIssueSchema.shape.assignees.element;
const rawIssueSchema = z.object({
  id: z.number().int().positive().safe(), node_id: z.string().min(1), number: assignedIssueSchema.shape.number,
  title: assignedIssueSchema.shape.title, state: assignedIssueSchema.shape.state, updated_at: z.string().min(1),
  assignees: z.array(z.object({ login: loginSchema })), pull_request: z.unknown().optional(),
});
const eventSchema = z.object({ id: z.number().int().positive().safe().optional(), event: z.string(), assignee: z.object({ login: loginSchema }).optional() });

function decode(repo: string, raw: z.infer<typeof rawIssueSchema>, assignmentId: string | null): AssignedIssue {
  return { repo, number: raw.number, id: raw.node_id, title: raw.title, state: raw.state, assignees: raw.assignees.map(a => a.login), assignmentId };
}

export class GitHubAssignmentProvider implements AssignmentProvider {
  constructor(private readonly options: { token(): Promise<string | undefined>; execFileAsync?: GitHubRequestOptions['execFileAsync'] }) {}

  private async requestOptions(signal: AbortSignal): Promise<GitHubRequestOptions> {
    signal.throwIfAborted();
    return { signal, ghToken: await this.options.token(), ...(this.options.execFileAsync ? { execFileAsync: this.options.execFileAsync } : {}) };
  }
  async identity(signal: AbortSignal): Promise<string> {
    const options = await this.requestOptions(signal);
    const result = await executeGitHubRequest(['api', 'user', '--hostname', 'github.com'], options);
    return z.object({ login: loginSchema }).parse(JSON.parse(result.stdout)).login;
  }

  async assigned(repo: string, login: string, signal: AbortSignal): Promise<AssignedIssue[]> {
    repo = assignedIssueSchema.shape.repo.parse(repo); login = loginSchema.parse(login);
    const values = z.array(rawIssueSchema).parse(await fetchPaginated(
      `https://api.github.com/repos/${repo}/issues?state=open&assignee=${login}`, await this.requestOptions(signal)));
    return values.filter(v => v.pull_request === undefined).map(value => decode(repo, value, null));
  }

  async current(repo: string, number: number, login: string, signal: AbortSignal): Promise<AssignedIssue> {
    repo = assignedIssueSchema.shape.repo.parse(repo); number = assignedIssueSchema.shape.number.parse(number); login = loginSchema.parse(login);
    const options = await this.requestOptions(signal);
    const path = `https://api.github.com/repos/${repo}/issues/${number}`;
    const read = async () => {
      const result = rawIssueSchema.parse(JSON.parse((await executeGitHubRequest(['api', path, '--hostname', 'github.com'], options)).stdout));
      if (result.pull_request !== undefined || result.number !== number) throw new Error('GitHub Issue identity mismatch');
      return result;
    };
    const issue = await read();
    if (issue.state !== 'open' || !issue.assignees.some(a => a.login === login)) return decode(repo, issue, null);
    const events = z.array(eventSchema).parse(await fetchPaginated(path + '/timeline', options));
    const latest = events.filter(e => ['assigned', 'unassigned'].includes(e.event) && e.assignee?.login === login).at(-1);
    if (!latest?.id || latest.event !== 'assigned') throw new Error('Current GitHub assignment event unavailable; retry');
    const verified = await read();
    if (verified.node_id !== issue.node_id || verified.updated_at !== issue.updated_at ||
        verified.state !== issue.state || JSON.stringify(verified.assignees) !== JSON.stringify(issue.assignees)) {
      throw new Error('GitHub Issue changed during assignment read; retry');
    }
    return decode(repo, verified, String(latest.id));
  }
}
