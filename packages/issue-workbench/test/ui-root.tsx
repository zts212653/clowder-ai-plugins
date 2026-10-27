import { createRoot as reactRoot, type Root, type RootOptions } from 'react-dom/client';
import type { ReactNode } from 'react';
import { WorkbenchProvider } from '../src/ports/context';
import { STORAGE_KEY } from '../src/ui/workbench-model';
import type { WorkbenchHost } from '../src/ports/host';
export function createRoot(container: Element | DocumentFragment, options?: RootOptions): Root {
  const root = reactRoot(container, options);
  const host: WorkbenchHost = { repo: 'zts212653/clowder-ai', dataScope: 'synthetic-test',
    storage: { getItem: () => localStorage.getItem(STORAGE_KEY), setItem: (_key, value) => localStorage.setItem(STORAGE_KEY,value) },
    request: (path, options) => globalThis.fetch(path, options), confirm: async () => true };
  return { ...root, render: (node: ReactNode) => root.render(<WorkbenchProvider host={host}>{node}</WorkbenchProvider>), unmount: () => root.unmount() };
}
