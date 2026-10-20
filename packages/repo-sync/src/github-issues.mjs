import { fail } from './config.mjs';
import { api, graphql } from './gh-api.mjs';

const closingQuery =
  'query($owner:String!,$name:String!,$number:Int!,$endCursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){closingIssuesReferences(first:100,after:$endCursor){nodes{id number title url state repository{id nameWithOwner}} pageInfo{hasNextPage endCursor}}}}}';
const eventsQuery =
  'query($id:ID!,$endCursor:String){node(id:$id){...on Issue{timelineItems(itemTypes:[CLOSED_EVENT],first:100,after:$endCursor){nodes{...on ClosedEvent{id createdAt closer{...on PullRequest{id}...on Commit{oid}}}} pageInfo{hasNextPage endCursor}}}}}';
export async function closingIssues(repo, number) {
  const [owner, name] = repo.split('/');
  const pages = await graphql(closingQuery, { owner, name, number });
  if (pages.some((page) => !page.data.repository?.pullRequest)) fail('METADATA_INCOMPLETE', 'PR 关闭关联查询不完整');
  return pages.flatMap((page) => page.data.repository.pullRequest.closingIssuesReferences.nodes);
}
export async function closedEvents(id) {
  const pages = await graphql(eventsQuery, { id });
  if (pages.some((page) => !page.data.node?.timelineItems)) fail('METADATA_INCOMPLETE', 'Issue 关闭事件查询不完整');
  return pages.flatMap((page) => page.data.node.timelineItems.nodes);
}
export function issueReferences(texts, repo) {
  const refs = new Map();
  for (const text of texts) {
    const priorityHashPositions = new Set(
      [...text.matchAll(/\b(?:priority\s*[:=]?\s*)?\[?P\d+\]?\s*(?:[:\-–]\s*)?#\d+/gi)]
        .map((match) => match.index + match[0].lastIndexOf('#')),
    );
    for (const match of text.matchAll(/(?:^|[\s(:,[/])(?:([\w.-]+\/[\w.-]+))?#(\d+)\b/g)) {
      if (priorityHashPositions.has(match.index + match[0].lastIndexOf('#'))) continue;
      refs.set(`${match[1] ?? repo}#${match[2]}`, { repo: match[1] ?? repo, number: Number(match[2]) });
    }
    for (const match of text.matchAll(/https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)\b/g))
      refs.set(`${match[1]}#${match[2]}`, { repo: match[1], number: Number(match[2]) });
  }
  if (refs.size > 100) fail('SOURCE_REFERENCE_LIMIT', '本笔引用过多，需核对范围；不会静默截断');
  return [...refs.values()];
}
export function closureEvidence(events, prId, introduced) {
  return events.filter(
    (event) => (typeof prId === 'string' && event.closer?.id === prId) || introduced.includes(event.closer?.oid),
  );
}
export async function collectIssues(repo, pr, introduced, messages, notes = []) {
  const candidates = pr ? await closingIssues(repo, pr.number) : [];
  const byUrl = new Map(candidates.map((issue) => [issue.url, { issue, repo: issue.repository.nameWithOwner }]));
  // Mentions identify candidates only; actual ClosedEvent provenance decides closing.
  for (const reference of issueReferences([pr?.body ?? '', ...messages], repo)) {
    const url = `https://github.com/${reference.repo}/issues/${reference.number}`;
    if (byUrl.has(url)) continue;
    let issue;
    try {
      issue = await api(`repos/${reference.repo}/issues/${reference.number}`);
    } catch (error) {
      if (error.code !== 'GITHUB_REPOSITORY_UNAVAILABLE' || error.details?.httpStatus !== 404) throw error;
      notes.push({ ...reference, url, status: 'unresolved', reason: 'not-found-or-not-visible' });
      continue;
    }
    if (!issue.pull_request)
      byUrl.set(issue.html_url, { issue: { ...issue, id: issue.node_id, url: issue.html_url }, repo: reference.repo });
  }
  const issues = [];
  for (const { issue, repo: issueRepo } of byUrl.values()) {
    const detail = await api(`repos/${issueRepo}/issues/${issue.number}`);
    const events = await closedEvents(issue.id);
    const evidence = closureEvidence(events, pr?.node_id, introduced);
    issues.push({
      sourceId: issue.id,
      number: issue.number,
      url: issue.url,
      title: issue.title,
      body: detail.body ?? '',
      relation: evidence.length ? 'closes' : 'related',
      evidence,
    });
  }
  return issues;
}
