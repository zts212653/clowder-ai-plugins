import { createHash } from 'node:crypto';
import { mkdir, readFile, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

const digest = (value) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class WorkspaceJobs {
  constructor(root) {
    this.root = root;
  }
  path(jobId) {
    if (!/^[a-f0-9]{64}$/.test(jobId)) throw new Error('INVALID_JOB_ID');
    return join(this.root, `${jobId}.json`);
  }
  async read(jobId) {
    const value = JSON.parse(await readFile(this.path(jobId), 'utf8'));
    // A process exit between persisting the attempt and obtaining its receipt is unknown.
    return value.state === 'submitting'
      ? { ...value, state: 'submission_unknown' }
      : value;
  }
  async write(value) {
    const target = this.path(value.jobId);
    const temp = `${target}.${process.pid}.tmp`;
    const file = await open(temp, 'wx', 0o600);
    try {
      await file.writeFile(`${JSON.stringify(value)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temp, target);
  }
  async locked(jobId, action) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const path = `${this.path(jobId)}.lock`;
    let file;
    try {
      file = await open(path, 'wx', 0o600);
    } catch (error) {
      if (error.code === 'EEXIST') throw new Error('JOB_BUSY');
      throw error;
    }
    try {
      return await action();
    } finally {
      await file.close();
      await rm(path, { force: true });
    }
  }
  async prepare(key, draft) {
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(key))
      throw new Error('INVALID_JOB_KEY');
    const jobId = digest(key),
      previewDigest = digest(draft);
    return this.locked(jobId, async () => {
      let previous;
      try {
        previous = await this.read(jobId);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (previous) {
        if (previous.state !== 'prepared') return previous;
        if (previous.digest === previewDigest) return previous;
      }
      const value = {
        jobId,
        digest: previewDigest,
        draft,
        state: 'prepared',
        preparedAt: new Date().toISOString(),
      };
      await this.write(value);
      return value;
    });
  }
  async submit(jobId, previewDigest, click) {
    return this.locked(jobId, async () => {
      const value = await this.read(jobId);
      if (value.digest !== previewDigest) throw new Error('PREVIEW_CHANGED');
      if (value.state !== 'prepared')
        throw new Error('ALREADY_ATTEMPTED: 核对作品列表，禁止自动重新提交。');
      // Persist the irreversible boundary before crossing the browser bridge.
      value.state = 'submitting';
      value.attemptedAt = new Date().toISOString();
      await this.write(value);
      try {
        const result = await click(value.draft);
        value.state = result.receipt ? 'submitted' : 'submission_unknown';
        value.result = result;
        await this.write(value);
        return value;
      } catch (error) {
        value.state = 'submission_unknown';
        value.error = error.message;
        await this.write(value);
        throw error;
      }
    });
  }
}
