import { useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import type { Pane } from './useWorkbenchColumns';
import styles from './column-separator.module.css';

type Props = {
  pane: Pane; value: number; min: number; max: number; controls: string;
  change: (value: number, persist: boolean) => void;
  reset: () => void;
};

export function ColumnSeparator({ pane, value, min, max, controls, change, reset }: Props) {
  const drag = useRef<{ pointer: number; x: number; initial: number; current: number }>();
  const [active, setActive] = useState(false);
  const direction = pane === 'queue' ? 1 : -1;
  const clamp = (next: number) => Math.max(min, Math.min(max, next));
  function finish(event: PointerEvent<HTMLDivElement>, cancelled = false) {
    const current = drag.current;
    if (!current || event.pointerId !== current.pointer) return;
    drag.current = undefined;
    setActive(false);
    change(cancelled ? current.initial : current.current, !cancelled);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const step = event.shiftKey ? 50 : 20;
    const next = { ArrowLeft: value - direction * step, ArrowRight: value + direction * step, Home: min, End: max }[event.key];
    if (event.key === 'Enter') { event.preventDefault(); reset(); }
    else if (next !== undefined) { event.preventDefault(); change(clamp(next), true); }
  }
  return <div
    role="separator" tabIndex={0} aria-orientation="vertical"
    aria-label={pane === 'queue' ? '调整队列宽度' : '调整研判宽度'}
    aria-controls={controls} aria-valuemin={Math.round(min)} aria-valuemax={Math.round(max)}
    aria-valuenow={Math.round(value)} aria-valuetext={`${Math.round(value)} 像素`}
    title="拖动调整列宽；方向键微调；双击或 Enter 恢复默认"
    className={styles.separator} data-pane={pane} data-dragging={active || undefined}
    onDoubleClick={reset} onKeyDown={keyDown}
    onPointerDown={event => {
      if (event.button !== 0 || !event.isPrimary) return;
      event.preventDefault();
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { pointer: event.pointerId, x: event.clientX, initial: value, current: value };
      setActive(true);
    }}
    onPointerMove={event => {
      const current = drag.current;
      if (!current || event.pointerId !== current.pointer) return;
      current.current = clamp(current.initial + direction * (event.clientX - current.x));
      change(current.current, false);
    }}
    onPointerUp={event => finish(event)}
    onPointerCancel={event => finish(event, true)}
    onLostPointerCapture={event => finish(event, true)}
  />;
}
