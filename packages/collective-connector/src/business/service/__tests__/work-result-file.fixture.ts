import { createHash } from 'node:crypto';
import { fixture } from './communication-acceptance.fixture.js';

const originalGuide = `# 共同作品接力指南

版本：第1版

## 目的

让每位伙伴清楚目标、分工与交接位置，把各自的贡献汇成可查看、可修改的共同作品。

## 协作步骤

1. 发起人说明要做什么、交给谁，以及期望结果。
2. 接手伙伴确认范围，制作初稿；遇到阻碍及时说明。
3. 交接时附上文件、版本和待确认问题。完成后，把结果贴这里。
4. 收到反馈后沿同一事项修订，注明改动，避免另起一份造成混淆。

## 完成标准

文件可打开或下载，内容符合约定，反馈已回应。提交初稿只是交付；由负责人确认接受当前版本，才算验收完成。
`;

export async function admittedWorkWithFileFixture() {
  const f = await fixture();
  await f.store.registerCollectiveWorkPolicy(f.owner.sessionToken, f.policyInput);
  const work = await f.store.acceptCollectiveWorkAsAgent(f.connection.endpointCredential, f.acceptance);
  await f.store.recordCollectiveWorkHostAdmission(f.connection.endpointCredential, {
    ...f.coordinates,
    connectionId: f.connection.connectionId,
    workId: work.workId,
    assignmentEventId: work.assignmentEventId,
    operationRef: f.acceptance.requestId,
    grantRef: 'grant-guides',
    grantRevision: 1,
    disposition: { state: 'admitted', receiptRef: 'host:result-file-task' },
  });
  const bytes = Buffer.from(originalGuide);
  const contentDigest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const fileName = `cwork-03661ad12b169a64f5324ec50603ed39-${contentDigest.slice('sha256:'.length)}.md`;
  const sourceHref = `/uploads/${fileName}`;
  const fileId = `wrf_${'c'.repeat(64)}`;
  const workResultFile = {
    v: 1 as const,
    fileId,
    sourceHref,
    fileName,
    mediaType: 'text/markdown' as const,
    contentDigest,
    byteLength: bytes.length,
    contentBase64: bytes.toString('base64'),
  };
  const legacyResult = {
    ...f.coordinates,
    connectionId: f.connection.connectionId,
    clientEventId: 'legacy-accepted-result',
    participationRevision: 1,
    agent: { agentId: 'codex-sol', catId: 'codex-sol', displayName: 'Sol', sessionRef: 'legacy-result-turn' },
    target: { kind: 'message' as const, eventId: work.assignmentEventId },
    replyToEventId: work.assignmentEventId,
    workResultIntent: {
      assignmentEventId: work.assignmentEventId,
      assignmentCatId: 'codex-sol',
      participationRevision: 1,
      resultRevision: 1,
    },
    body: `《共同作品接力指南》第1版：[打开或下载 Markdown 文件](${sourceHref})。`,
  };
  return { ...f, work, bytes, contentDigest, fileName, fileId, sourceHref, workResultFile, legacyResult };
}
