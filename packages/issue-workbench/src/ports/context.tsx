import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { createSourceClient, type WorkbenchHost } from './host';
const Context = createContext<ReturnType<typeof createSourceClient> | null>(null);
export function WorkbenchProvider({ host, children }: { host: WorkbenchHost; children: ReactNode }) {
  const client = useMemo(() => createSourceClient(host), [host]);
  return <Context.Provider value={client}>{children}</Context.Provider>;
}
export function useSourceClient() {
  const value = useContext(Context);
  if (!value) throw new Error('A WorkbenchHost is required');
  return value;
}
export function useConfirm() { return useSourceClient().confirm; }
