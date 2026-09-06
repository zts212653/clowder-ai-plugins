import type { DocxMaterializationRequest } from '@clowder-ai/plugin-contract/docx-materialization';
import { materializeDocx } from './materializer.js';
export { materializeDocx } from './materializer.js';
declare const self: DedicatedWorkerGlobalScope;

// The artifact can be imported for deterministic package tests without a browser.
// Execution in production is exclusively inside the Host-owned dedicated worker.
if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
  let used = false;
  self.onmessage = async (event: MessageEvent<DocxMaterializationRequest>) => {
    if (used) return;
    used = true;
    self.postMessage(await materializeDocx(event.data));
    self.close();
  };
}
