import type {PluginTaskReadItem} from './module-host.js';

export interface PluginTaskDataControllerBinding {
  readonly userId: string;
  readonly catId: string;
  readonly threadId: string;
  readonly subjectKey: string;
  readonly firstSourceRef: string;
  readonly admissionAuthorityRef: string;
  readonly pluginId: string;
  readonly pluginInstanceId: string;
  readonly moduleRef: string;
  readonly lifecycleRevision: number;
  readonly ownerOperationReceiptRef: string;
}

export interface PluginTaskDataControllerSummary {
  readonly bindingRevision: number;
  readonly state: 'active' | 'revoked';
  /** Live Host fence for this exact installation/lifecycle; not persisted authority. */
  readonly currentForCaller: boolean;
  readonly binding: PluginTaskDataControllerBinding;
  readonly revocationReceiptRef?: string;
}

export interface PluginTaskDataControllerBindInput {
  readonly taskId: string;
  readonly expectedTaskRevision: number;
  readonly operationId: string;
  readonly expected: {
    readonly ownerCatId: string;
    readonly threadId: string;
    readonly subjectKey: string;
    readonly firstSourceRef: string;
    readonly admissionAuthorityRef: string;
  };
}

export interface PluginTaskDataControllerRevokeInput {
  readonly taskId: string;
  readonly expectedTaskRevision: number;
  readonly expectedBindingRevision: number;
  readonly expectedControllerReceiptRef: string;
  readonly operationId: string;
}

export interface PluginTaskDataControllerMutationResult {
  readonly disposition: 'bound' | 'revoked' | 'replayed';
  readonly receiptRef: string;
  readonly bindingRevision: number;
  readonly task: PluginTaskReadItem;
}
