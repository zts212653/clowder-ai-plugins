import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  esbuild: { jsx: 'automatic' },
  build: { outDir: 'dist', target: 'chrome120' },
  plugins: [{
    name: 'genoffice-read-only-office',
    enforce: 'pre',
    resolveId(id) {
      if (id === 'genoffice-preview-archive') return fileURLToPath(new URL('../src/preview-archive.ts', import.meta.url)).replaceAll('\\', '/');
      if (/^node:(?:crypto|fs|stream\/promises|zlib)$/.test(id)) return '\0genoffice-desktop-write';
      return null;
    },
    load(id) {
      if (id !== '\0genoffice-desktop-write') return null;
      return 'function deny() { throw new Error("Desktop write APIs are unavailable in preview"); } export { deny as createWriteStream, deny as pipeline, deny as deflateSync }; export const randomUUID = () => crypto.randomUUID();';
    },
    transform(source, id) {
      if (id.endsWith('/docx-engine/src/zip-load.ts')) {
        const check = '  assertZipWithinLimits(zip)\n';
        if (!source.includes(check)) throw new Error('Frozen GenOffice DOCX archive loader changed');
        return "import { readPreviewArchive } from 'genoffice-preview-archive';\n" +
          source.replace(check, '  for (const [name, bytes] of await readPreviewArchive(zip.files)) zip.file(name, bytes)\n');
      }
      if (!id.endsWith('/pptx-engine/src/zip.ts')) return null;
      const nativeHash = "createHash('sha256').update(bytes).digest('hex')";
      const nativeText = "Buffer.from(bytes).toString('utf8')";
      const extractEntries = `const entries = new Map<string, Uint8Array>()
    const names = Object.keys(zip.files)
    for (const name of names) {
      const file = zip.files[name]
      if (file.dir) continue
      entries.set(name, await file.async('uint8array'))
    }`;
      if (!source.includes(nativeHash) || !source.includes(nativeText) || !source.includes(extractEntries)) {
        throw new Error('Frozen GenOffice PPTX browser bindings changed');
      }
      return source
        .replace("import { createHash } from 'node:crypto'", "import { readPreviewArchive } from 'genoffice-preview-archive'")
        .replace(extractEntries, 'const entries = await readPreviewArchive(zip.files)')
        .replace(nativeHash, "Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) => byte.toString(16).padStart(2, '0')).join('')")
        .replace(nativeText, "new TextDecoder().decode(bytes)");
    },
  }],
});
