/** Builders for the beta.24 per-row action result shape (render 'rows'). */

import type {
  OperationActionResult,
  OperationRow,
  OperationRowAction,
  OperationRows,
} from '@clowder-ai/plugin-contract';

export interface RowsResultOptions {
  /** Shown by the Host when rows is empty. */
  readonly empty?: string;
  readonly label?: string;
  readonly targetValues?: Readonly<Record<string, string>>;
  readonly advance?: boolean;
}

/**
 * Builds an OperationActionResult with render 'rows'. The Host validates the
 * data against the manifest's row declarations of the same operation
 * (validateOperationRowsResult) and rejects the whole result fail-closed when a
 * row action references an undeclared or non-row ActionDef.
 */
export function rowsResult(rows: readonly OperationRow[], options: RowsResultOptions = {}): OperationActionResult {
  const data: OperationRows = {
    rows,
    ...(options.empty === undefined ? {} : { empty: options.empty }),
  };
  return {
    render: 'rows',
    data,
    ...(options.label === undefined ? {} : { label: options.label }),
    ...(options.targetValues === undefined ? {} : { targetValues: options.targetValues }),
    ...(options.advance === undefined ? {} : { advance: options.advance }),
  };
}

export interface OperationRowActionOptions {
  /** Defaults to the referenced ActionDef label when omitted. */
  readonly label?: string;
  /** Replaces the manifest-declared confirmation wording; never skips it. */
  readonly confirm?: string;
}

/** Builds one OperationRowAction referencing a render 'row' ActionDef of the same operation. */
export function operationRowAction(
  action: string,
  input: Readonly<Record<string, string | number | boolean>>,
  options: OperationRowActionOptions = {},
): OperationRowAction {
  return {
    action,
    input,
    ...(options.label === undefined ? {} : { label: options.label }),
    ...(options.confirm === undefined ? {} : { confirm: options.confirm }),
  };
}
