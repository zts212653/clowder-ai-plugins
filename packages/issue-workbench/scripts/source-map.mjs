const web = 'packages/web/src/components/settings/issue-workbench/';
const api = 'packages/api/src/domains/community/';
function once(text, from, to) {
  if (text.split(from).length !== 2) throw new Error(`Source seam changed; review export mapping: ${from.slice(0, 90)}`);
  return text.replace(from, to);
}
const shared = path => text => text.replaceAll("'@cat-cafe/shared'", `'${path}'`);
function ui(name, text) {
  text = shared('../model/issue-source.js')(text);
  if (name === 'IssueWorkbenchPreview.tsx') {
    text = once(text, "import { useConfirm } from '../../useConfirm';", "import { useConfirm, useSourceClient } from '../ports/context';");
    text = once(text, '  STORAGE_KEY,\n', '');
    text = once(text, '  const confirm = useConfirm();', '  const confirm = useConfirm();\n  const { repo, storage: localStorage, storageKey: STORAGE_KEY, openSettings } = useSourceClient();');
    text = once(text, '<span>zts212653 / clowder-ai</span>', '<span>{repo.replace(\'/\', \' / \')}</span>');
    text = once(text, '<a href="/settings?s=plugins" target="_blank" rel="noreferrer">\n                GitHub 登录设置\n              </a>', '<button type="button" disabled={!openSettings} onClick={openSettings}>GitHub 登录设置</button>');
  }
  if (name === 'workbench-model.ts') text = once(text, "assignee: '砚砚',", "assignee: '',");
  if (name === 'IssueDetail.tsx') {
    text = "import { useSourceClient } from '../ports/context';\n" + text;
    text = once(text, '  const [reading, setReading] = useState(fact);', '  const { draftAssignees = [] } = useSourceClient();\n  const [reading, setReading] = useState(fact);');
    text = once(text, '<option>砚砚</option>\n                <option>月野兔</option>\n                <option>砚砚与月野兔共同讨论</option>', '<option value="">待选择目标</option>\n                {draftAssignees.map(name => <option key={name}>{name}</option>)}');
  }
  if (name === 'useIssueSource.ts') {
    text = once(text, "import { ISSUE_REPO, sourceFetch } from './source-client';", "import { useSourceClient } from './source-client';");
    const initial = text.slice(text.indexOf('const initial:'), text.indexOf('const freshness'));
    text = once(text, initial, '');
    text = once(text, 'export function useIssueSource(active: boolean, selected: number | null) {', 'export function useIssueSource(active: boolean, selected: number | null) {\n  const { repo: ISSUE_REPO, fetch: sourceFetch } = useSourceClient();\n' + initial);
    text = once(text, '  }, []);\n  useEffect(() => {\n    alive.current', '  }, [ISSUE_REPO, sourceFetch]);\n  useEffect(() => {\n    alive.current');
    text = once(text, '  }, [active, refresh]);', '  }, [active, refresh, ISSUE_REPO, sourceFetch]);');
  }
  if (name === 'useIssueDetail.ts') {
    text = once(text, "import { refreshRequest, SOURCE_QUERY, sourceFetch } from './source-client';", "import { refreshRequest, useSourceClient } from './source-client';");
    text = once(text, 'export function useIssueDetail(number: number | undefined, active: boolean) {', 'export function useIssueDetail(number: number | undefined, active: boolean) {\n  const { sourceQuery: SOURCE_QUERY, fetch: sourceFetch } = useSourceClient();');
    text = once(text, '[number, active, apply]', '[number, active, apply, SOURCE_QUERY, sourceFetch]');
    text = once(text, '[number, active, refresh, apply]', '[number, active, refresh, apply, SOURCE_QUERY, sourceFetch]');
    text = once(text, '    [number],', '    [number, SOURCE_QUERY, sourceFetch],');
  }
  return text;
}
export const mappings = [
  { source: 'packages/shared/src/issue-coordination.ts', target: 'src/model/issue-coordination.ts', transform: x => x },
  ...['IssueCoordinationStore.ts','IssueCoordinationService.ts'].map(name => ({ source: api + name, target: 'src/source/' + name,
    transform: text => text.replaceAll("'../../../../shared/src/issue-coordination.js'", "'../model/issue-coordination.js'").replaceAll("'@cat-cafe/shared'", "'../model/issue-source.js'") })),
  ...['IssueClassifications.tsx','classifications.module.css','CoordinationWorkbench.tsx','CoordinationSources.tsx','CoordinationEditor.tsx','CoordinationLinks.tsx','IssueRelationPicker.tsx','CoordinationReading.tsx','coordination.module.css'].map(name => ({ source: web + name, target: 'src/ui/' + name,
    transform: text => text.replaceAll("'@cat-cafe/shared'", "'../model/issue-coordination.js'") })),
  { source: 'packages/api/test/issue-coordination.test.ts', target: 'test/source/issue-coordination.test.ts', transform: text => text
    .replaceAll("'../src/domains/community/", "'../../src/source/").replaceAll("'../../shared/src/", "'../../src/model/") },
  { source: 'packages/shared/src/issue-source.ts', target: 'src/model/issue-source.ts', transform: x => x },
  ...['FileIssueSourceStore.ts','IssueSourceService.ts','GhIssueSourceReader.ts'].map(name => ({
    source: api + name, target: 'src/source/' + name, transform(text) {
      text = shared('../model/issue-source.js')(text);
      if (name === 'GhIssueSourceReader.ts') {
        text = once(text, "import { execFile } from 'node:child_process';\nimport { promisify } from 'node:util';\n", '');
        text = once(text, "import { buildGhCliEnv, withHiddenGhCliWindow } from '../../infrastructure/github/gh-cli-env.js';\n\nconst execute = promisify(execFile);\n", '');
        const start = text.indexOf('export function createGhQuery('); const end = text.indexOf('export function failure(');
        if (start < 0 || end <= start) throw new Error('GitHub execution seam changed');
        text = text.slice(0,start) + text.slice(end);
        text = once(text, 'query: GhQuery = createGhQuery()', 'query: GhQuery');
      }
      return text;
    }
  })),
  ...['IssueWorkbenchPreview.tsx','IssueDetail.tsx','IssueDiscussion.tsx','IssueList.tsx','IssueStageFlow.tsx','LabelBatchPreview.tsx','SourceEvidence.tsx','workbench-model.ts','workbench.module.css','useIssueSource.ts','useIssueDetail.ts'].map(name => ({
    source: web + name, target: 'src/ui/' + name, transform: text => ui(name,text)
  })),
  { source: web + 'source-client.ts', target: 'src/ui/source-client.ts', transform(text) {
    const start = text.indexOf('export const refreshRequest');
    if (start < 0) throw new Error('Source client seam changed');
    return "export { useSourceClient } from '../ports/context';\n" + text.slice(start);
  }},
  ...['workbench-model.test.ts','issue-discussion.test.tsx','source-loading.test.tsx','issue-source-refresh.test.tsx','detail-races.test.tsx'].map(name => ({
    source: web + '__tests__/' + name, target: 'test/ui/' + name, transform(text) {
      text = shared('../../src/model/issue-source.js')(text).replaceAll("from '../", "from '../../src/ui/");
      text = text.replace("import { createRoot } from 'react-dom/client';", "import { createRoot } from '../ui-root';");
      text = text.replace("import { createRoot, type Root } from 'react-dom/client';", "import type { Root } from 'react-dom/client';\nimport { createRoot } from '../ui-root';");
      return text;
    }
  })),
  ...['issue-source.test.ts','issue-source-loading.test.ts','issue-source-reader.test.ts'].map(name => ({
    source: 'packages/api/test/' + name, target: 'test/source/' + name, transform(text) {
      text = shared('../../src/model/issue-source.js')(text).replaceAll('../src/domains/community/', '../../src/source/');
      if (name === 'issue-source-loading.test.ts') {
        const start = text.indexOf("test('archive pages stay pinned after remote edit and enforce repo/version/owner guards'");
        const end = text.indexOf("test('a late legacy migration cannot replace a newer catalog'");
        if (start < 0 || end <= start) throw new Error('Core route test boundary changed');
        text = text.slice(0, start) + text.slice(end);
      }
      if (name === 'issue-source-reader.test.ts') {
        const boundary = text.indexOf("test('durable source route");
        if (boundary < 0) throw new Error('Core route test boundary changed');
        text = text.slice(0, boundary);
        for (const line of ["import { mkdtemp, rm } from 'node:fs/promises';\n", "import { tmpdir } from 'node:os';\n", "import { join } from 'node:path';\n", "import Fastify from 'fastify';\n", "import { FileIssueSourceStore } from '../../src/source/FileIssueSourceStore.js';\n", "import { IssueSourceService } from '../../src/source/IssueSourceService.js';\n", "import { issueSourceRoutes } from '../src/routes/issue-source.js';\n"]) text = once(text,line,'');
      }
      return text;
    }
  }))
];
