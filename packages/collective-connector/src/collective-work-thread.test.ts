import assert from "node:assert/strict";
import test from "node:test";
import { resolveCollectiveWorkThread, selectCollectiveWorkThread } from "./collective-work-thread.js";
import type { PluginTaskReadItem } from "@clowder-ai/plugin-sdk";

const source = { id: "assignment", userId: "owner", threadId: "public", content: "原请求" };
function work(overrides: Partial<PluginTaskReadItem> = {}): PluginTaskReadItem {
  return {
    id: "work",
    userId: "owner",
    kind: "work",
    threadId: "existing",
    ownerCatId: "cat",
    title: "Report",
    why: "Report",
    status: "todo",
    subjectKey: "entrusted:legacy",
    createdBy: "system",
    createdAt: 1,
    updatedAt: 1,
    entrustedWork: { revision: 1, admission: { sourceRefs: ["message:assignment"], authorityRef: "message:admission" }, closure: { state: "open" } },
    ...overrides,
  };
}
function controlled(overrides: Partial<NonNullable<NonNullable<PluginTaskReadItem['entrustedWork']>['dataController']>> = {}) {
  return {bindingRevision: 1, state: 'active' as const, currentForCaller:true, binding: {userId:'owner',catId:'cat',threadId:'existing',
    subjectKey:'entrusted:legacy',firstSourceRef:'message:assignment',admissionAuthorityRef:'message:admission',
    pluginId:'official.collective-connector',pluginInstanceId:'installed-collective',
    moduleRef:'plugin:official.collective-connector',lifecycleRevision:8,grantRevision:3,
    ownerOperationReceiptRef:`task-data-controller:${'a'.repeat(64)}`}, ...overrides};
}
function owned(overrides: Partial<PluginTaskReadItem> = {}): PluginTaskReadItem {
  const task = work(overrides);
  return {...task, entrustedWork: {...task.entrustedWork!,
    dataController: overrides.entrustedWork?.dataController ?? controlled()}};
}

test("a legacy source match without an active controller requires explicit owner adoption", () => {
  for (const createdBy of ["user", "cat", "system"]) {
    assert.throws(() => selectCollectiveWorkThread([work({createdBy})], source, "cat", "installed-collective"),
      {code:'OWNER_ADOPTION_REQUIRED'});
  }
});
test("an active matching controller returns the exact Task locator", () => {
  assert.deepEqual(selectCollectiveWorkThread([owned()], source, "cat", "installed-collective"), {
    kind: "existing", taskId:"work", taskRef:"task:work:work", threadId:"existing",
    subjectKey:"entrusted:legacy", dataControllerReceiptRef:`task-data-controller:${'a'.repeat(64)}`,
  });
});
test("foreign owner/cat/source rows never win the original selection", () => {
  const rows = [
    work({ userId: "foreign" }),
    work({ ownerCatId: "foreign" }),
    work({ entrustedWork: { revision: 1, admission: { sourceRefs: ["message:other"] }, closure: { state: "open" } } }),
  ];
  assert.deepEqual(selectCollectiveWorkThread(rows, source, "cat", "installed-collective"), {
    kind: "ensure",
    key: "collective-work:assignment:cat",
    input: { title: "原请求", parentThreadId: "public", participants: ["cat"] },
  });
});
test("multiple matching Works refuse instead of selecting the newest or an arbitrary thread", () => {
  assert.throws(
    () => selectCollectiveWorkThread([work(), work({ id: "second", threadId: "second-thread" })], source, "cat", "installed-collective"),
    { code: "WORK_SOURCE_AMBIGUOUS" },
  );
});
test("closed, revoked, and foreign-controller matches fail closed instead of becoming ensure plans", () => {
  assert.throws(() => selectCollectiveWorkThread([owned({status:'done'})], source, 'cat', 'installed-collective'),
    {code:'OWNER_TASK_UNAVAILABLE'});
  assert.throws(() => selectCollectiveWorkThread([owned({entrustedWork:{...owned().entrustedWork!,
    dataController:controlled({state:'revoked',revocationReceiptRef:`task-data-controller:${'b'.repeat(64)}`})}})],
    source, 'cat', 'installed-collective'), {code:'OWNER_ADOPTION_REQUIRED'});
  assert.throws(() => selectCollectiveWorkThread([owned({entrustedWork:{...owned().entrustedWork!,dataController:controlled({
    binding:{...controlled().binding,pluginId:'foreign.plugin',pluginInstanceId:'foreign-instance',moduleRef:'plugin:foreign.plugin'}})}})], source, 'cat', 'installed-collective'),
    {code:'OWNER_DATA_CONTROLLER_CONFLICT'});
  assert.throws(() => selectCollectiveWorkThread([owned({entrustedWork:{...owned().entrustedWork!,
    dataController:controlled({currentForCaller:false})}})], source, 'cat', 'installed-collective'),
    {code:'OWNER_ADOPTION_REQUIRED'});
  assert.throws(() => selectCollectiveWorkThread([owned({entrustedWork:{...owned().entrustedWork!,
    dataController:controlled({currentForCaller:false,binding:{...controlled().binding,pluginInstanceId:'previous-instance'}})}})],
    source, 'cat', 'installed-collective'), {code:'OWNER_ADOPTION_REQUIRED'});
});
test("the first child keeps the original UTF16 slice, parent, sole participant and deterministic key", () => {
  const long = { ...source, content: "😀".repeat(81) };
  const plan = selectCollectiveWorkThread([], long, "cat", "installed-collective");
  assert.equal(plan.kind, "ensure");
  if (plan.kind !== "ensure") throw new Error("Expected child site");
  assert.equal(plan.input.title, long.content.slice(0, 160));
  assert.equal(plan.input.title.length, 160);
  assert.equal(plan.input.parentThreadId, source.threadId);
  assert.deepEqual(plan.input.participants, ["cat"]);
  assert.equal(plan.key, "collective-work:assignment:cat");
  assert.deepEqual(selectCollectiveWorkThread([], long, "cat", "installed-collective"), plan);
});
test("a selection is a detached plan and performs no Thread or Task mutation", () => {
  const rows = [owned()],
    before = structuredClone(rows);
  const plan = selectCollectiveWorkThread(rows, source, "cat", "installed-collective");
  assert.deepEqual(rows, before);
  assert.notEqual(plan, rows[0]);
  const child = selectCollectiveWorkThread([], source, "cat", "installed-collective");
  assert.ok(Object.isFrozen(child));
  if (child.kind === "ensure") assert.ok(Object.isFrozen(child.input.participants));
});

test("the resolver consumes the stored exact locator first and never creates or scans for an adopted Work", async () => {
  const calls: unknown[] = [];
  const threads = {
    async get(id: string) {
      calls.push(["get", id]);
      return {
        id,
        deepLinkUrl: "https://owner.example/thread/existing",
        title: null,
        createdAt: 1,
        lastActiveAt: 1,
        preferredCats: [],
        featureRefs: [],
      };
    },
    async create() {
      throw new Error("Existing Work must not create another child");
    },
  };
  const tasks = {
    async get(selector: {id: string}) {calls.push(['task.get',selector.id]);return owned();},
    async list({kind}: {kind?: string}) {
      calls.push(["tasks", kind]);
      return [owned()];
    },
  };
  const storage = memoryStorage({binding:{taskRef:'task:work:work',taskRevision:2,threadId:'existing',
    admissionRef:'message:assignment',executionRef:'message:assignment',refScope:'scope',
    dataControllerReceiptRef:`task-data-controller:${'a'.repeat(64)}`}});
  assert.deepEqual(await resolveCollectiveWorkThread(threads, tasks, source, "cat", "installed-collective", storage), {
    kind:'existing',taskId:'work',taskRef:'task:work:work',threadId:'existing',subjectKey:'entrusted:legacy',
    dataControllerReceiptRef:`task-data-controller:${'a'.repeat(64)}`,
  });
  assert.deepEqual(calls, [
    ['task.get','work'],
    ["get", "existing"],
  ]);
  await assert.rejects(resolveCollectiveWorkThread(threads, {...tasks,get:async()=>null}, source, "cat",
    "installed-collective", storage), {
    code: "OWNER_TASK_LOCATOR_UNAVAILABLE",
  });
  await assert.rejects(resolveCollectiveWorkThread(threads, {...tasks,get:async()=>owned({userId:'foreign'})}, source,
    "cat", "installed-collective", storage), {code:"OWNER_TASK_UNAVAILABLE"});
});

test("the resolver forwards only original child intent to approved ensure and preserves ambiguity refusal before effects", async () => {
  const calls: unknown[] = [];
  const threads = {
    async get() {
      return {id:"canonical-child",title:null,deepLinkUrl:"/thread/canonical-child",createdAt:0,lastActiveAt:0,preferredCats:[],featureRefs:[]};
    },
    async create(input: unknown) {
      calls.push(input);
      return {
        id: "canonical-child",
        deepLinkUrl: "https://owner.example/thread/child",
        title: null,
        createdAt: 1,
        lastActiveAt: 1,
        preferredCats: [],
        featureRefs: [],
      };
    },
  };
  assert.deepEqual(
    await resolveCollectiveWorkThread(threads, { get:async()=>null,list: async () => [] }, source, "cat",
      "installed-collective", memoryStorage()),
    {kind:'ensure',threadId:"canonical-child",subjectKey:'collective-work:assignment:cat'},
  );
  assert.deepEqual(calls, [
    {
        title: "原请求",
        parentThreadId: "public",
        participants: ["cat"],
      },
  ]);
  await assert.rejects(
    resolveCollectiveWorkThread(threads, {get:async()=>null, list: async () => [work(), work()] }, source, "cat",
      "installed-collective", memoryStorage()),
    { code: "WORK_SOURCE_AMBIGUOUS" },
  );
  assert.equal(calls.length, 1);
});

function memoryStorage(value?: unknown): Pick<import('@clowder-ai/plugin-sdk').PluginStorageHost,'get'|'compareAndSet'> {
 let entry: {revision:number;value:unknown}|undefined = value === undefined ? undefined : {revision:1,value:{v:1,
  ownerUserId:'owner',source:{id:'assignment',revision:'revision',threadId:'public',bodyDigest:'a'.repeat(64),identity:{
    serviceInstanceId:'svc_12345678',collectiveId:'col_12345678',connectionId:'con_12345678',eventId:'evt_12345678',catId:'cat',
    participationRevision:1,location:{channelId:'channel'},actor:{kind:'human',humanId:'human_12345678',displayName:'Human'}}},
  work:{workId:'work_12345678',assignmentEventId:'evt_12345678',resultRevision:1,executionRevision:1,intendedOutcomeDigest:'b'.repeat(64)},
  basis:{kind:'standing_grant',producer:'standing_work',grantRef:'grant',grantRevision:1,scope:{requestingHumanIds:['human_12345678'],channelIds:['channel'],expiresAt:null}},
  ...(value as object)}};
 return {async get(){return entry;},async compareAndSet(_key,expected,value){if((entry?.revision??null)!==expected)return {applied:false};entry={revision:(entry?.revision??0)+1,value:structuredClone(value)};return {applied:true,revision:entry.revision};}};
}
