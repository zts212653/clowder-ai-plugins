import type { CompanionCommand, CompanionEvent, CompanionReply } from '../generated/contract.generated.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const schema = require('@clowder-ai/plugin-contract/schemas/companion-bridge') as Record<string, unknown>;
interface Validator { (value: unknown): boolean; }
interface AjvInstance { addSchema(schema: Record<string, unknown>): void; compile(schema: Record<string, unknown>): Validator; }
const Ajv: new (options: Record<string, unknown>) => AjvInstance = require('ajv/dist/2020');
const formats: (ajv: AjvInstance) => void = require('ajv-formats');
const ajv = new Ajv({ strict: false, allErrors: false, ownProperties: true });
formats(ajv); ajv.addSchema(schema);
const command = ajv.compile({ $ref: `${schema.$id}#/$defs/CompanionCommand` });
const reply = ajv.compile({ $ref: `${schema.$id}#/$defs/CompanionReply` });
const event = ajv.compile({ $ref: `${schema.$id}#/$defs/CompanionEvent` });

function bounded(value: unknown): boolean {
  try { const json = JSON.stringify(value); return typeof json === 'string' && Buffer.byteLength(json) <= 1_500_000; }
  catch { return false; }
}
/** Structural validation never substitutes for a current Host lease or a user gesture. */
export function validateCompanionCommand(value: unknown): value is CompanionCommand {
  if (!bounded(value) || !command(value)) return false;
  const parsed = value as CompanionCommand;
  if (parsed.kind === 'text') return parsed.text.trim().length > 0;
  if (parsed.kind === 'screen.frame') return /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(parsed.frame.image);
  return true;
}
export function validateCompanionReply(value: unknown): value is CompanionReply {
  if (!bounded(value) || !reply(value)) return false;
  const parsed = value as CompanionReply;
  if (parsed.kind === 'conversation') return parsed.messages.every((message) => {
    const identity = message.companionIdentity;
    return identity === undefined || identity.partner.catId === identity.deep.catId;
  });
  if (parsed.kind === 'transcript') {
    if (new Set(parsed.rows.map((row) => row.messageId)).size !== parsed.rows.length) return false;
    if (parsed.rows.reduce((total, row) => total + row.text.length, 0) > 24000) return false;
    return parsed.rows.every((row) => row.source.kind === 'voice'
      ? row.source.realtimeSessionId === parsed.scope.realtimeSessionId
      : row.source.callId === parsed.scope.callId);
  }
  if (parsed.kind === 'settings') {
    if (parsed.status === 'unavailable') return true;
    if (new Set(parsed.companions.map((entry) => entry.catProfileId)).size !== parsed.companions.length) return false;
    const selected = parsed.companions.find((entry) => entry.catProfileId === parsed.values.dutyCatProfileId);
    return (selected?.available === true) === (parsed.selectedCompanionStatus === 'available');
  }
  if (parsed.kind === 'settings-update') {
    const stopsCall = parsed.field === 'dutyCatProfileId' || parsed.field === 'householdReadsAllowed';
    if (!stopsCall && parsed.callStatus !== 'unchanged') return false;
    if (parsed.outcome === 'saved') {
      return parsed.field === 'personaTone' ? parsed.applies === 'next_call' : parsed.applies === 'now';
    }
    if (parsed.outcome === 'rejected') {
      return (parsed.callStatus === 'stop_failed') === (parsed.reason === 'call_stop_failed');
    }
    return true;
  }
  if (parsed.kind === 'decisions') {
    if (!('version' in parsed)) return true;
    const variantRefs = parsed.items.map((item) => item.variantRef);
    if (new Set(variantRefs).size !== variantRefs.length) return false;
    if (parsed.items.some((item) => new Set(item.navigation.targets).size !== item.navigation.targets.length)) {
      return false;
    }
    if (parsed.items.length > parsed.page.limit) return false;
    if (parsed.page.hasMore && parsed.items.length !== parsed.page.limit) return false;
    const sources = Object.values(parsed.sources);
    if (sources.some((source) => source.status !== 'available' && source.coverage !== 'unknown')) return false;
    const complete = sources.every((source) => source.status === 'available' && source.coverage === 'complete');
    const anyAvailable = sources.some((source) => source.status === 'available');
    if (parsed.status === 'available' && !complete) return false;
    if (parsed.status === 'partial' && (!anyAvailable || complete)) return false;
    if (parsed.status === 'unavailable' && (anyAvailable || parsed.items.length > 0 || parsed.page.hasMore)) return false;
    if (parsed.totalCount !== undefined) {
      if (parsed.status !== 'available' || !complete || parsed.totalCount < parsed.items.length) return false;
      const expectedRows = Math.min(parsed.page.limit, Math.max(0, parsed.totalCount - parsed.page.offset));
      if (parsed.items.length !== expectedRows) return false;
      const knownEnd = parsed.page.offset + parsed.items.length;
      if (parsed.page.hasMore !== (knownEnd < parsed.totalCount)) return false;
    }
    return true;
  }
  if (parsed.kind !== 'state') return true;
  if (parsed.audio) {
    if (!parsed.audio.supportedModes.includes('duplex')) return false;
    if (parsed.audio.activeMode !== null && !parsed.audio.supportedModes.includes(parsed.audio.activeMode)) return false;
    if ((parsed.phase === 'talking') !== (parsed.audio.activeMode !== null)) return false;
  }
  const work = parsed.nativeWork;
  if (work.scopeId === null && (work.active.length > 0 || work.recent.length > 0)) return false;
  if (new Set(work.active.map((entry) => entry.taskId)).size !== work.active.length) return false;
  if (new Set(work.recent.map((event) => event.eventId)).size !== work.recent.length) return false;
  if (work.active.some((entry) => entry.expiresAt <= entry.startedAt)) return false;
  return work.recent.every((event) => {
    if (event.expiresAt <= event.occurredAt) return false;
    const handed = event.phase === 'result_handed_to_voice';
    const result = event.kind === 'result';
    const attributed = event.resultId !== undefined && event.nativeCarrierCatId !== undefined;
    return handed === result && result === attributed;
  });
}
export function validateCompanionEvent(value: unknown): value is CompanionEvent { return bounded(value) && event(value); }
