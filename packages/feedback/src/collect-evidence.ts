import { open, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

/** Recipe-owned collection: two recent files per explicit log root, at most
 * 128 KiB each. No recursion, client HOME, environment dump or configuration. */
export async function collectEvidence(root: string, now = Date.now(), projectRoot?: string) {
  const directory = await realpath(root);
  if (projectRoot) {
    const within = relative(await realpath(projectRoot), directory);
    if (within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) throw new Error('Project log directory is outside the selected project');
  }
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && /\.log$/.test(entry.name));
  const files = await Promise.all(entries.map(async entry => ({ path: join(directory, entry.name), info: await stat(join(directory, entry.name)) })));
  const records = await Promise.all(files.filter(file => file.info.mtimeMs >= now - 900_000)
    .sort((a, b) => b.info.mtimeMs - a.info.mtimeMs).slice(0, 2).map(async file => {
      const handle = await open(file.path, 'r');
      try {
        const size = Math.min(file.info.size, 131_072);
        const bytes = Buffer.alloc(size);
        await handle.read(bytes, 0, size, Math.max(0, file.info.size - size));
        return bytes.toString('utf8').split('\n').flatMap(line => {
          if (!line.trim()) return [];
          if (!line.trimStart().startsWith('{')) return /error|warn|fail|错误|失败/i.test(line) ? [line.slice(0, 1000)] : [];
          try {
            const row = JSON.parse(line) as { time?: number | string; level?: number; msg?: string; code?: string; err?: { code?: string; type?: string } };
            const time = typeof row.time === 'number' ? row.time : Date.parse(row.time ?? '');
            return time >= now - 900_000 && time <= now && Number(row.level) >= 40
              ? [JSON.stringify({ time: new Date(time).toISOString(), level: row.level, message: String(row.msg ?? '').slice(0, 1000), code: row.code ?? row.err?.code, errorType: row.err?.type })] : [];
          } catch { return []; } // Ignore incomplete or malformed JSON log records.
        });
      } finally { await handle.close(); }
    }));
  return records.flat().slice(-48).join('\n').slice(0, 32_000) || '时间窗内没有匹配日志；不代表没有发生错误。';
}
