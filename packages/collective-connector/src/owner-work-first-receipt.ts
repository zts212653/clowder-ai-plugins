import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { PluginStorageHost } from "@clowder-ai/plugin-sdk";
import { z } from "zod";
import { collectiveSourceIdentitySchema, collectiveStandingWorkSchema } from "./business/contracts/index.js";

const ref = z.string().min(1).max(1_000);
const revision = z.number().int().positive();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const bindingSchema = z.object({
  taskRef: ref.regex(/^task:work:/), taskRevision: revision, threadId: ref,
  admissionRef: ref.regex(/^message:/), executionRef: ref.regex(/^message:/), refScope: ref,
  // Old receipts may already name a Task but cannot authorize the new
  // controller path until a Host-owned receipt is attached by owner adoption.
  dataControllerReceiptRef: ref.regex(/^task-data-controller:[a-f0-9]{64}$/).optional(),
}).strict();
const commonReceipt = z.object({
  v: z.literal(1),
  ownerUserId: ref,
  source: z.object({id: ref, revision: ref, threadId: ref, bodyDigest: digest,
    identity: collectiveSourceIdentitySchema}).strict(),
  work: z.object({workId: ref, assignmentEventId: ref, resultRevision: revision,
    executionRevision: revision, intendedOutcomeDigest: digest}).strict(),
  binding: bindingSchema.optional(),
}).strict();
const manualReceiptSchema = commonReceipt.extend({
  // HTTP authenticates the click. The package explicitly chooses manual.
  basis: z.object({kind: z.literal("manual_owner_write")}).strict(),
  pluginInstanceId: ref,
  firstRequest: z.object({requestId: ref, contributionId: ref, method: ref, path: ref,
    bodyDigest: digest, queryDigest: digest}).strict(),
}).strict();
const standingReceiptSchema = commonReceipt.extend({
  // These are actual registered Service/Connector facts, not a grant issued by
  // this private container or inferred from Host entry provenance.
  basis: z.object({kind: z.literal("standing_grant"), producer: z.literal("registered_work"),
    grantRef: ref, grantRevision: revision, requestKind: ref, operationRef: ref,
    originalSource: collectiveSourceIdentitySchema, expiresAt: z.string().datetime().nullable()}).strict(),
}).strict();
const humanStandingReceiptSchema = commonReceipt.extend({
  basis: z.object({kind: z.literal("standing_grant"), producer: z.literal("standing_work"),
    grantRef: ref, grantRevision: revision, scope: collectiveStandingWorkSchema}).strict(),
}).strict();
const firstReceiptSchema = z.union([manualReceiptSchema, standingReceiptSchema, humanStandingReceiptSchema]);
const continuedReceiptSchema = commonReceipt.extend({
  kind: z.literal("continued_execution"), firstSourceMessageId: ref,
  basis: standingReceiptSchema.shape.basis,
}).strict();
// An assignment lineage is deliberately not a standing-grant receipt. The
// current continued receipt supplies permission; both bind the same first Task.
const bootstrapLineageSchema = commonReceipt.extend({
  kind: z.literal("bootstrap_lineage"), bootstrapSourceMessageId: ref,
}).strict();
const lineageSchema = z.union([firstReceiptSchema, bootstrapLineageSchema]);
const storedReceiptSchema = z.union([firstReceiptSchema, continuedReceiptSchema, bootstrapLineageSchema]);
export type BootstrapWorkLineageReceipt = z.infer<typeof bootstrapLineageSchema>;
export type WorkLineageReceipt = z.infer<typeof lineageSchema>;
export const isBootstrapWorkLineage = (receipt: WorkLineageReceipt): receipt is BootstrapWorkLineageReceipt =>
  "kind" in receipt && receipt.kind === "bootstrap_lineage";
export type ContinuedWorkExecutionReceipt = z.infer<typeof continuedReceiptSchema>;
export type ManualWorkFirstReceipt = z.infer<typeof manualReceiptSchema>;
export type StandingWorkFirstReceipt = z.infer<typeof standingReceiptSchema> | z.infer<typeof humanStandingReceiptSchema>;
export type WorkFirstReceipt = z.infer<typeof firstReceiptSchema>;
export type ManualWorkExecutionBinding = z.infer<typeof bindingSchema>;
export const workReceiptDigest = (value: string) => createHash("sha256").update(value).digest("hex");
const conflict = () => Object.assign(new Error("The first owner Work receipt names another choice or execution"), {
  code: "OWNER_ADMISSION_CONFLICT",
});

/** Move the original immutable first-source/Cat receipt into the existing private
 * storage container. Hashes only bound its key/content; no hash issues permission.
 * Canonical Connector v3, Service hostAdmissions and Host Task records are untouched. */
export function manualWorkFirstReceiptKey(owner: string, source: string, cat: string) {
  // The Host already scopes this container to the plugin. A new authenticated
  // instance must find the original choice, not create a parallel first receipt.
  return "collective-owner-admission:" + workReceiptDigest(JSON.stringify([owner, source, cat]));
}

/** A private native consumer reads the original package receipt, never infers a
 * business basis from the Host's entry provenance or Task.createdBy. */
export async function readManualWorkFirstReceipt(
  storage: Pick<PluginStorageHost, "get">,
  instance: string,
  owner: string,
  source: string,
  cat: string,
) {
  const parsed = await readWorkFirstReceipt(storage, owner, source, cat);
  if (!parsed) return undefined;
  if (!("pluginInstanceId" in parsed) || parsed.pluginInstanceId !== instance) throw conflict();
  return parsed;
}

export async function readWorkFirstReceipt(
  storage: Pick<PluginStorageHost, "get">, owner: string, source: string, cat: string,
) {
  const entry = await storage.get(manualWorkFirstReceiptKey(owner, source, cat));
  if (!entry) return undefined;
  const parsed = firstReceiptSchema.safeParse(entry.value);
  if (!parsed.success || parsed.data.ownerUserId !== owner ||
    parsed.data.source.id !== source || parsed.data.source.identity.catId !== cat) throw conflict();
  return parsed.data;
}

/** Later executions refer to the immutable first choice; they never replace it.
 * The same plugin-private receipt container and source/Cat key are reused. */
export async function readWorkExecutionReceipt(
  storage: Pick<PluginStorageHost, "get">, owner: string, source: string, cat: string,
) {
  const entry = await storage.get(manualWorkFirstReceiptKey(owner, source, cat));
  if (!entry) return undefined;
  const parsed = z.union([firstReceiptSchema, continuedReceiptSchema]).safeParse(entry.value);
  if (!parsed.success || parsed.data.ownerUserId !== owner ||
    parsed.data.source.id !== source || parsed.data.source.identity.catId !== cat) throw conflict();
  return parsed.data;
}

/** Native bootstrap reads a relation, then reads the separate current grant
 * receipt. Old first-only and execution-only readers still reject this variant. */
export async function readWorkStoredReceipt(
  storage: Pick<PluginStorageHost, "get">, owner: string, source: string, cat: string,
) {
  const entry = await storage.get(manualWorkFirstReceiptKey(owner, source, cat));
  if (!entry) return undefined;
  const parsed = storedReceiptSchema.safeParse(entry.value);
  if (!parsed.success || parsed.data.ownerUserId !== owner || parsed.data.source.id !== source ||
    parsed.data.source.identity.catId !== cat) throw conflict();
  return parsed.data;
}
export async function readWorkLineageReceipt(
  storage: Pick<PluginStorageHost, "get">, owner: string, source: string, cat: string,
) {
  const stored = await readWorkStoredReceipt(storage, owner, source, cat);
  if (!stored) return undefined;
  const parsed = lineageSchema.safeParse(stored);
  if (!parsed.success) throw conflict();
  return parsed.data;
}
export async function retainBootstrapWorkLineage(
  storage: Pick<PluginStorageHost, "get" | "compareAndSet">,
  selected: Omit<BootstrapWorkLineageReceipt, "binding">,
  current: () => Promise<void>,
) {
  const expected = bootstrapLineageSchema.parse(selected);
  if (expected.bootstrapSourceMessageId === expected.source.id ||
    expected.work.executionRevision !== 1 || expected.work.resultRevision !== 1) throw conflict();
  return retainExecutionRelation(storage, bootstrapLineageSchema, expected, current);
}

export async function retainWorkContinuationReceipt(
  storage: Pick<PluginStorageHost, "get" | "compareAndSet">,
  selected: Omit<ContinuedWorkExecutionReceipt, "binding">,
  current: () => Promise<void>,
) {
  const expected = continuedReceiptSchema.parse(selected);
  if (expected.firstSourceMessageId === expected.source.id || expected.work.executionRevision <= 1) throw conflict();
  return retainExecutionRelation(storage, continuedReceiptSchema, expected, current);
}
async function retainExecutionRelation<T extends ContinuedWorkExecutionReceipt | BootstrapWorkLineageReceipt>(
  storage: Pick<PluginStorageHost, "get" | "compareAndSet">, schema: z.ZodType<T>, expected: T,
  current: () => Promise<void>,
) {
  const key = manualWorkFirstReceiptKey(expected.ownerUserId, expected.source.id, expected.source.identity.catId);
  const read = async () => {
    await current(); const entry = await storage.get(key); await current();
    if (!entry) return undefined;
    const parsed = schema.safeParse(entry.value);
    if (!parsed.success) throw conflict();
    const facts = {...parsed.data}; delete facts.binding;
    const selectedFacts = {...expected}; delete selectedFacts.binding;
    if (!isDeepStrictEqual(facts, selectedFacts)) throw conflict();
    return {entry, receipt: parsed.data};
  };
  if (!(await read())) {
    await current(); await storage.compareAndSet(key, null, expected);
    if (!(await read())) throw conflict();
  }
  return Object.freeze({
    async readBinding() {const value = await read(); if (!value) throw conflict(); return value.receipt.binding;},
    async bind(raw: ManualWorkExecutionBinding) {
      const binding = bindingSchema.parse(raw), before = await read(); if (!before) throw conflict();
      if (!before.receipt.binding) {
        await current(); await storage.compareAndSet(key, before.entry.revision, {...before.receipt, binding});
      } else if (bindingControllerUpgrade(before.receipt.binding, binding)) {
        await current(); await storage.compareAndSet(key, before.entry.revision, {...before.receipt, binding});
      }
      const bound = await read(); if (!bound || !isDeepStrictEqual(bound.receipt.binding, binding)) throw conflict();
      return bound.receipt;
    },
    async assertBound(binding: ManualWorkExecutionBinding) {
      const actual = await read(); if (!actual || !isDeepStrictEqual(actual.receipt.binding, binding)) throw conflict();
    },
  });
}

export async function retainManualWorkFirstReceipt(
  storage: Pick<PluginStorageHost, "get" | "compareAndSet">,
  selected: Omit<ManualWorkFirstReceipt, "binding">,
  current: () => Promise<void>,
  hasExistingTask: boolean,
) {
  return retainWorkFirstReceipt(storage, selected, current, hasExistingTask);
}

export async function retainWorkFirstReceipt(
  storage: Pick<PluginStorageHost, "get" | "compareAndSet">,
  selected: Omit<ManualWorkFirstReceipt, "binding"> | Omit<StandingWorkFirstReceipt, "binding">,
  current: () => Promise<void>, hasExistingTask: boolean,
) {
  const expected = firstReceiptSchema.parse(selected);
  const key = manualWorkFirstReceiptKey(expected.ownerUserId, expected.source.id, expected.source.identity.catId);
  const read = async () => {
    await current();
    const entry = await storage.get(key);
    await current();
    if (!entry) return undefined;
    const parsed = firstReceiptSchema.safeParse(entry.value);
    if (!parsed.success) throw conflict();
    const facts = { ...parsed.data };
    delete facts.binding;
    if ("firstRequest" in facts) delete (facts as Partial<ManualWorkFirstReceipt>).firstRequest;
    const selectedFacts = { ...expected };
    delete selectedFacts.binding;
    if ("firstRequest" in selectedFacts) delete (selectedFacts as Partial<ManualWorkFirstReceipt>).firstRequest;
    // A later authenticated HTTP descriptor never rewrites the first descriptor.
    if (!isDeepStrictEqual(facts, selectedFacts)) throw conflict();
    return {entry, receipt: parsed.data};
  };
  let first = await read();
  if (!first) {
    // A surviving Task without its original receipt is a migration/recovery gap,
    // never evidence that its original basis was manual. The only repair path
    // carries an exact current Host controller locator derived after explicit
    // owner adoption and current Service revalidation.
    if (hasExistingTask && !expected.binding?.dataControllerReceiptRef) throw conflict();
    await current();
    await storage.compareAndSet(key, null, expected);
    first = await read();
    if (!first) throw conflict();
  }
  return Object.freeze({
    async readBinding() {
      const actual = await read();
      if (!actual) throw conflict();
      return actual.receipt.binding;
    },
    async bind(raw: ManualWorkExecutionBinding) {
      const binding = bindingSchema.parse(raw);
      const before = await read();
      if (!before) throw conflict();
      if (!before.receipt.binding) {
        await current();
        await storage.compareAndSet(key, before.entry.revision, {...before.receipt, binding});
      } else if (bindingControllerUpgrade(before.receipt.binding, binding)) {
        await current();
        await storage.compareAndSet(key, before.entry.revision, {...before.receipt, binding});
      }
      const bound = await read();
      if (!bound || !isDeepStrictEqual(bound.receipt.binding, binding)) throw conflict();
      return bound.receipt;
    },
    async assertBound(binding: ManualWorkExecutionBinding) {
      const actual = await read();
      if (!actual || !isDeepStrictEqual(actual.receipt.binding, binding)) throw conflict();
    },
  });
}

function bindingControllerUpgrade(before: ManualWorkExecutionBinding, after: ManualWorkExecutionBinding) {
  if (after.dataControllerReceiptRef === undefined || after.dataControllerReceiptRef === before.dataControllerReceiptRef ||
    after.taskRevision <= before.taskRevision) return false;
  const {taskRevision: _beforeRevision,dataControllerReceiptRef: _beforeController,...beforeIdentity} = before;
  const {taskRevision: _afterRevision,dataControllerReceiptRef: _afterController,...afterIdentity} = after;
  return isDeepStrictEqual(beforeIdentity,afterIdentity);
}
