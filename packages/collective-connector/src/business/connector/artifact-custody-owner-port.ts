import type {
  CollectiveArtifactCustodyTransfer,
  CollectiveCustodyPage,
  CollectiveCustodyPrepared,
  CollectiveCustodyReady,
} from '../contracts/index.js';

export type CollectiveCustodyOwnerOperation = 'prepareSource' | 'readPage' | 'stageTarget' | 'attestReady' | 'finalize';
/** Fresh endpoint authority returns canonical metadata only; it never exposes credentials to the owner. */
export interface CollectiveCustodyOwnerAuthority {
  authorize(operation: CollectiveCustodyOwnerOperation): Promise<CollectiveArtifactCustodyTransfer>;
}
/** The single Connector seam owns the complete content/review/modification transfer unit. */
export interface CollectiveArtifactCustodyTransferPort {
  prepareSource(
    transfer: CollectiveArtifactCustodyTransfer,
    authority: CollectiveCustodyOwnerAuthority,
  ): Promise<CollectiveCustodyPrepared>;
  readPage(
    transfer: CollectiveArtifactCustodyTransfer,
    index: number,
    authority: CollectiveCustodyOwnerAuthority,
  ): Promise<CollectiveCustodyPage>;
  stageTarget(
    transfer: CollectiveArtifactCustodyTransfer,
    page: CollectiveCustodyPage,
    authority: CollectiveCustodyOwnerAuthority,
  ): Promise<void>;
  attestReady(
    transfer: CollectiveArtifactCustodyTransfer,
    authority: CollectiveCustodyOwnerAuthority,
  ): Promise<CollectiveCustodyReady>;
  finalize(transfer: CollectiveArtifactCustodyTransfer, authority: CollectiveCustodyOwnerAuthority): Promise<void>;
}
