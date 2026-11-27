import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ProfileProvenanceCoordinate } from '@clowder-ai/plugin-memory-contract/profile';
import type { StoredProfileMemoryEntry } from './ProfileMemoryLifecycleStore.js';
import { LEGACY_PROFILE_CAPSULE_RELATIVE_PATH } from './profile-contract.js';
import { readProfileOpeningReference } from './profile-opening-reference.js';

export function readProfileProvenance(entry: StoredProfileMemoryEntry): ProfileProvenanceCoordinate[] {
  const opening = entry.layer === 'primer' ? readProfileOpeningReference(entry.content) : null;
  return [
    ...(opening?.excerpts.map((item, index) => ({
      ...item.source,
      label: `开场参考 ${index + 1} · ${item.kind === 'relationship' ? '陪伴与关系' : '历史能力判断'}`,
      occurredAt: null,
    })) ?? []),
    ...listTargetProvenance(entry),
  ];
}

function listTargetProvenance(entry: StoredProfileMemoryEntry): ProfileProvenanceCoordinate[] {
  const provenanceDir = join(entry.profileDir, 'provenance');
  if (!existsSync(provenanceDir)) return [];
  const result: ProfileProvenanceCoordinate[] = [];
  for (const file of readdirSync(provenanceDir, { withFileTypes: true })) {
    if (!file.isFile()) continue;
    const path = join(provenanceDir, file.name);
    let content: string;
    let modifiedAt: number;
    try {
      content = readFileSync(path, 'utf8');
      modifiedAt = statSync(path).mtimeMs;
    } catch {
      continue;
    }
    const fields = parseMetadata(content);
    if (
      fields.target !== entry.targetPath &&
      !(entry.layer === 'capsule' && fields.target === LEGACY_PROFILE_CAPSULE_RELATIVE_PATH)
    )
      continue;
    const threadId = fields.signalSourceThread ?? fields.thread;
    const messageId = fields.signalSourceMessage;
    result.push({
      ...(threadId ? { threadId } : {}),
      ...(messageId ? { messageId } : {}),
      occurredAt: Number.isFinite(modifiedAt) ? modifiedAt : null,
    });
  }
  return result;
}

function parseMetadata(content: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of content.split('\n')) {
    if (line.startsWith('## ')) break;
    const match = /^- ([A-Za-z][A-Za-z0-9]*): (.+)$/.exec(line);
    if (match) fields[match[1]] = match[2];
  }
  return fields;
}
