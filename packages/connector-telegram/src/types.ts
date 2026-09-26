export type ConnectorLogMethod = (...args: readonly unknown[]) => void;

export interface ConnectorLogger {
  info: ConnectorLogMethod;
  warn: ConnectorLogMethod;
  error: ConnectorLogMethod;
}

interface RichBlockBase {
  readonly id: string;
  readonly v: 1;
}

export interface CardBlock extends RichBlockBase {
  readonly kind: 'card';
  readonly title: string;
  readonly bodyMarkdown?: string;
  readonly fields?: ReadonlyArray<{ readonly label: string; readonly value: string }>;
}

export interface ChecklistBlock extends RichBlockBase {
  readonly kind: 'checklist';
  readonly title?: string;
  readonly items: ReadonlyArray<{ readonly id: string; readonly checked?: boolean; readonly text: string }>;
}

export interface DiffBlock extends RichBlockBase {
  readonly kind: 'diff';
  readonly filePath: string;
  readonly diff: string;
}

export interface AudioBlock extends RichBlockBase {
  readonly kind: 'audio';
  readonly text?: string;
}

export interface MediaGalleryBlock extends RichBlockBase {
  readonly kind: 'media_gallery';
  readonly title?: string;
  readonly items: ReadonlyArray<{ readonly caption?: string; readonly alt?: string; readonly url: string }>;
}

export interface InteractiveBlock extends RichBlockBase {
  readonly kind: 'interactive';
}

export interface HtmlWidgetBlock extends RichBlockBase {
  readonly kind: 'html_widget';
}

export interface FileBlock extends RichBlockBase {
  readonly kind: 'file';
}

export type RichBlock =
  | CardBlock
  | ChecklistBlock
  | DiffBlock
  | AudioBlock
  | MediaGalleryBlock
  | InteractiveBlock
  | HtmlWidgetBlock
  | FileBlock;
