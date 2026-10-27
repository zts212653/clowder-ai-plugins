import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';
import {
  type IssueSourceFact,
  type IssueSourceSnapshot,
  issueCatalogFact,
  issueReviewContent,
  issueSourceContent,
} from '../model/issue-source.js';
import type { IssueSourceStore } from './IssueSourceService.js';

const zip = promisify(gzip);
const unzip = promisify(gunzip);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
/** Durable index plus immutable compressed source versions. No TTL or data eviction. */
export class FileIssueSourceStore implements IssueSourceStore {
  constructor(private readonly directory: string) {}
  private key(repo: string) {
    return hash(repo);
  }
  private catalog(repo: string) {
    return join(this.directory, `${this.key(repo)}.catalog.json`);
  }
  async read(repo: string): Promise<IssueSourceSnapshot | null> {
    try {
      const snapshot = JSON.parse(await readFile(this.catalog(repo), 'utf8')) as IssueSourceSnapshot;
      if (snapshot.repo !== repo || !Array.isArray(snapshot.issues) || !Number.isSafeInteger(snapshot.revision))
        throw new Error('Invalid source snapshot');
      return snapshot;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    // One-time, non-destructive migration. The previous file remains recoverable.
    let legacy: IssueSourceSnapshot;
    try {
      legacy = JSON.parse(await readFile(join(this.directory, `${this.key(repo)}.json`), 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    if (legacy.repo !== repo || !Array.isArray(legacy.issues)) throw new Error('Invalid legacy source');
    await this.write(legacy, true);
    return this.read(repo);
  }
  async write(snapshot: IssueSourceSnapshot, onlyIfMissing = false) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const issues: IssueSourceFact[] = [];
    for (const fact of snapshot.issues) {
      const index = issueCatalogFact(fact);
      if (typeof fact.body === 'string' && fact.comments && fact.comments.length === fact.commentCount) {
        const { bodyHTML: _html, ...source } = fact;
        const canonical = { ...source, comments: fact.comments.map(({ bodyHTML: _rendered, ...c }) => c) };
        const version = hash(issueSourceContent(canonical));
        const folder = join(this.directory, this.key(snapshot.repo), String(fact.number));
        await mkdir(folder, { recursive: true, mode: 0o700 });
        const archived = { ...canonical, detailVersion: version, reviewVersion: hash(issueReviewContent(canonical)) };
        // Publish only a fully written archive. A crash cannot leave a partial immutable version.
        const temporary = join(folder, `${version}.${randomUUID()}.tmp`);
        await writeFile(temporary, await zip(JSON.stringify(archived)), { mode: 0o600, flag: 'wx' });
        try {
          await link(temporary, join(folder, `${version}.json.gz`));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        } finally {
          await unlink(temporary);
        }
        index.detailVersion = version;
        index.reviewVersion = archived.reviewVersion;
        index.detailCheckedAt = fact.fetchedAt ?? snapshot.fetchedAt;
      }
      issues.push(index);
    }
    const target = this.catalog(snapshot.repo);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ ...snapshot, issues }), { mode: 0o600 });
    if (!onlyIfMissing) await rename(temporary, target);
    else {
      // A concurrent refresh may already have published a newer index during migration.
      try {
        await link(temporary, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      } finally {
        await unlink(temporary);
      }
    }
  }
  async readDetail(repo: string, number: number, version?: string): Promise<IssueSourceFact | null> {
    if (!Number.isSafeInteger(number) || number < 1 || (version && !/^[a-f0-9]{64}$/.test(version)))
      throw new Error('Invalid source reference');
    const current = (await this.read(repo))?.issues.find((i) => i.number === number);
    const selected = version ?? current?.detailVersion;
    if (!selected) return null;
    try {
      const detail = JSON.parse(
        (
          await unzip(await readFile(join(this.directory, this.key(repo), String(number), `${selected}.json.gz`)))
        ).toString(),
      ) as IssueSourceFact;
      if (detail.number !== number || detail.detailVersion !== selected) throw new Error('Invalid source archive');
      return version ? detail : { ...detail, fetchedAt: current?.detailCheckedAt ?? detail.fetchedAt };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
}
