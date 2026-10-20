/**
 * F22: Rich Blocks 富消息系统 — 类型定义
 *
 * 富块是派生的交互组件（card / diff / checklist / media_gallery），
 * 与 contentBlocks（LLM 原始输出）语义不同，存储在 extra.rich 中。
 */

// ── Block Kinds ─────────────────────────────────────────────

export type RichBlockKind =
  | 'card'
  | 'diff'
  | 'checklist'
  | 'media_gallery'
  | 'audio'
  | 'interactive'
  | 'html_widget'
  | 'file';

// ── Base ────────────────────────────────────────────────────

export interface RichBlockBase {
  /** Message-local stable id (e.g. "b1") */
  id: string;
  kind: RichBlockKind;
  /** Schema version — always 1 for now */
  v: 1;
}

// ── Concrete Blocks ─────────────────────────────────────────

/** F066 Phase 4: Card action button (e.g. "重新合成" on TTS failure cards) */
export interface CardAction {
  label: string;
  /** Action identifier — frontend dispatches based on this */
  action: string;
  /** Opaque payload for the action handler */
  payload?: Record<string, unknown>;
}

export interface RichCardBlock extends RichBlockBase {
  kind: 'card';
  title: string;
  bodyMarkdown?: string;
  tone?: 'info' | 'success' | 'warning' | 'danger';
  fields?: Array<{ label: string; value: string }>;
  /** F066 Phase 4: Optional action buttons displayed at the bottom of the card */
  actions?: CardAction[];
  /**
   * F174 D2b-1: opaque structured metadata for downstream renderers to detect
   * specialised card sub-kinds (e.g. `meta.kind: 'callback_auth_failure'` enables
   * the dedicated in-context observability renderer). Default cards leave it empty.
   */
  meta?: Record<string, unknown>;
}

