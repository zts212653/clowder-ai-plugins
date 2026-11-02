import { constants } from 'node:fs';
import { mkdir, realpath, lstat, open, writeFile, link, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Attachment, ImageBytes, Journal, HydratedJournal, Report, StoredAttachment, StoredReport } from './types.js';

/** CAS values contain references only. Bytes stay inside the Host-provisioned installation data root. */
export class AttachmentVault {
  constructor(private readonly dataPath: string, private readonly stageFile: (path: string, bytes: Buffer) => Promise<void> = (path, bytes) => writeFile(path, bytes, { flag: 'wx', mode: 0o600 })) {}
  async storeReport(report: Report): Promise<StoredReport> {
    const attachments: StoredAttachment[] = [];
    for (const image of report.attachments) {
      const normalized = await this.store(image);
      attachments.push({ ...normalized, ...(image.original ? { original: await this.store(image.original) } : {}) });
    }
    return { ...report, attachments };
  }
  async readReport(report: StoredReport): Promise<Report> {
    const attachments: Attachment[] = [];
    for (const item of report.attachments) {
      const { original, ...metadata } = item;
      attachments.push({ ...metadata, base64: (await this.bytes(item)).toString('base64'),
        ...(original ? { original: { ...original, base64: (await this.bytes(original)).toString('base64') } } : {}) });
    }
    return { ...report, attachments };
  }
  async hydrate(journal: Journal): Promise<HydratedJournal> { return { ...journal, report: await this.readReport(journal.report) }; }
  private async directory(): Promise<string> {
    await mkdir(resolve(this.dataPath), { recursive: true, mode: 0o700 });
    const root = await realpath(resolve(this.dataPath)); const directory = join(root, 'feedback-attachments');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if ((await lstat(directory)).isSymbolicLink() || await realpath(directory) !== directory) throw new Error('附件目录身份异常');
    return directory;
  }
  private async store(image: ImageBytes): Promise<Omit<ImageBytes, 'base64'>> {
    const metadata = { id: image.id, name: image.name, mime: image.mime, sha256: image.sha256 }; const bytes = Buffer.from(image.base64, 'base64');
    const directory = await this.directory(); const file = join(directory, image.sha256);
    try { await this.bytes(metadata); return metadata; }
    catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
    const staged = join(directory, `.pending-${randomUUID()}`);
    try {
      await this.stageFile(staged, bytes);
      const handle = await open(staged, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
      try {
        const actual = await handle.readFile();
        if (actual.length !== bytes.length || createHash('sha256').update(actual).digest('hex') !== image.sha256) throw new Error('附件暂存校验失败');
        await handle.sync();
      } finally { await handle.close(); }
      // Atomic no-replace installation; a concurrent identical writer may win, but no final object is overwritten.
      try { await link(staged, file); } catch (error) { if (!hasCode(error, 'EEXIST')) throw error; }
      await this.bytes(metadata);
    } finally {
      // This name is unreferenced transaction scratch; the committed hash object and all report data remain.
      await unlink(staged).catch(() => {});
    }
    return metadata;
  }
  private async bytes(image: Omit<ImageBytes, 'base64'>): Promise<Buffer> {
    if (!/^[a-f0-9]{64}$/.test(image.sha256) || image.id !== image.sha256) throw new Error('附件引用无效');
    const directory = await this.directory(); const file = join(directory, image.sha256);
    if ((await lstat(file)).isSymbolicLink() || await realpath(file) !== file) throw new Error('附件文件身份异常');
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await handle.stat(); if (!stat.isFile() || stat.size > 4_000_000) throw new Error('附件文件超限');
      const bytes = await handle.readFile();
      if (createHash('sha256').update(bytes).digest('hex') !== image.sha256) throw new Error('附件字节已变化，请重新检查');
      return bytes;
    } finally { await handle.close(); }
  }
}
function hasCode(error: unknown, code: string): boolean { return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code); }
