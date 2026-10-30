/** Deterministic local filtering. Images require human inspection; this is not an OCR guarantee. */
export function sanitize(text: string, roots: readonly string[] = []): string {
  let result = text.slice(0, 128_000);
  for (const root of [...roots].filter(Boolean).sort((a, b) => b.length - a.length)) {
    result = result.replace(new RegExp(escape(root), 'gi'), '[PROJECT]');
  }
  return result
    .replace(/-----BEGIN [^-\r\n]*(?:PRIVATE KEY|CERTIFICATE)-----[\s\S]*?-----END [^-\r\n]+-----/g, '[REDACTED]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, '[REDACTED]')
    .replace(/(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|authorization|cookie|[\w-]*(?:session|invocation)[\w-]*)["']?\s*[:=]\s*)(?!\[REDACTED\])["']?[^\s,"';&}\]]+["']?/gi, '$1[REDACTED]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]+)\b/g, '[REDACTED]')
    .replace(/https?:\/\/[^\s<>"']+/gi, raw => {
      try {
        const url = new URL(raw);
        url.username = ''; url.password = ''; url.search = ''; url.hash = '';
        if (!['github.com', 'api.github.com', 'gitlab.com', 'www.gitlab.com'].includes(url.hostname)) {
          return '[HOST]' + url.pathname.replace(/\/[\w.-]+(?=\/)/g, '/[PATH]');
        }
        return url.href;
      } catch { return '[URL]'; }
    })
    .replace(/[A-Z]:\\(?:Users|Documents and Settings)\\[^\\\s]+/gi, '[HOME]')
    .replace(/\/(?:Users|home)\/[^/\s]+/g, '[HOME]')
    .replace(/\b[A-Z]:[\\/][^\s<>"']+/gi, '[PATH]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[EMAIL]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[IP]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[ID]');
}

function escape(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
