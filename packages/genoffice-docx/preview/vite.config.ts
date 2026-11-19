import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  esbuild: { jsx: 'automatic' },
  build: { outDir: 'dist', target: 'chrome120' },
  plugins: [{
    name: 'genoffice-read-only-pptx',
    enforce: 'pre',
    resolveId(id) {
      if (/^node:(?:crypto|fs|stream\/promises|zlib)$/.test(id)) return '\0genoffice-desktop-write';
      return null;
    },
    load(id) {
      if (id !== '\0genoffice-desktop-write') return null;
      return 'function deny() { throw new Error("Desktop write APIs are unavailable in preview"); } export { deny as createWriteStream, deny as pipeline, deny as deflateSync }; export const randomUUID = () => crypto.randomUUID();';
    },
    transform(source, id) {
      if (!id.endsWith('/pptx-engine/src/zip.ts')) return null;
      const nativeHash = "createHash('sha256').update(bytes).digest('hex')";
      const nativeText = "Buffer.from(bytes).toString('utf8')";
      if (!source.includes(nativeHash) || !source.includes(nativeText)) {
        throw new Error('Frozen GenOffice PPTX browser bindings changed');
      }
      return source
        .replace("import { createHash } from 'node:crypto'", '')
        .replace(nativeHash, "Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) => byte.toString(16).padStart(2, '0')).join('')")
        .replace(nativeText, "new TextDecoder().decode(bytes)");
    },
  }],
});
